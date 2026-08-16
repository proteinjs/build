import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import semver from 'semver';
import { cmd } from '@proteinjs/util-node';
import { versionWorkspace } from '../src/versionWorkspace';
import { revertLeftoverVersionState } from '../src/mergeToMain';
import { FakeRegistry, makeFakeBuildAndTest, packageJsonFor } from './versionWorkspaceHarness';

/**
 * Registry-reconciled versioning harness. Hermetic fixtures (local git repos with bare
 * origins + an in-memory registry seam) stage the desync shapes from the 2026-08-12
 * release train and assert each self-heals in a SINGLE re-run of `versionWorkspace`:
 *
 *   1. bump-without-publish — an interrupted run left a bumped-but-never-published version in
 *      the working tree; the re-run must baseline from the registry, not the phantom local.
 *   2. publish-without-record — the registry holds a version the working tree never recorded
 *      (also the lineage shape: a sibling workspace's releases); the re-run must bump PAST
 *      the registry max instead of colliding with it.
 *   3. shadowed-by-higher-lineage — a sibling workspace published higher versions of a dep;
 *      the dependent's rewritten range must resolve to THIS run's release, not the sibling's.
 *   4. prior-run release unseen by the re-run — an interrupted run released an upstream and
 *      died before its dependents recorded rewritten ranges; the re-run's install must still
 *      resolve the released version, not a stale range's lockfile pin (attempt-13 shape).
 *
 * Plus the transient-bump contract: a version write only becomes durable (committed + pushed)
 * on registry acceptance; failures revert the working tree; a target already on the registry
 * is recorded without re-publishing (resume window).
 *
 * The fake buildAndTest seam MODELS INSTALLATION (see `makeFakeBuildAndTest`): dependency
 * ranges are read from the package.json ON DISK at install time and resolved against the fake
 * registry with npm's lockfile-pin semantics. Fixtures assert the RESOLVED versions — a
 * pipeline that lets an install read pre-rewrite ranges (or a stale-but-satisfying lock pin)
 * goes red here instead of on a live train.
 */

jest.setTimeout(120_000);

const quiet = { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } } as const;
const git = (cwd: string, ...args: string[]) => cmd('git', args, { cwd }, quiet);

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

  /**
   * A package dir that is its own git repo, pushed to a local bare origin (so `@{u}` resolves).
   * `lockPackages` stages committed lockfile resolution pins (`packages` entries) — the shape
   * the attempt-13 fixture uses to plant a stale-but-satisfying pin.
   */
  const initPackageRepo = async (
    dirName: string,
    packageJson: any,
    lockPackages?: Record<string, { version: string }>
  ): Promise<string> => {
    const dir = path.join(ws, 'packages', dirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
    await fs.writeFile(
      path.join(dir, 'package-lock.json'),
      JSON.stringify(
        { name: packageJson.name, version: packageJson.version, lockfileVersion: 3, packages: lockPackages ?? {} },
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

  const run = () =>
    versionWorkspace({ workspacePath: ws, seams: { registry: fake, buildAndTest: makeFakeBuildAndTest(fake) } });

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
    // And the dependent's install actually RESOLVED this run's release (the recorded lockfile
    // carries the resolution the build ran against).
    const lock = await headJson(spaceServer, 'package-lock.json');
    expect(lock.packages['node_modules/@test/chat-common'].version).toEqual('1.24.1');
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
    // The phase-0 scan (call 1) and the baseline read (call 2) see 1.4.0; by the pre-publish
    // check the prior attempt's acceptance of the computed target (1.4.1) has become visible.
    fake.versionsBehavior.set('@test/driver', (call, current) => (call <= 2 ? current : [...current, '1.4.1']));

    await run();

    expect(fake.publishEvents).toEqual([]);
    expect((await headJson(driver, 'package.json')).version).toEqual('1.4.1');
    expect(await isClean(driver)).toBe(true);
    expect(await originHead('driver')).toEqual(await localHead(driver));
    expect(await originTags('driver')).toContain('@test/driver@1.4.1');
  });

  it('attempt-10 shape: a pushed-but-shadowed lineage re-releases past the registry max', async () => {
    // The 2026-08-12 train, attempt 10 (train-release5.log), exactly: OUR lineage's content
    // and its release record at 1.22.1 (commit + tag) are fully PUSHED — history, not
    // working-tree residue. The registry also holds a sibling workspace's 1.23.0/1.24.0, and
    // the sibling's release records were merged into our history (merged local record
    // 1.24.0). Nothing is unpushed, so a branch-anchored scan reports "nothing to ship" and
    // the content stays shadowed forever: dependents' recorded ranges semver-resolve to the
    // sibling's pre-ops 1.24.0 and their builds die on missing exports, every re-run. The
    // release-anchored scan must see the commits since the registry-max release record and
    // re-release them PAST the sibling's max.
    const chatCommon = await initPackageRepo('chat-common', packageJsonFor('@test/chat-common', '1.22.0'));
    const baseSha = await localHead(chatCommon);
    // Ours: the ops content, then the old attempt's release record at 1.22.1 (commit + tag).
    await addUnpushedCommit(chatCommon, 'fix: ops permission guard');
    await fs.writeFile(
      path.join(chatCommon, 'package.json'),
      JSON.stringify(packageJsonFor('@test/chat-common', '1.22.1'), null, 2) + '\n'
    );
    await git(
      chatCommon,
      'commit',
      '-am',
      'chore(version): bumping dependency versions for @test/chat-common [skip ci]'
    );
    await git(chatCommon, 'tag', '-a', '@test/chat-common@1.22.1', '-m', 'Release @test/chat-common@1.22.1');
    // Sibling lineage: branched before the ops content, released 1.23.0 then 1.24.0
    // (records + tags) without ever carrying the ops changes.
    await git(chatCommon, 'checkout', '-b', 'sibling', baseSha);
    await fs.appendFile(path.join(chatCommon, 'src.txt'), 'conversation lineage\n');
    for (const siblingVersion of ['1.23.0', '1.24.0']) {
      await fs.writeFile(
        path.join(chatCommon, 'package.json'),
        JSON.stringify(packageJsonFor('@test/chat-common', siblingVersion), null, 2) + '\n'
      );
      await git(chatCommon, 'add', '.');
      await git(chatCommon, 'commit', '-m', 'chore(release): publish [skip ci]');
      await git(
        chatCommon,
        'tag',
        '-a',
        `@test/chat-common@${siblingVersion}`,
        '-m',
        `Release @test/chat-common@${siblingVersion}`
      );
    }
    // The lineage merge: the record resolves to the sibling's higher 1.24.0 while our ops
    // content SURVIVES in the tree (the real merge: "ops and conversation-lineage lines
    // coexist"). Everything — merge, records, tags — is pushed.
    await git(chatCommon, 'checkout', 'main');
    await git(chatCommon, 'merge', 'sibling', '-m', 'Merge sibling release lineage into main').catch(() => {
      /* both lineages touched package.json and src.txt — conflicts expected */
    });
    await fs.writeFile(
      path.join(chatCommon, 'package.json'),
      JSON.stringify(packageJsonFor('@test/chat-common', '1.24.0'), null, 2) + '\n'
    );
    await fs.writeFile(path.join(chatCommon, 'src.txt'), 'initial\nfix: ops permission guard\nconversation lineage\n');
    await git(chatCommon, 'add', '.');
    await git(chatCommon, 'commit', '-m', 'Merge sibling release lineage into main');
    await git(chatCommon, 'push', 'origin', 'main', '--tags');
    expect((await git(chatCommon, 'log', '@{u}..HEAD', '--oneline')).stdout.trim()).toEqual(''); // the shape: nothing unpushed
    // Registry in publish chronology: the sibling's releases landed before our shadowed
    // 1.22.1, so the numeric max sits mid-list.
    fake.seed('@test/chat-common', ['1.22.0', '1.23.0', '1.24.0', '1.22.1']);
    // Dependent with no changes of its own, cleanly released at 2.0.0 (tagged); its recorded
    // range is attempt 10's ^1.21.1, which resolves to the sibling's 1.24.0 until chat-common
    // re-releases past it.
    const spaceServer = await initPackageRepo(
      'space-server',
      packageJsonFor('@test/space-server', '2.0.0', { '@test/chat-common': '^1.21.1' })
    );
    await git(spaceServer, 'tag', '-a', '@test/space-server@2.0.0', '-m', 'Release @test/space-server@2.0.0');
    fake.seed('@test/space-server', ['2.0.0']);

    await run();

    // The pushed-but-shadowed content re-releases PAST the registry max.
    expect(fake.published('@test/chat-common')).toContain('1.24.1');
    expect((await headJson(chatCommon, 'package.json')).version).toEqual('1.24.1');
    expect(await isClean(chatCommon)).toBe(true);
    expect(await originHead('chat-common')).toEqual(await localHead(chatCommon));
    expect(await originTags('chat-common')).toContain('@test/chat-common@1.24.1');
    // The dependent's recorded range tracks THIS run's release and semver-resolves to it —
    // the shadow no longer wins.
    const range = (await headJson(spaceServer, 'package.json')).dependencies['@test/chat-common'];
    expect(range).toEqual('^1.24.1');
    expect(semver.maxSatisfying(fake.published('@test/chat-common'), range)).toEqual('1.24.1');
    expect(fake.published('@test/space-server')).toContain('2.0.1');
    const publishOrder = fake.publishEvents.map((e) => e.name);
    expect(publishOrder.indexOf('@test/chat-common')).toBeLessThan(publishOrder.indexOf('@test/space-server'));
  });

  it('attempt-13 shape: a release recorded by an interrupted run reaches dependents on the re-run — the install resolves it, never a stale range lockfile pin', async () => {
    // The 2026-08-12 train, attempts 12+13 (train-release5.log), exactly. Attempt 12 released
    // chat-common@1.25.0 past the sibling shadow (registry max 1.24.0, pre-ops content) and
    // RECORDED it (commit + tag pushed) — then died at a later package's publish step, and the
    // revert put that dependent's working tree back to the OLD attempt's state: range ^1.22.1,
    // committed lockfile pinning chat-common at the sibling's 1.24.0. Attempt 13 then had
    // nothing to ship for chat-common (released + recorded), so the run-scoped acceptedVersions
    // never carried 1.25.0: the rewrite left ^1.22.1 in place, the still-SATISFYING lock pin
    // bound `npm install` to the sibling's pre-ops 1.24.0, and space-common's build died on
    // missing exports. Durable acceptance lives on the REGISTRY, not in one run's memory: the
    // re-run must rewrite the dependent's floor to 1.25.0 — which also invalidates the lower
    // pin — so the install can only resolve this train's release.
    const chatCommon = await initPackageRepo('chat-common', packageJsonFor('@test/chat-common', '1.24.0'));
    await git(chatCommon, 'tag', '-a', '@test/chat-common@1.24.0', '-m', 'Release @test/chat-common@1.24.0');
    fake.seed('@test/chat-common', ['1.22.1', '1.23.0', '1.24.0']);
    await addUnpushedCommit(chatCommon, 'feat: ops exports');
    // Dependent: own unreleased change, stale recorded range from an old attempt, and that
    // attempt's committed lockfile pin at the sibling's pre-ops 1.24.0 (still satisfies ^1.22.1).
    const spaceCommon = await initPackageRepo(
      'space-common',
      packageJsonFor('@test/space-common', '1.14.0', { '@test/chat-common': '^1.22.1' }),
      { 'node_modules/@test/chat-common': { version: '1.24.0' } }
    );
    await git(spaceCommon, 'tag', '-a', '@test/space-common@1.14.0', '-m', 'Release @test/space-common@1.14.0');
    fake.seed('@test/space-common', ['1.14.0']);
    await addUnpushedCommit(spaceCommon, 'feat: case panel gates');
    // Attempt 12's death point: the dependent's publish fails once (the 403-flap class);
    // attempt 13's publish goes through.
    let spaceCommonPublishAttempts = 0;
    fake.publishBehavior.set('@test/space-common', (localPackage) => {
      spaceCommonPublishAttempts += 1;
      if (spaceCommonPublishAttempts === 1) {
        throw Object.assign(new Error('forbidden'), { stderr: 'npm ERR! code E403' });
      }
      fake.accept(localPackage.name, localPackage.packageJson.version);
      fake.publishEvents.push({ name: localPackage.name, version: localPackage.packageJson.version });
    });

    await expect(run()).rejects.toThrow();

    // Attempt 12 recorded the upstream release and reverted the dependent mid-flight — the
    // staged field state, reproduced by the flow itself rather than hand-written.
    expect(fake.published('@test/chat-common')).toContain('1.25.0');
    expect(await originTags('chat-common')).toContain('@test/chat-common@1.25.0');
    expect(await isClean(spaceCommon)).toBe(true);
    expect((await headJson(spaceCommon, 'package.json')).dependencies['@test/chat-common']).toEqual('^1.22.1');
    const revertedLock = await headJson(spaceCommon, 'package-lock.json');
    expect(revertedLock.packages['node_modules/@test/chat-common'].version).toEqual('1.24.0');

    // Attempt 13: chat-common has nothing to ship; the dependent must still build against 1.25.0.
    await run();

    // THE assertion: the dependent's install resolved the prior run's release, not the pin.
    const lock = await headJson(spaceCommon, 'package-lock.json');
    expect(lock.packages['node_modules/@test/chat-common'].version).toEqual('1.25.0');
    const range = (await headJson(spaceCommon, 'package.json')).dependencies['@test/chat-common'];
    expect(range).toEqual('^1.25.0');
    expect(fake.published('@test/space-common')).toContain('1.15.0');
    // Healing happens in the DEPENDENT's record — the upstream is not gratuitously re-released.
    expect(fake.published('@test/chat-common').sort(semver.compare).pop()).toEqual('1.25.0');
    expect(await isClean(spaceCommon)).toBe(true);
    expect(await originHead('space-common')).toEqual(await localHead(spaceCommon));
    expect(await originTags('space-common')).toContain('@test/space-common@1.15.0');
  });

  it('stale baseline: a target at-or-below the registry max is refused loudly, never recorded as a resume', async () => {
    // The reads feeding the target computation lie (empty version list — the shape of a
    // transient authenticated 404 reading as "never published"), so the computed target
    // lands on an OLD own version that still exists on the registry below the sibling max.
    // Membership alone then reads as "this run's publish landed earlier": pre-fix, the
    // resume window / publish-error acceptance check RECORDED the shadowed 1.22.1 as this
    // run's release and dependent rewrites tracked it. The invariant must fail the run
    // loudly instead, leaving nothing recorded.
    const chatCommon = await initPackageRepo('chat-common', packageJsonFor('@test/chat-common', '1.22.0'));
    await addUnpushedCommit(chatCommon, 'fix: ops permission guard');
    fake.seed('@test/chat-common', ['1.22.0', '1.23.0', '1.24.0', '1.22.1']);
    const headBefore = await localHead(chatCommon);
    // The phase-0 scan (call 1) and the baseline read (call 2) get the lie; the publish
    // pre-check (call 3) and everything after see registry truth.
    fake.versionsBehavior.set('@test/chat-common', (call, current) => (call <= 2 ? [] : current));

    await expect(run()).rejects.toThrow(/does not exceed the registry max/);

    // Nothing recorded: no publish, transient writes reverted, no record commit, no tag.
    expect(fake.publishEvents).toEqual([]);
    expect(await isClean(chatCommon)).toBe(true);
    expect((await headJson(chatCommon, 'package.json')).version).toEqual('1.22.0');
    expect(await localHead(chatCommon)).toEqual(headBefore);
    expect(await originTags('chat-common')).toEqual([]);
  });

  it('publish-error acceptance: a pre-check that saw no versions cannot launder an old own version via membership', async () => {
    // One read staler than the stale-baseline shape: the lie ([] — authenticated-404 shape)
    // persists through the publish PRE-CHECK read too, so the invariant assert at the top of
    // `publish` is vacuous (no other versions to exceed). The publish of the old own version
    // then fails EPUBLISHCONFLICT (it already exists), and the acceptance re-check — the first
    // read to see registry truth — finds the target in the list. Membership alone must NOT
    // read as "this run's publish landed": the acceptance path has to enforce the same
    // invariant on ITS OWN read, or the shadowed 1.22.1 gets recorded and dependent rewrites
    // track it (the attempt-10 laundering, one read later).
    const chatCommon = await initPackageRepo('chat-common', packageJsonFor('@test/chat-common', '1.22.0'));
    await addUnpushedCommit(chatCommon, 'fix: ops permission guard');
    fake.seed('@test/chat-common', ['1.22.0', '1.23.0', '1.24.0', '1.22.1']);
    const headBefore = await localHead(chatCommon);
    // Scan (call 1), baseline (call 2), AND publish pre-check (call 3) get the lie; the
    // acceptance re-check (call 4) sees truth.
    fake.versionsBehavior.set('@test/chat-common', (call, current) => (call <= 3 ? [] : current));

    await expect(run()).rejects.toThrow(/does not exceed the registry max/);

    // Nothing recorded: no publish event, transient writes reverted, no record commit, no tag.
    expect(fake.publishEvents).toEqual([]);
    expect(await isClean(chatCommon)).toBe(true);
    expect((await headJson(chatCommon, 'package.json')).version).toEqual('1.22.0');
    expect(await localHead(chatCommon)).toEqual(headBefore);
    expect(await originTags('chat-common')).toEqual([]);
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

describe('registry transient classification', () => {
  const { isNetworkError, retryOnNetworkError } = require('../src/PackageRegistry');
  it('treats GitHub Packages 403 flaps as retryable transients', () => {
    expect(
      isNetworkError({ stderr: 'npm error 403 403 Forbidden - GET https://npm.pkg.github.com/@n3xah%2fthought-common' })
    ).toBe(true);
    expect(isNetworkError({ stderr: 'npm error code E403' })).toBe(true);
  });
  it('does not retry plain not-found or validation failures', () => {
    expect(isNetworkError({ stderr: 'npm error code E404 Not Found' })).toBe(false);
    expect(isNetworkError({ stderr: 'npm error notarget No matching version found' })).toBe(false);
  });
  it('retry wrapper survives a transient and returns the wrapped call value (the metadata-GET path)', async () => {
    let calls = 0;
    const result = await retryOnNetworkError(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error('flap'), { stderr: 'npm error 403 403 Forbidden - GET' });
        }
        return { stdout: '["1.25.0"]' };
      },
      'test',
      3,
      1
    );
    expect(result).toEqual({ stdout: '["1.25.0"]' });
    expect(calls).toBe(2);
  });
  it('retry wrapper rethrows non-transient failures immediately', async () => {
    let calls = 0;
    await expect(
      retryOnNetworkError(
        async () => {
          calls += 1;
          throw Object.assign(new Error('not found'), { stderr: 'npm error code E404' });
        },
        'test',
        3,
        1
      )
    ).rejects.toThrow('not found');
    expect(calls).toBe(1);
  });
});
