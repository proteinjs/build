import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { WorktreeCleaner, WorktreeReport, KEEP_MARKER_FILENAME } from '../src/WorktreeCleaner';

/**
 * Hermetic fixture repos (real git, no network). Each classifier rule is staged as its
 * real-world cause — a clean committed lane worktree, a worktree carrying uncommitted work,
 * lockfile-only dirt, the keep marker (the fixture proxy for a process pin), an injected
 * process hold, a corrupted registration — and the verdict plus the OUTCOME (directories
 * removed or left alone, registrations pruned) is asserted.
 */

const git = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const exists = async (p: string) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

describe('WorktreeCleaner', () => {
  let fixtureRoot: string;
  let workspaceRoot: string;
  let repoDir: string;

  const initRepo = async (dir: string) => {
    await fs.mkdir(dir, { recursive: true });
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@test.io']);
    git(dir, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(dir, 'src.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion": 3}\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'init']);
  };

  const addWorktree = async (repo: string, wtPath: string, branch: string) => {
    git(repo, ['worktree', 'add', '-b', branch, wtPath]);
    // Give every worktree measurable bulk so size accounting has something to measure.
    await fs.writeFile(path.join(wtPath, 'bulk.bin'), Buffer.alloc(64 * 1024, 1));
    git(wtPath, ['add', 'bulk.bin']);
    git(wtPath, ['commit', '-m', 'bulk']);
    return wtPath;
  };

  const cleaner = (overrides: Partial<ConstructorParameters<typeof WorktreeCleaner>[0]> = {}) =>
    new WorktreeCleaner({
      workspaceRoot,
      scanRoots: [],
      processScan: async () => [],
      ...overrides,
    });

  const reportFor = (result: { worktrees: WorktreeReport[] }, wtPath: string) =>
    result.worktrees.find((worktree) => worktree.path === wtPath);

  beforeEach(async () => {
    // realpath: macOS tmpdirs live behind /var -> /private/var; git registers the real path.
    fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-cleaner-test-')));
    workspaceRoot = path.join(fixtureRoot, 'workspace');
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'root', private: true }));
    repoDir = path.join(workspaceRoot, 'packages', 'repo-a');
    await initRepo(repoDir);
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  test('classifies a clean committed worktree as safe, with a measured size', async () => {
    const wt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane1', 'repo-a'), 'lane/one');

    const result = await cleaner().clean();

    const report = reportFor(result, wt);
    expect(report).toBeDefined();
    expect(report!.verdict).toBe('safe');
    expect(report!.primary).toBe(false);
    expect(report!.branch).toBe('lane/one');
    expect(report!.sizeBytes).toBeGreaterThan(64 * 1024);
    // Dry-run by default: nothing removed, would-reclaim is the measured size.
    expect(result.apply).toBe(false);
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(report!.sizeBytes!);
    expect(await exists(wt)).toBe(true);
  });

  test('pins a worktree carrying uncommitted non-lock dirt', async () => {
    const wt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane2', 'repo-a'), 'lane/two');
    await fs.writeFile(path.join(wt, 'wip.ts'), 'export const wip = true;\n');

    const result = await cleaner({ apply: true }).clean();

    const report = reportFor(result, wt);
    expect(report!.verdict).toBe('pinned');
    expect(report!.reason).toMatch(/dirt/i);
    expect(report!.removed).toBeUndefined();
    expect(await exists(wt)).toBe(true);
  });

  test('treats lockfile-only dirt as clean (stale-lock rule)', async () => {
    const wt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane3', 'repo-a'), 'lane/three');
    await fs.writeFile(path.join(wt, 'package-lock.json'), '{"lockfileVersion": 3, "regenerated": true}\n');

    const result = await cleaner().clean();

    const report = reportFor(result, wt);
    expect(report!.verdict).toBe('safe');
    expect(report!.lockOnlyDirt).toBe(true);
  });

  test('pins a worktree carrying the keep marker (the process-pin fixture proxy)', async () => {
    const wt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane4', 'repo-a'), 'lane/four');
    await fs.writeFile(path.join(wt, KEEP_MARKER_FILENAME), '');

    const result = await cleaner({ apply: true }).clean();

    const report = reportFor(result, wt);
    expect(report!.verdict).toBe('pinned');
    expect(report!.reason).toMatch(/keep marker/i);
    expect(await exists(wt)).toBe(true);
  });

  test('pins paths named by the keep option', async () => {
    const wt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane5', 'repo-a'), 'lane/five');

    const result = await cleaner({ keep: [wt] }).clean();

    expect(reportFor(result, wt)!.verdict).toBe('pinned');
    expect(reportFor(result, wt)!.reason).toMatch(/--keep/);
  });

  test('pins a worktree a live process holds paths under', async () => {
    const wt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane6', 'repo-a'), 'lane/six');

    const result = await cleaner({
      processScan: async () => [{ pid: 4242, command: 'node', path: path.join(wt, 'src.ts') }],
    }).clean();

    const report = reportFor(result, wt);
    expect(report!.verdict).toBe('pinned');
    expect(report!.reason).toContain('4242');
  });

  test('degrades to unknown when the process scan is unavailable', async () => {
    const wt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane7', 'repo-a'), 'lane/seven');

    const result = await cleaner({ processScan: async () => undefined, apply: true }).clean();

    const report = reportFor(result, wt);
    expect(report!.verdict).toBe('unknown');
    expect(await exists(wt)).toBe(true);
  });

  test('reports a corrupted worktree as unknown and never touches it', async () => {
    const wt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane8', 'repo-a'), 'lane/eight');
    await fs.writeFile(path.join(wt, '.git'), 'gitdir: /nonexistent/gitdir/worktrees/gone\n');

    const result = await cleaner({ apply: true }).clean();

    const report = reportFor(result, wt);
    expect(report).toBeDefined();
    expect(report!.verdict).toBe('unknown');
    expect(await exists(wt)).toBe(true);
  });

  test('never classifies the primary checkout as removable', async () => {
    await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane9', 'repo-a'), 'lane/nine');

    const result = await cleaner({ apply: true }).clean();

    const primaries = result.worktrees.filter((worktree) => worktree.primary);
    expect(primaries.length).toBeGreaterThan(0);
    for (const primary of primaries) {
      expect(primary.verdict).not.toBe('safe');
    }
    expect(await exists(path.join(repoDir, 'src.ts'))).toBe(true);
  });

  test('apply removes safe worktrees, leaves pinned ones, and prunes registrations', async () => {
    const safeWt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane10', 'repo-a'), 'lane/ten');
    const dirtyWt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane11', 'repo-a'), 'lane/eleven');
    await fs.writeFile(path.join(dirtyWt, 'wip.ts'), 'export const wip = true;\n');
    const lockOnlyWt = await addWorktree(
      repoDir,
      path.join(workspaceRoot, '.scratch', 'lane12', 'repo-a'),
      'lane/twelve'
    );
    await fs.writeFile(path.join(lockOnlyWt, 'package-lock.json'), '{"regenerated": true}\n');

    const result = await cleaner({ apply: true }).clean();

    // Outcomes on disk.
    expect(await exists(safeWt)).toBe(false);
    expect(await exists(lockOnlyWt)).toBe(false);
    expect(await exists(dirtyWt)).toBe(true);
    // Registrations pruned: git no longer lists the removed worktrees.
    const listed = git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(listed).not.toContain(safeWt);
    expect(listed).not.toContain(lockOnlyWt);
    expect(listed).toContain(dirtyWt);
    // Commits survive worktree removal (the object store owns them).
    expect(git(repoDir, ['rev-parse', '--verify', 'lane/ten'])).toBeTruthy();
    // Honest accounting: reclaim is the sum of measured sizes of what was actually removed.
    expect(reportFor(result, safeWt)!.removed).toBe(true);
    expect(reportFor(result, lockOnlyWt)!.removed).toBe(true);
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(
      reportFor(result, safeWt)!.sizeBytes! + reportFor(result, lockOnlyWt)!.sizeBytes!
    );
    expect(result.reposPruned.length).toBeGreaterThan(0);
  });

  test('dry-run removes nothing and prunes nothing', async () => {
    const wt = await addWorktree(repoDir, path.join(workspaceRoot, '.scratch', 'lane13', 'repo-a'), 'lane/thirteen');

    const result = await cleaner().clean();

    expect(result.apply).toBe(false);
    expect(reportFor(result, wt)!.verdict).toBe('safe');
    expect(reportFor(result, wt)!.removed).toBeUndefined();
    expect(result.reposPruned).toEqual([]);
    expect(await exists(wt)).toBe(true);
    expect(git(repoDir, ['worktree', 'list', '--porcelain'])).toContain(wt);
  });

  test('discovers worktrees of outside repos via scan roots', async () => {
    const outsideRepo = path.join(fixtureRoot, 'outside-repo');
    await initRepo(outsideRepo);
    const scratch = path.join(fixtureRoot, 'session-scratch');
    const wt = await addWorktree(outsideRepo, path.join(scratch, 'lane', 'outside-repo'), 'lane/outside');

    const result = await cleaner({ scanRoots: [scratch] }).clean();

    const report = reportFor(result, wt);
    expect(report).toBeDefined();
    expect(report!.verdict).toBe('safe');
  });
});
