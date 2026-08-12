import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import semver from 'semver';
import { cmd, LocalPackage } from '@proteinjs/util-node';
import { versionWorkspace } from '../src/versionWorkspace';
import { PackageRegistry } from '../src/PackageRegistry';
import { revertLeftoverVersionState } from '../src/mergeToMain';

/**
 * Registry-reconciled versioning harness. Hermetic fixtures (local git repos with bare
 * origins + an in-memory registry seam) stage the three desync shapes from the 2026-08-12
 * release train and assert each self-heals in a SINGLE re-run of `versionWorkspace`:
 *
 *   1. bump-without-publish — an interrupted run left a bumped-but-never-published version in
 *      the working tree; the re-run must baseline from the registry, not the phantom local.
 *   2. publish-without-record — the registry holds a version the working tree never recorded
 *      (also the lineage shape: a sibling workspace's releases); the re-run must bump PAST
 *      the registry max instead of colliding with it.
 *   3. shadowed-by-higher-lineage — a sibling workspace published higher versions of a dep;
 *      the dependent's rewritten range must resolve to THIS run's release, not the sibling's.
 *
 * Plus the transient-bump contract: a version write only becomes durable (committed + pushed)
 * on registry acceptance; failures revert the working tree; a target already on the registry
 * is recorded without re-publishing (resume window).
 */

jest.setTimeout(120_000);

const quiet = { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } } as const;
const git = (cwd: string, ...args: string[]) => cmd('git', args, { cwd }, quiet);

type PublishEvent = { name: string; version: string };

class FakeRegistry implements PackageRegistry {
  publishEvents: PublishEvent[] = [];
  /** Override what `getPublishedVersions` reports, by package and 1-indexed call number. */
  versionsBehavior = new Map<string, (call: number, current: string[]) => string[]>();
  /** Override publish handling per package (e.g. accept-then-throw, reject outright). */
  publishBehavior = new Map<string, (localPackage: LocalPackage) => Promise<void> | void>();
  private versions = new Map<string, string[]>();
  private versionsCallCounts = new Map<string, number>();

  seed(name: string, versions: string[]) {
    this.versions.set(name, [...versions]);
  }

  published(name: string): string[] {
    return [...(this.versions.get(name) ?? [])];
  }

  accept(name: string, version: string) {
    const list = this.versions.get(name) ?? [];
    list.push(version);
    this.versions.set(name, list);
  }

  async getPublishedVersions(localPackage: LocalPackage): Promise<string[]> {
    const call = (this.versionsCallCounts.get(localPackage.name) ?? 0) + 1;
    this.versionsCallCounts.set(localPackage.name, call);
    const current = this.published(localPackage.name);
    const behavior = this.versionsBehavior.get(localPackage.name);
    return behavior ? behavior(call, current) : current;
  }

  async publish(localPackage: LocalPackage): Promise<void> {
    const version = localPackage.packageJson.version;
    if (this.published(localPackage.name).includes(version)) {
      throw Object.assign(new Error(`cannot publish over previously published version ${version}`), {
        stderr: 'npm ERR! code EPUBLISHCONFLICT',
      });
    }
    const behavior = this.publishBehavior.get(localPackage.name);
    if (behavior) {
      await behavior(localPackage);
      return;
    }
    this.accept(localPackage.name, version);
    this.publishEvents.push({ name: localPackage.name, version });
  }
}

/** Stand-in for clean/install/build/test: regenerate the lockfile the way `npm install` does. */
const fakeBuildAndTest = async (localPackage: LocalPackage) => {
  const packageDir = path.dirname(localPackage.filePath);
  await fs.writeFile(
    path.join(packageDir, 'package-lock.json'),
    JSON.stringify(
      {
        name: localPackage.name,
        version: localPackage.packageJson.version,
        lockfileVersion: 3,
        dependencies: localPackage.packageJson.dependencies ?? {},
      },
      null,
      2
    ) + '\n'
  );
};

const packageJsonFor = (name: string, version: string, dependencies?: Record<string, string>) => ({
  name,
  version,
  scripts: { clean: 'true', build: 'true' },
  publishConfig: { registry: 'http://fake-registry.invalid/' },
  ...(dependencies ? { dependencies } : {}),
});

describe('versionWorkspace registry reconciliation', () => {
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
  ];

  beforeEach(async () => {
    for (const name of modeEnvVars) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-reconcile-test-'));
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

  /** A package dir that is its own git repo, pushed to a local bare origin (so `@{u}` resolves). */
  const initPackageRepo = async (dirName: string, packageJson: any): Promise<string> => {
    const dir = path.join(ws, 'packages', dirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
    await fs.writeFile(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({ name: packageJson.name, version: packageJson.version, lockfileVersion: 3 }, null, 2) + '\n'
    );
    await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
    await fs.writeFile(path.join(dir, 'src.txt'), 'initial\n');
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.email', 'test@test.test');
    await git(dir, 'config', 'user.name', 'test');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', `chore: init ${packageJson.name}`);
    const origin = path.join(originsDir, `${dirName}.git`);
    await fs.mkdir(origin, { recursive: true });
    await git(origin, 'init', '--bare', '-b', 'main');
    await git(dir, 'remote', 'add', 'origin', origin);
    await git(dir, 'push', '-u', 'origin', 'main');
    return dir;
  };

  const addUnpushedCommit = async (dir: string, message: string) => {
    await fs.appendFile(path.join(dir, 'src.txt'), `${message}\n`);
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', message);
  };

  const run = () => versionWorkspace({ workspacePath: ws, seams: { registry: fake, buildAndTest: fakeBuildAndTest } });

  const headJson = async (dir: string, file: string) => JSON.parse((await git(dir, 'show', `HEAD:${file}`)).stdout);
  const isClean = async (dir: string) => (await git(dir, 'status', '--porcelain')).stdout.trim() === '';
  const localHead = async (dir: string) => (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  const originHead = async (dirName: string) =>
    (await git(path.join(originsDir, `${dirName}.git`), 'rev-parse', 'HEAD')).stdout.trim();
  const originTags = async (dirName: string) =>
    (await git(path.join(originsDir, `${dirName}.git`), 'tag')).stdout.split('\n').filter(Boolean);

  it('bump-without-publish: re-run baselines from the registry, not the phantom local version', async () => {
    // Recorded+pushed at 1.4.0; registry agrees 1.4.0 is the max.
    const driver = await initPackageRepo('driver', packageJsonFor('@test/driver', '1.4.0'));
    fake.seed('@test/driver', ['1.3.0', '1.4.0']);
    // The change that wants to release.
    await addUnpushedCommit(driver, 'fix: correct retry logic');
    // Crash residue of the prior interrupted run: version bumped on disk, publish never happened.
    const leftover = packageJsonFor('@test/driver', '1.5.0');
    await fs.writeFile(path.join(driver, 'package.json'), JSON.stringify(leftover, null, 2) + '\n');

    await run();

    // Healed release comes off the REGISTRY baseline (1.4.0 -> 1.4.1); the phantom 1.5.0 lineage dies.
    expect(fake.published('@test/driver')).toContain('1.4.1');
    expect(fake.published('@test/driver').filter((v) => semver.gte(v, '1.5.0'))).toEqual([]);
    expect((await headJson(driver, 'package.json')).version).toEqual('1.4.1');
    expect((await headJson(driver, 'package-lock.json')).version).toEqual('1.4.1');
    expect(await isClean(driver)).toBe(true);
    expect(await originHead('driver')).toEqual(await localHead(driver));
    expect(await originTags('driver')).toContain('@test/driver@1.4.1');
  });

  it('publish-without-record: re-run bumps past the registry max instead of colliding with it', async () => {
    // Recorded+pushed at 1.24.0, but the registry already holds 1.25.0 (accepted by a run that
    // died before recording — same shape as a sibling lineage's release).
    const chatUi = await initPackageRepo('chat-ui', packageJsonFor('@test/chat-ui', '1.24.0'));
    fake.seed('@test/chat-ui', ['1.24.0', '1.25.0']);
    await addUnpushedCommit(chatUi, 'feat: composer attachments');

    await run();

    // minor over the registry max (1.25.0), NOT over the recorded local (which would collide).
    expect(fake.published('@test/chat-ui').sort(semver.compare)).toEqual(['1.24.0', '1.25.0', '1.26.0']);
    expect((await headJson(chatUi, 'package.json')).version).toEqual('1.26.0');
    expect(await isClean(chatUi)).toBe(true);
    expect(await originHead('chat-ui')).toEqual(await localHead(chatUi));
  });

  it('lineage collision: dependent ranges resolve to this run release, not the sibling shadow', async () => {
    // Our lineage recorded 1.22.0; a sibling workspace's releases pushed the registry to 1.24.0,
    // and our shadowed 1.22.1 landed chronologically LAST — so the versions list (publish order,
    // what the `latest` dist-tag tracks) ends below the numeric max. The baseline must be the
    // numeric max across the full list, never the latest/last entry (2026-08-12 train shape).
    const chatCommon = await initPackageRepo('chat-common', packageJsonFor('@test/chat-common', '1.22.0'));
    fake.seed('@test/chat-common', ['1.22.0', '1.23.0', '1.24.0', '1.22.1']);
    await addUnpushedCommit(chatCommon, 'fix: ops permission guard');
    // Dependent with no changes of its own — pure cascade.
    const spaceServer = await initPackageRepo(
      'space-server',
      packageJsonFor('@test/space-server', '2.0.0', { '@test/chat-common': '^1.22.0' })
    );
    fake.seed('@test/space-server', ['2.0.0']);

    await run();

    // chat-common releases PAST the sibling lineage, carrying this run's content.
    expect(fake.published('@test/chat-common')).toContain('1.24.1');
    // The dependent's recorded range resolves to this run's release — the shadow no longer wins.
    const range = (await headJson(spaceServer, 'package.json')).dependencies['@test/chat-common'];
    expect(range).toEqual('^1.24.1');
    expect(semver.maxSatisfying(fake.published('@test/chat-common'), range)).toEqual('1.24.1');
    // The cascade released the dependent too, in dependency order.
    expect(fake.published('@test/space-server')).toContain('2.0.1');
    expect((await headJson(spaceServer, 'package.json')).version).toEqual('2.0.1');
    const publishOrder = fake.publishEvents.map((e) => e.name);
    expect(publishOrder.indexOf('@test/chat-common')).toBeLessThan(publishOrder.indexOf('@test/space-server'));
    expect(await isClean(chatCommon)).toBe(true);
    expect(await isClean(spaceServer)).toBe(true);
  });

  it('resume window: a computed target already on the registry is recorded without re-publishing', async () => {
    const driver = await initPackageRepo('driver', packageJsonFor('@test/driver', '1.4.0'));
    fake.seed('@test/driver', ['1.4.0']);
    await addUnpushedCommit(driver, 'fix: correct retry logic');
    // Baseline read sees 1.4.0; by the pre-publish check the prior attempt's acceptance of the
    // computed target (1.4.1) has become visible.
    fake.versionsBehavior.set('@test/driver', (call, current) => (call === 1 ? current : [...current, '1.4.1']));

    await run();

    expect(fake.publishEvents).toEqual([]);
    expect((await headJson(driver, 'package.json')).version).toEqual('1.4.1');
    expect(await isClean(driver)).toBe(true);
    expect(await originHead('driver')).toEqual(await localHead(driver));
    expect(await originTags('driver')).toContain('@test/driver@1.4.1');
  });

  it('ambiguous publish failure: registry acceptance wins over the client error', async () => {
    const driver = await initPackageRepo('driver', packageJsonFor('@test/driver', '1.4.0'));
    fake.seed('@test/driver', ['1.4.0']);
    await addUnpushedCommit(driver, 'fix: correct retry logic');
    // npm accepted the publish but the client saw a network error.
    fake.publishBehavior.set('@test/driver', (localPackage) => {
      fake.accept(localPackage.name, localPackage.packageJson.version);
      fake.publishEvents.push({ name: localPackage.name, version: localPackage.packageJson.version });
      throw Object.assign(new Error('socket hang up'), { stderr: 'npm ERR! network ECONNRESET' });
    });

    await run();

    expect(fake.published('@test/driver')).toContain('1.4.1');
    expect((await headJson(driver, 'package.json')).version).toEqual('1.4.1');
    expect(await isClean(driver)).toBe(true);
    expect(await originHead('driver')).toEqual(await localHead(driver));
  });

  it('hard publish failure: the transient version write is reverted, nothing is recorded', async () => {
    const driver = await initPackageRepo('driver', packageJsonFor('@test/driver', '1.4.0'));
    fake.seed('@test/driver', ['1.4.0']);
    await addUnpushedCommit(driver, 'fix: correct retry logic');
    const headBefore = await localHead(driver);
    fake.publishBehavior.set('@test/driver', () => {
      throw Object.assign(new Error('forbidden'), { stderr: 'npm ERR! code E403' });
    });

    await expect(run()).rejects.toThrow();

    // Registry unchanged; the transient write (package.json bump + lockfile churn) is reverted,
    // so the working tree is back to committed truth and a re-run recomputes from the registry.
    expect(fake.published('@test/driver')).toEqual(['1.4.0']);
    expect(await isClean(driver)).toBe(true);
    expect((await headJson(driver, 'package.json')).version).toEqual('1.4.0');
    expect(await localHead(driver)).toEqual(headBefore);
    expect(await originTags('driver')).toEqual([]);
  });

  it('release-mode leftover sweep: crash residue reverts to HEAD, in-flight new packages survive', async () => {
    const driver = await initPackageRepo('driver', packageJsonFor('@test/driver', '1.4.0'));
    // Crash residue: an interrupted run's transient writes — one left unstaged, one staged
    // (killed between `git add` and `git commit`).
    await fs.writeFile(
      path.join(driver, 'package.json'),
      JSON.stringify(packageJsonFor('@test/driver', '1.5.0'), null, 2) + '\n'
    );
    await fs.writeFile(path.join(driver, 'package-lock.json'), '{"lockfileVersion":3,"residue":true}\n');
    await git(driver, 'add', 'package-lock.json');
    // Not residue: someone's in-flight new package (untracked package.json).
    await fs.mkdir(path.join(driver, 'extras'), { recursive: true });
    await fs.writeFile(path.join(driver, 'extras', 'package.json'), '{"name":"@test/extras","version":"0.0.1"}\n');

    await revertLeftoverVersionState(ws);

    expect(JSON.parse(await fs.readFile(path.join(driver, 'package.json'), 'utf-8')).version).toEqual('1.4.0');
    expect(await fs.readFile(path.join(driver, 'package-lock.json'), 'utf-8')).not.toContain('residue');
    // The staged copy was swept too (index restored from HEAD, not just the working tree).
    expect((await git(driver, 'diff', '--cached', '--name-only')).stdout.trim()).toEqual('');
    const untouched = await fs.readFile(path.join(driver, 'extras', 'package.json'), 'utf-8');
    expect(JSON.parse(untouched).name).toEqual('@test/extras');
  });
});
