import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { cmd } from '@proteinjs/util-node';
import { pullForwardWorkspace } from '../src/pullForward';

/**
 * Hermetic git fixtures (no registry, no network): an origin repo and a workspace checkout wired
 * the way the metarepo is — submodule under packages/ on branch main. Each upstream relationship
 * pull-forward classifies is staged for real (behind, diverged, detached, broken remote), and the
 * manifest-install pass is exercised with a file: tarball dependency so npm materializes
 * node_modules without touching the registry.
 */

// Hermetic-git suites in this package spawn dozens of git processes and run under shared jest
// workers; the manifest-install test additionally runs real npm installs.
jest.setTimeout(120_000);

const git = (cwd: string, ...args: string[]) =>
  cmd('git', args, { cwd }, { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } });

const initRepo = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@test.test');
  await git(dir, 'config', 'user.name', 'test');
};

const commitFile = async (repo: string, file: string, content: string, message: string) => {
  await fs.writeFile(path.join(repo, file), content);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', message);
};

describe('pullForwardWorkspace', () => {
  let tmp: string;
  let originSub: string;
  let workspace: string;
  let subCheckout: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pull-forward-test-'));

    originSub = path.join(tmp, 'origin-sub');
    await initRepo(originSub);
    await commitFile(originSub, 'a.txt', 'a\n', 'init');

    workspace = path.join(tmp, 'workspace');
    await initRepo(workspace);
    await commitFile(workspace, 'package.json', '{"name":"root","private":true}\n', 'root init');
    await git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', originSub, 'packages/sub');
    await git(workspace, 'commit', '-m', 'add sub');
    subCheckout = path.join(workspace, 'packages', 'sub');
    await git(subCheckout, 'config', 'user.email', 'test@test.test');
    await git(subCheckout, 'config', 'user.name', 'test');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const head = async (repo: string) => (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();

  it('fast-forwards a repo that is strictly behind its upstream', async () => {
    const oldHead = await head(subCheckout);
    await commitFile(originSub, 'src.ts', 'export const x = 2;\n', 'upstream change');

    const report = await pullForwardWorkspace(workspace);

    expect(await head(subCheckout)).toEqual(await head(originSub));
    expect(report.repos).toEqual([
      { repoPath: 'packages/sub', status: 'fast-forwarded', oldHead, newHead: await head(originSub) },
    ]);
    expect(report.pullFailures).toEqual([]);
    expect(report.installedPackages).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('fast-forwards through locally-dirty lockfile churn when upstream also touched the lockfile', async () => {
    // The workspace's documented churn class: builds leave unstaged package-lock.json edits while
    // CI release commits touch the same file — without autostash the ff merge refuses and the
    // repo lands in pullFailures. Edits sit at opposite ends of the file so the autostash pop
    // re-applies cleanly.
    const lockLines = Array.from({ length: 12 }, (_, i) => `line${String(i + 1).padStart(2, '0')}`);
    await commitFile(originSub, 'package-lock.json', lockLines.join('\n') + '\n', 'lockfile base');
    await git(subCheckout, 'pull');
    const upstreamLines = ['line01-upstream', ...lockLines.slice(1)];
    await commitFile(originSub, 'package-lock.json', upstreamLines.join('\n') + '\n', 'upstream lockfile change');
    const churnedLines = [...lockLines.slice(0, 11), 'line12-local'];
    await fs.writeFile(path.join(subCheckout, 'package-lock.json'), churnedLines.join('\n') + '\n');

    const report = await pullForwardWorkspace(workspace);

    expect(await head(subCheckout)).toEqual(await head(originSub));
    expect(report.repos).toContainEqual(
      expect.objectContaining({ repoPath: 'packages/sub', status: 'fast-forwarded' })
    );
    expect(report.pullFailures).toEqual([]);
    expect(report.ok).toBe(true);
    // The autostash pop restored the local churn on top of the upstream change — nothing dropped.
    const lockfile = await fs.readFile(path.join(subCheckout, 'package-lock.json'), 'utf-8');
    expect(lockfile).toContain('line01-upstream');
    expect(lockfile).toContain('line12-local');
  });

  it('named-repos mode fast-forwards the named repo itself and only that repo', async () => {
    const originSub2 = path.join(tmp, 'origin-sub2');
    await initRepo(originSub2);
    await commitFile(originSub2, 'b.txt', 'b\n', 'init');
    await git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', originSub2, 'packages/sub2');
    await git(workspace, 'commit', '-m', 'add sub2');
    const sub2Checkout = path.join(workspace, 'packages', 'sub2');
    const sub2Head = await head(sub2Checkout);
    await commitFile(originSub, 'src.ts', 'export const x = 2;\n', 'upstream change');
    await commitFile(originSub2, 'src.ts', 'export const x = 3;\n', 'upstream change 2');

    const report = await pullForwardWorkspace(workspace, ['sub']);

    expect(await head(subCheckout)).toEqual(await head(originSub));
    expect(report.repos).toEqual([expect.objectContaining({ repoPath: 'packages/sub', status: 'fast-forwarded' })]);
    // The unnamed repo was neither pulled nor classified.
    expect(await head(sub2Checkout)).toEqual(sub2Head);
    expect(report.ok).toBe(true);
  });

  it('reports a strictly-ahead repo and leaves it untouched, without failing the run', async () => {
    await commitFile(subCheckout, 'local.ts', 'export const y = 1;\n', 'local session work');
    const localHead = await head(subCheckout);

    const report = await pullForwardWorkspace(workspace);

    expect(await head(subCheckout)).toEqual(localHead);
    expect(report.repos).toEqual([{ repoPath: 'packages/sub', status: 'ahead', ahead: 1, behind: 0 }]);
    expect(report.ok).toBe(true);
  });

  it('reports a no-upstream repo and leaves it untouched', async () => {
    await git(subCheckout, 'checkout', '-b', 'local-only');
    const localHead = await head(subCheckout);
    await commitFile(originSub, 'src.ts', 'export const x = 2;\n', 'upstream change');

    const report = await pullForwardWorkspace(workspace);

    expect(await head(subCheckout)).toEqual(localHead);
    expect(report.repos).toEqual([{ repoPath: 'packages/sub', status: 'no-upstream' }]);
    expect(report.ok).toBe(true);
  });

  it('reports a diverged repo and leaves it untouched, without failing the run', async () => {
    await commitFile(originSub, 'src.ts', 'export const x = 2;\n', 'upstream change');
    await commitFile(subCheckout, 'local.ts', 'export const y = 1;\n', 'local session work');
    const localHead = await head(subCheckout);

    const report = await pullForwardWorkspace(workspace);

    expect(await head(subCheckout)).toEqual(localHead);
    expect(report.repos).toEqual([{ repoPath: 'packages/sub', status: 'diverged', ahead: 1, behind: 1 }]);
    expect(report.pullFailures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('reports a detached-HEAD repo and leaves it untouched', async () => {
    await git(subCheckout, 'checkout', '--detach');
    const detachedHead = await head(subCheckout);
    await commitFile(originSub, 'src.ts', 'export const x = 2;\n', 'upstream change');

    const report = await pullForwardWorkspace(workspace);

    expect(await head(subCheckout)).toEqual(detachedHead);
    expect(report.repos).toEqual([{ repoPath: 'packages/sub', status: 'detached' }]);
    expect(report.ok).toBe(true);
  });

  it('npm installs a package whose manifest changed in a fast-forward', async () => {
    // A package repo whose dependency is a committed file: tarball — npm resolves it from the
    // repo itself, so installs are hermetic.
    const stage = path.join(tmp, 'stage', 'package');
    await fs.mkdir(stage, { recursive: true });
    const originPkg = path.join(tmp, 'origin-pkg');
    await initRepo(originPkg);
    await fs.writeFile(path.join(stage, 'package.json'), '{"name":"fixture-dep","version":"1.0.0"}\n');
    await cmd('tar', ['-czf', path.join(originPkg, 'fixture-dep-1.tgz'), '-C', path.join(tmp, 'stage'), 'package']);
    await commitFile(
      originPkg,
      'package.json',
      '{"name":"fixture-sub","version":"1.0.0","dependencies":{"fixture-dep":"file:fixture-dep-1.tgz"}}\n',
      'v1'
    );
    await git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', originPkg, 'packages/pkg');
    await git(workspace, 'commit', '-m', 'add pkg');
    const pkgCheckout = path.join(workspace, 'packages', 'pkg');

    // The checkout starts coherent at v1: dep installed, no lockfile.
    await cmd('npm', ['install'], { cwd: pkgCheckout }, { omitLogs: { stdout: { omit: true } } });
    await fs.rm(path.join(pkgCheckout, 'package-lock.json'));

    // Upstream bumps the dep to v2. The doctor alone would NOT refresh this — the entry exists —
    // so only the manifest-install pass can land v2 in node_modules.
    await fs.writeFile(path.join(stage, 'package.json'), '{"name":"fixture-dep","version":"2.0.0"}\n');
    await cmd('tar', ['-czf', path.join(originPkg, 'fixture-dep-2.tgz'), '-C', path.join(tmp, 'stage'), 'package']);
    await commitFile(
      originPkg,
      'package.json',
      '{"name":"fixture-sub","version":"1.0.1","dependencies":{"fixture-dep":"file:fixture-dep-2.tgz"}}\n',
      'v2'
    );

    const report = await pullForwardWorkspace(workspace);

    const installedDep = JSON.parse(
      await fs.readFile(path.join(pkgCheckout, 'node_modules', 'fixture-dep', 'package.json'), 'utf-8')
    );
    expect(installedDep.version).toEqual('2.0.0');
    expect(report.installedPackages).toEqual(['fixture-sub']);
    expect(report.repos).toContainEqual(
      expect.objectContaining({ repoPath: 'packages/pkg', status: 'fast-forwarded' })
    );
    expect(report.ok).toBe(true);
  });

  it('collects a fetch failure and fails the run without stranding the sweep', async () => {
    const originSub2 = path.join(tmp, 'origin-sub2');
    await initRepo(originSub2);
    await commitFile(originSub2, 'b.txt', 'b\n', 'init');
    await git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', originSub2, 'packages/sub2');
    await git(workspace, 'commit', '-m', 'add sub2');
    await commitFile(originSub, 'src.ts', 'export const x = 2;\n', 'upstream change');
    await git(subCheckout, 'remote', 'set-url', 'origin', path.join(tmp, 'nonexistent-origin'));

    const report = await pullForwardWorkspace(workspace);

    expect(report.pullFailures.map((f) => f.repoPath)).toEqual(['packages/sub']);
    expect(report.pullFailures[0].detail).not.toHaveLength(0);
    // The broken repo did not stop the sweep: sub2 was still classified.
    expect(report.repos).toEqual([{ repoPath: 'packages/sub2', status: 'up-to-date' }]);
    expect(report.ok).toBe(false);
  });

  it('collects a repo whose classification fails as a pull failure instead of crashing the sweep', async () => {
    const originSub2 = path.join(tmp, 'origin-sub2');
    await initRepo(originSub2);
    await commitFile(originSub2, 'b.txt', 'b\n', 'init');
    await git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', originSub2, 'packages/sub2');
    await git(workspace, 'commit', '-m', 'add sub2');
    // A gitdir HEAD symref to an invalid refname: submodule enumeration still lists the repo as
    // initialized, but every rev-parse inside it fails — the broken-repo class that used to
    // escape collection and crash the whole sweep.
    await fs.writeFile(
      path.join(workspace, '.git', 'modules', 'packages', 'sub', 'HEAD'),
      'ref: refs/heads/bad..name\n'
    );

    const report = await pullForwardWorkspace(workspace);

    expect(report.pullFailures.map((f) => f.repoPath)).toEqual(['packages/sub']);
    expect(report.pullFailures[0].detail).not.toHaveLength(0);
    // The broken repo did not stop the sweep: sub2 was still classified.
    expect(report.repos).toEqual([{ repoPath: 'packages/sub2', status: 'up-to-date' }]);
    expect(report.ok).toBe(false);
  });

  it('fails the run when the doctor gate leaves an unfixed finding', async () => {
    // A workspace package with sources, a build script that fails without emitting, and no dist:
    // the doctor diagnoses stale-dist, fix()'s build attempt fails, and the finding survives
    // re-diagnosis — the remainingFindings conjunct alone must flip ok.
    const brokenDir = path.join(workspace, 'packages', 'fixture-broken-build');
    await fs.mkdir(path.join(brokenDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(brokenDir, 'package.json'),
      '{"name":"fixture-broken-build","version":"1.0.0","scripts":{"build":"false"}}\n'
    );
    await fs.writeFile(path.join(brokenDir, 'src', 'index.ts'), 'export const x = 1;\n');

    const report = await pullForwardWorkspace(workspace);

    expect(report.remainingFindings).toContainEqual(
      expect.objectContaining({ packageName: 'fixture-broken-build', kind: 'stale-dist' })
    );
    // Isolate the conjunct: nothing else failed, so ok=false can only come from remainingFindings.
    expect(report.pullFailures).toEqual([]);
    expect(report.installFailures).toEqual([]);
    expect(report.ok).toBe(false);
  });

  it('collects an npm install failure from a fast-forwarded manifest and fails the run', async () => {
    // Upstream re-points an already-installed dep at a nonexistent file: path: the
    // manifest-install pass's npm install fails (ENOENT), while the doctor stays clean — the
    // v1 dep entry still exists in node_modules and the doctor only checks entry EXISTENCE —
    // so the installFailures conjunct alone must flip ok.
    const stage = path.join(tmp, 'stage', 'package');
    await fs.mkdir(stage, { recursive: true });
    const originPkg = path.join(tmp, 'origin-pkg');
    await initRepo(originPkg);
    await fs.writeFile(path.join(stage, 'package.json'), '{"name":"fixture-dep","version":"1.0.0"}\n');
    await cmd('tar', ['-czf', path.join(originPkg, 'fixture-dep-1.tgz'), '-C', path.join(tmp, 'stage'), 'package']);
    await commitFile(
      originPkg,
      'package.json',
      '{"name":"fixture-badinstall","version":"1.0.0","dependencies":{"fixture-dep":"file:fixture-dep-1.tgz"}}\n',
      'v1'
    );
    await git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', originPkg, 'packages/pkg');
    await git(workspace, 'commit', '-m', 'add pkg');
    const pkgCheckout = path.join(workspace, 'packages', 'pkg');

    // The checkout starts coherent at v1: dep installed, no lockfile.
    await cmd('npm', ['install'], { cwd: pkgCheckout }, { omitLogs: { stdout: { omit: true } } });
    await fs.rm(path.join(pkgCheckout, 'package-lock.json'));

    await commitFile(
      originPkg,
      'package.json',
      '{"name":"fixture-badinstall","version":"1.0.1","dependencies":{"fixture-dep":"file:nonexistent.tgz"}}\n',
      'v2 with unresolvable dep'
    );

    const report = await pullForwardWorkspace(workspace);

    expect(report.installFailures).toEqual([
      expect.objectContaining({ packageName: 'fixture-badinstall', detail: expect.stringMatching(/./) }),
    ]);
    expect(report.repos).toContainEqual(
      expect.objectContaining({ repoPath: 'packages/pkg', status: 'fast-forwarded' })
    );
    // Isolate the conjunct: nothing else failed, so ok=false can only come from installFailures.
    expect(report.pullFailures).toEqual([]);
    expect(report.remainingFindings).toEqual([]);
    expect(report.ok).toBe(false);
  });
});
