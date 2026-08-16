import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import semver from 'semver';
import { cmd } from '@proteinjs/util-node';
import { versionWorkspace } from '../src/versionWorkspace';
import { FakeRegistry, makeFakeBuildAndTest, packageJsonFor } from './versionWorkspaceHarness';

/**
 * CI publish mode (`version-workspace --ci` / VERSION_WORKSPACE_CI) — registry-reconciled
 * baselines for the CI release flow (metarepo issue #24, the 3.27.0 race class).
 *
 * The class: a repo's CI publish computes its version baseline from the CHECKOUT (package.json,
 * lockfile, local tags — lerna's brain), while concurrent releases (a sibling workspace's train,
 * an overlapping CI run whose record landed after this checkout was cut) advance the REGISTRY
 * past it. The stale baseline then mints a version at-or-below the registry max — a SHADOWED
 * release whose dependents' caret ranges semver-resolve to the other lineage's content, so the
 * newer code never ships.
 *
 * CI mode runs the SAME reconciliation the local train runs (baseline = registry max at publish
 * time, release invariant, resume window, publish-confirmed recording), in CI's context:
 *
 *   - everything is PUSHED (the push event IS pushed commits), so change detection can never
 *     lean on the unpushed scan — anchors are release tags, with CI-specific fallbacks
 *     (highest local release tag under registry-ahead drift; full path-scoped history for a
 *     never-published package);
 *   - the checkout is the workflow's pinned tip (guarded upstream by publish.yml's
 *     stale-checkout abort) — CI mode NEVER pulls, because fast-forwarding past the pinned
 *     tip would re-open the stale-dist-under-newer-tag race the guard exists to close;
 *   - local-train tail phases (metarepo pointer pushes, workspace symlink refresh) are
 *     workstation concerns and don't run.
 */

jest.setTimeout(120_000);

const quiet = { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } } as const;
const git = (cwd: string, ...args: string[]) => cmd('git', args, { cwd }, quiet);

describe('versionWorkspace CI publish mode', () => {
  let tmp: string;
  let ws: string;
  let originsDir: string;
  let fake: FakeRegistry;
  const savedEnv: Record<string, string | undefined> = {};
  const modeEnvVars = [
    'VERSION_WORKSPACE_DRY_RUN',
    'DRY_RUN',
    'VERSION_WORKSPACE_PLAN_ONLY',
    'PLAN_ONLY',
    'VERSION_WORKSPACE_SKIP',
    'VERSION_WORKSPACE_MERGE_TO_MAIN',
    'VERSION_WORKSPACE_CI',
  ];

  beforeEach(async () => {
    for (const name of modeEnvVars) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    process.env.VERSION_WORKSPACE_CI = '1';
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-ci-test-'));
    ws = path.join(tmp, 'workspace');
    originsDir = path.join(tmp, 'origins');
    await fs.mkdir(ws, { recursive: true });
    await fs.mkdir(originsDir, { recursive: true });
    await fs.writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'root', version: '0.0.1', private: true }, null, 2) + '\n'
    );
    fake = new FakeRegistry();
  });

  afterEach(async () => {
    for (const name of modeEnvVars) {
      if (savedEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = savedEnv[name];
      }
    }
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /**
   * A package dir that is its own git repo pushed to a local bare origin — with NOTHING left
   * unpushed (the CI shape: the workflow runs on a push event, so HEAD == @{u} always).
   * `releaseTag` stamps `<name>@<version>` on the init commit — the durable release record
   * every release flow pushes.
   */
  const initCiPackageRepo = async (
    dirName: string,
    packageJson: any,
    { releaseTag }: { releaseTag?: string } = {}
  ): Promise<string> => {
    const dir = path.join(ws, 'packages', dirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
    await fs.writeFile(
      path.join(dir, 'package-lock.json'),
      JSON.stringify(
        { name: packageJson.name, version: packageJson.version, lockfileVersion: 3, packages: {} },
        null,
        2
      ) + '\n'
    );
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
    await fs.writeFile(path.join(dir, 'src.txt'), 'initial\n');
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.email', 'test@test.test');
    await git(dir, 'config', 'user.name', 'test');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', `chore: init ${packageJson.name}`);
    if (releaseTag) {
      await git(dir, 'tag', '-a', releaseTag, '-m', `Release ${releaseTag}`);
    }
    const origin = path.join(originsDir, `${dirName}.git`);
    await fs.mkdir(origin, { recursive: true });
    await git(origin, 'init', '--bare', '-b', 'main');
    await git(dir, 'remote', 'add', 'origin', origin);
    await git(dir, 'push', '-u', 'origin', 'main', '--tags');
    return dir;
  };

  /** A commit that is already pushed — the only kind a CI checkout ever sees. */
  const addPushedCommit = async (dir: string, message: string) => {
    await fs.appendFile(path.join(dir, 'src.txt'), `${message}\n`);
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', message);
    await git(dir, 'push');
  };

  const run = () =>
    versionWorkspace({ workspacePath: ws, seams: { registry: fake, buildAndTest: makeFakeBuildAndTest(fake) } });

  const headJson = async (dir: string, file: string) => JSON.parse((await git(dir, 'show', `HEAD:${file}`)).stdout);
  const isClean = async (dir: string) => (await git(dir, 'status', '--porcelain')).stdout.trim() === '';
  const localHead = async (dir: string) => (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  const originHead = async (dirName: string) =>
    (await git(path.join(originsDir, `${dirName}.git`), 'rev-parse', 'HEAD')).stdout.trim();
  const originTags = async (dirName: string) =>
    (await git(path.join(originsDir, `${dirName}.git`), 'tag')).stdout.split('\n').filter(Boolean);

  it('steady state: a pushed change releases patch over the registry max, tag-anchored', async () => {
    const tc = await initCiPackageRepo('thought-common', packageJsonFor('@test/thought-common', '3.26.0'), {
      releaseTag: '@test/thought-common@3.26.0',
    });
    fake.seed('@test/thought-common', ['3.25.0', '3.26.0']);
    await addPushedCommit(tc, 'fix: retry transient DML');
    expect((await git(tc, 'log', '@{u}..HEAD', '--oneline')).stdout.trim()).toEqual(''); // CI shape: nothing unpushed

    await run();

    expect(fake.published('@test/thought-common')).toContain('3.26.1');
    expect((await headJson(tc, 'package.json')).version).toEqual('3.26.1');
    expect(await isClean(tc)).toBe(true);
    expect(await originHead('thought-common')).toEqual(await localHead(tc));
    expect(await originTags('thought-common')).toContain('@test/thought-common@3.26.1');
  });

  it('the 3.27.0 race: a registry that advanced past the checkout re-baselines the release ABOVE the foreign lineage, and dependents follow', async () => {
    // The checkout records 3.26.0 (package.json, lockfile, its own release tag). A concurrent
    // release — a sibling workspace's train, or an overlapping CI run whose record landed after
    // this checkout was cut — already pushed the registry to 3.27.0; no record of it exists in
    // this history. A checkout-baselined publish (lerna's brain) mints 3.26.1: a SHADOWED
    // release that dependents' caret ranges never resolve to.
    //
    // The history carries a `feat` RELEASED under 3.26.0 and a `fix` after it: the change scan
    // must anchor on this history's own latest release record (only the fix is unreleased →
    // patch → 3.27.1). An unanchored full-history scan would count the released feat too and
    // mint a minor (3.28.0) whose content-to-version claim is wrong.
    const tc = await initCiPackageRepo('thought-common', packageJsonFor('@test/thought-common', '3.26.0'));
    await addPushedCommit(tc, 'feat: editor surface (released under 3.26.0)');
    await git(tc, 'tag', '-a', '@test/thought-common@3.26.0', '-m', 'Release @test/thought-common@3.26.0');
    await git(tc, 'push', 'origin', 'main', '--tags');
    fake.seed('@test/thought-common', ['3.26.0', '3.27.0']);
    await addPushedCommit(tc, 'fix: retry transient DML');

    // Dependent in the same repo with no changes of its own — pure cascade.
    const fs2 = await initCiPackageRepo(
      'flow-server',
      packageJsonFor('@test/flow-server', '1.0.0', { '@test/thought-common': '^3.26.0' }),
      { releaseTag: '@test/flow-server@1.0.0' }
    );
    fake.seed('@test/flow-server', ['1.0.0']);

    await run();

    // Released PAST the foreign lineage — never a shadow under it — at the ANCHORED bump
    // level (patch: only the fix is unreleased; the feat already shipped under 3.26.0).
    expect(fake.published('@test/thought-common')).toContain('3.27.1');
    expect(fake.published('@test/thought-common')).not.toContain('3.26.1');
    expect(fake.published('@test/thought-common')).not.toContain('3.28.0');
    expect((await headJson(tc, 'package.json')).version).toEqual('3.27.1');
    expect(await originTags('thought-common')).toContain('@test/thought-common@3.27.1');

    // The dependent's recorded range resolves to THIS run's release, and its recorded lockfile
    // carries that resolution (the local/lock assumption is dead in the record too).
    const range = (await headJson(fs2, 'package.json')).dependencies['@test/thought-common'];
    expect(range).toEqual('^3.27.1');
    expect(semver.maxSatisfying(fake.published('@test/thought-common'), range)).toEqual('3.27.1');
    const lock = await headJson(fs2, 'package-lock.json');
    expect(lock.packages['node_modules/@test/thought-common'].version).toEqual('3.27.1');
    expect(fake.published('@test/flow-server')).toContain('1.0.1');
    const publishOrder = fake.publishEvents.map((e) => e.name);
    expect(publishOrder.indexOf('@test/thought-common')).toBeLessThan(publishOrder.indexOf('@test/flow-server'));
    expect(await isClean(tc)).toBe(true);
    expect(await isClean(fs2)).toBe(true);
  });

  it('never pulls: the workflow-pinned checkout stays put even when origin is ahead', async () => {
    // The stale-checkout guard upstream of vw decides whether this run publishes at all; vw
    // fast-forwarding the tree itself would rebuild nothing (dist was built from the pinned
    // checkout) and re-open the stale-dist-under-newer-tag race.
    const tc = await initCiPackageRepo('thought-common', packageJsonFor('@test/thought-common', '3.26.0'), {
      releaseTag: '@test/thought-common@3.26.0',
    });
    fake.seed('@test/thought-common', ['3.26.0']);
    // Advance origin past the checkout, then pin the checkout back — the raced shape.
    await addPushedCommit(tc, 'fix: someone elses commit');
    const pinnedSha = (await git(tc, 'rev-parse', 'HEAD~1')).stdout.trim();
    await git(tc, 'reset', '--hard', pinnedSha);

    await run();

    expect(await localHead(tc)).toEqual(pinnedSha);
    expect(fake.publishEvents).toEqual([]);
  });

  it('first publish: a never-published package classifies its full path-scoped history', async () => {
    // In CI nothing is ever unpushed, so the local-mode never-published fallback (the unpushed
    // scan) is structurally empty — every commit touching the package IS unreleased content.
    const np = await initCiPackageRepo('new-package', packageJsonFor('@test/new-package', '0.1.0'));
    await addPushedCommit(np, 'feat: initial editor surface');

    await run();

    expect(fake.published('@test/new-package')).toContain('0.2.0');
    expect((await headJson(np, 'package.json')).version).toEqual('0.2.0');
    expect(await originTags('new-package')).toContain('@test/new-package@0.2.0');
  });
});
