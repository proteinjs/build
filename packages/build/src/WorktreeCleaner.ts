import * as path from 'path';
import * as fs from 'fs/promises';
import { cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { EstateReaper } from './EstateReaper';

/** Marker file a human (or lane) drops at a worktree root to pin it against sweeps. */
export const KEEP_MARKER_FILENAME = '.worktree-keep';

/** Basenames whose dirt never blocks removal (the stale-lock rule: local lock regens are never shipped). */
export const IGNORABLE_DIRT_BASENAMES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  KEEP_MARKER_FILENAME,
];

export type WorktreeVerdict = 'safe' | 'pinned' | 'unknown';

/** One open path held by a live process — the signal that pins a worktree against removal. */
export type ProcessHold = {
  pid: number;
  command: string;
  path: string;
};

/**
 * Snapshot of every path currently held open (cwd or open file) by any process.
 * Resolves `undefined` when the snapshot could not be taken — the cleaner then refuses to call
 * anything safe (verdicts degrade to `unknown`) rather than guessing.
 */
export type ProcessScan = () => Promise<ProcessHold[] | undefined>;

export type WorktreeReport = {
  /** Absolute path of the worktree directory (as git registered it). */
  path: string;
  /** Absolute common git dir of the owning repository ('' when unresolvable). */
  repoGitDir: string;
  /** Branch name (e.g. `feat/x`), or undefined when detached/unresolvable. */
  branch?: string;
  /** Tip commit sha, when resolvable. */
  head?: string;
  /** True for a repository's primary checkout — never a removal candidate. */
  primary: boolean;
  verdict: WorktreeVerdict;
  /** Human reason for the verdict (pin cause, unknown cause, or the safe rationale). */
  reason: string;
  /** True when the only uncommitted dirt is lockfiles — still safe; removal passes --force. */
  lockOnlyDirt: boolean;
  /** True when the registration's directory is already gone — nothing to remove, prune reclaims it. */
  pruneOnly: boolean;
  /** Measured disk usage in bytes; undefined when measurement failed (never estimated). */
  sizeBytes?: number;
  /** Apply mode: whether `git worktree remove` succeeded for this entry. */
  removed?: boolean;
  removeError?: string;
};

export type CleanWorktreesResult = {
  worktrees: WorktreeReport[];
  /** Common git dirs `git worktree prune` ran against (apply mode only). */
  reposPruned: string[];
  pruneErrors: { gitDir: string; error: string }[];
  /**
   * Sum of MEASURED sizes of worktrees actually removed (apply) or removable (dry-run).
   * Worktrees whose size could not be measured are excluded and counted in `unmeasuredRemovals` —
   * the number is never estimated.
   */
  reclaimedBytes: number;
  unmeasuredRemovals: number;
  apply: boolean;
};

export type WorktreeCleanerOptions = {
  /** Workspace root to enumerate repositories under (metarepo root, submodules, nested repos). */
  workspaceRoot: string;
  /** Extra directories to scan for worktree checkouts (session scratchpads, .scratch estates). */
  scanRoots?: string[];
  /** Absolute paths to pin explicitly (the --keep flag). */
  keep?: string[];
  /** Actually remove + prune. Default: dry-run (classify + report only). */
  apply?: boolean;
  /** Override / test seam for the process-hold snapshot. Default: one lsof pass over all processes. */
  processScan?: ProcessScan;
  /**
   * The dead-by-contract window (PROCESS.md session-scratch ruling, default 36h): a worktree with
   * ANY mtime younger than this is IN USE and pinned, however git-clean it is — agent-lane
   * activity is bursty (short-lived npm/tsc processes), so instantaneous process holds miss live
   * estates (the 2026-08-31 voicesmoke incident). 0 disables the activity spare.
   */
  activityTtlMs?: number;
};

/** How a worktree came to be known before classification. */
type WorktreeCandidate = {
  path: string;
  repoGitDir: string;
  head?: string;
  branch?: string;
  primary: boolean;
  locked?: string;
  prunable?: boolean;
  /** Enumeration-level failure (e.g. orphaned admin dir) — classified `unknown`, never touched. */
  broken?: string;
};

const MAX_SCAN_DEPTH = 6;
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git', '.nx', '.cache', 'coverage', '.Trash']);
/** Activity probe skips (regenerable churn that would false-pin); `dist` deliberately INCLUDED. */
const ACTIVITY_SKIP_DIR_NAMES = new Set(['node_modules', '.nx', '.cache', 'coverage', '.Trash']);

/**
 * Worktree lifecycle sweeper (PROCESS.md "Temp and workspace hygiene", ruled 2026-08-20):
 * enumerate -> classify -> remove -> prune -> report. A lane/leg worktree is reclaimable the
 * moment its commits are train-visible — commits live in the repo's shared object store, so
 * deleting a worktree never deletes commits.
 *
 * Verdicts:
 *  - `safe`    — tip commit verified present in the object store AND no uncommitted non-lockfile
 *                dirt AND not pinned. Lockfile-only dirt still counts as clean (local lock regens
 *                are never shipped); removal passes --force for those.
 *  - `pinned`  — never removed: the primary checkout, a git-locked worktree, uncommitted real
 *                dirt, a live process holding paths inside it, an explicit --keep, or a
 *                `.worktree-keep` marker at the worktree root.
 *  - `unknown` — reported, never touched: broken/orphaned registrations, git failures, or an
 *                unavailable process-hold snapshot (we refuse to call anything safe we cannot prove).
 *
 * This class is the single owner of the lifecycle; the metarepo CLI (`clean-worktrees`) and the
 * n3xa dev skill's workspace-management tooling are thin doors over it.
 */
export class WorktreeCleaner {
  private logger = new Logger({ name: 'WorktreeCleaner' });

  constructor(private options: WorktreeCleanerOptions) {}

  /** Enumerate -> classify -> (apply: remove + prune) -> report. Dry-run unless `apply` is set. */
  async clean(): Promise<CleanWorktreesResult> {
    const apply = !!this.options.apply;
    const candidates = await this.enumerate();
    const holds = await this.snapshotProcessHolds();

    const worktrees: WorktreeReport[] = [];
    for (const candidate of candidates) {
      worktrees.push(await this.classify(candidate, holds));
    }

    const result: CleanWorktreesResult = {
      worktrees,
      reposPruned: [],
      pruneErrors: [],
      reclaimedBytes: 0,
      unmeasuredRemovals: 0,
      apply,
    };

    for (const report of worktrees) {
      if (report.verdict !== 'safe' || report.primary || report.pruneOnly) {
        continue;
      }
      if (apply) {
        try {
          await this.removeWorktree(report);
          report.removed = true;
        } catch (error) {
          report.removed = false;
          report.removeError = error instanceof Error ? error.message : String(error);
          this.logger.error({ message: `Failed to remove worktree ${report.path}: ${report.removeError}` });
          continue;
        }
      }
      if (report.sizeBytes === undefined) {
        result.unmeasuredRemovals++;
      } else {
        result.reclaimedBytes += report.sizeBytes;
      }
    }

    if (apply) {
      const gitDirs: string[] = [];
      for (const worktree of worktrees) {
        if (worktree.repoGitDir.length > 0 && gitDirs.indexOf(worktree.repoGitDir) === -1) {
          gitDirs.push(worktree.repoGitDir);
        }
      }
      for (const gitDir of gitDirs) {
        try {
          await this.git(gitDir, [`--git-dir=${gitDir}`, 'worktree', 'prune']);
          result.reposPruned.push(gitDir);
        } catch (error) {
          result.pruneErrors.push({ gitDir, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    return result;
  }

  /**
   * Repos come from a bounded directory walk under the workspace root (`.git` dirs and submodule
   * `.git` pointer files), each contributing its `git worktree list`; loose worktree checkouts
   * (a `.git` FILE whose gitdir points into a `worktrees/` admin dir) are picked up by the same
   * walk over the scan roots, so worktrees of repos living OUTSIDE the workspace are still found.
   */
  private async enumerate(): Promise<WorktreeCandidate[]> {
    const repoRoots: string[] = [];
    const worktreeDirs: string[] = [];
    const roots = [this.options.workspaceRoot, ...(this.options.scanRoots ?? [])];
    for (const root of roots) {
      await this.walk(path.resolve(root), 0, repoRoots, worktreeDirs);
    }

    const candidates: WorktreeCandidate[] = [];
    const candidateKeys: string[] = [];
    const seenRepos: string[] = [];
    for (const repoRoot of repoRoots) {
      const repoKey = await this.canonicalPath(repoRoot);
      if (seenRepos.indexOf(repoKey) !== -1) {
        continue;
      }
      seenRepos.push(repoKey);
      for (const candidate of await this.listRepoWorktrees(repoRoot)) {
        const key = await this.canonicalPath(candidate.path);
        if (candidateKeys.indexOf(key) === -1) {
          candidateKeys.push(key);
          candidates.push(candidate);
        }
      }
    }
    for (const worktreeDir of worktreeDirs) {
      const key = await this.canonicalPath(worktreeDir);
      if (candidateKeys.indexOf(key) === -1) {
        candidateKeys.push(key);
        candidates.push(await this.probeLooseWorktree(worktreeDir));
      }
    }

    return candidates;
  }

  /** Classification order: primary/broken/stale first, then pins, then proofs (tip, dirt, process holds). */
  private async classify(candidate: WorktreeCandidate, holds: ProcessHold[] | undefined): Promise<WorktreeReport> {
    const report: WorktreeReport = {
      path: candidate.path,
      repoGitDir: candidate.repoGitDir,
      branch: candidate.branch,
      head: candidate.head,
      primary: candidate.primary,
      verdict: 'unknown',
      reason: '',
      lockOnlyDirt: false,
      pruneOnly: false,
    };

    if (candidate.primary) {
      report.verdict = 'pinned';
      report.reason = 'primary checkout';
      return report;
    }
    if (candidate.broken) {
      report.reason = candidate.broken;
      return report;
    }
    if (candidate.prunable || !(await this.exists(candidate.path))) {
      report.verdict = 'safe';
      report.pruneOnly = true;
      report.sizeBytes = 0;
      report.reason = 'stale registration — directory already gone; prune reclaims it';
      return report;
    }

    report.sizeBytes = await this.measure(candidate.path);

    if (candidate.locked !== undefined) {
      report.verdict = 'pinned';
      report.reason = `git-locked${candidate.locked ? `: ${candidate.locked}` : ''}`;
      return report;
    }
    const keepPaths = (this.options.keep ?? []).map((keepPath) => path.resolve(keepPath));
    if (keepPaths.includes(path.resolve(candidate.path))) {
      report.verdict = 'pinned';
      report.reason = 'pinned by --keep';
      return report;
    }
    if (await this.exists(path.join(candidate.path, KEEP_MARKER_FILENAME))) {
      report.verdict = 'pinned';
      report.reason = `keep marker (${KEEP_MARKER_FILENAME})`;
      return report;
    }

    try {
      report.head = (await this.git(candidate.path, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    } catch (error) {
      report.reason = `tip commit unverifiable: ${error instanceof Error ? error.message : String(error)}`;
      return report;
    }

    let statusOutput: string;
    try {
      // Raw output (no trim): the leading status column of the first line is significant.
      statusOutput = (await this.quietCmd('git', ['status', '--porcelain'], candidate.path)).stdout;
    } catch (error) {
      report.reason = `git status failed: ${error instanceof Error ? error.message : String(error)}`;
      return report;
    }
    const dirtPaths = this.parseStatusPaths(statusOutput);
    const realDirt = dirtPaths.filter((dirtPath) => !IGNORABLE_DIRT_BASENAMES.includes(path.basename(dirtPath)));
    if (realDirt.length > 0) {
      report.verdict = 'pinned';
      report.reason = `uncommitted dirt: ${realDirt.length} file${realDirt.length !== 1 ? 's' : ''} (e.g. ${realDirt[0]})`;
      return report;
    }
    report.lockOnlyDirt = dirtPaths.length > 0;

    // The activity spare (the 2026-08-31 voicesmoke rule): git-clean is NOT dead. Agent-lane use
    // is bursty — short-lived processes leave no hold to snapshot — so recent mtimes are the
    // durable liveness signal, and the session-scratch ruling's >36h window is the contract.
    const activityTtl = this.activityTtlMs();
    if (activityTtl > 0) {
      const newestMs = await this.newestMtimeMs(candidate.path);
      const age = Date.now() - newestMs;
      if (age < activityTtl) {
        report.verdict = 'pinned';
        report.reason = `recent activity: newest change ${EstateReaper.formatAge(Math.max(age, 0))} ago — inside the ${EstateReaper.formatAge(activityTtl)} dead-by-contract window`;
        return report;
      }
    }

    if (!holds) {
      report.reason = 'process-hold snapshot unavailable — cannot prove no live process is inside';
      return report;
    }
    const hold = holds.find(
      (processHold) => processHold.path === candidate.path || processHold.path.startsWith(candidate.path + path.sep)
    );
    if (hold) {
      report.verdict = 'pinned';
      report.reason = `held by process ${hold.pid} (${hold.command}): ${hold.path}`;
      return report;
    }

    report.verdict = 'safe';
    report.reason = report.lockOnlyDirt ? 'clean (lockfile-only dirt ignored)' : 'clean';
    return report;
  }

  /**
   * The classifier is THE removal gate: it has already proven the tip is in the object store and
   * the only dirt (if any) is lockfiles. `--force` bypasses git's coarser refusals that would
   * false-positive on exactly those approved cases (lockfile dirt; metarepo worktrees containing
   * submodule checkouts). Locked worktrees never reach here (classified `pinned`), and a single
   * --force does not override a lock.
   */
  private async removeWorktree(report: WorktreeReport): Promise<void> {
    // Act-time re-probe (the incident's second bite): classification and removal can be many
    // minutes apart on a big pass, and a lane can rebuild a worktree IN that window — the
    // voicesmoke lane rebuilt chat/ at 16:34 between a 16:13 snapshot and 16:36+ removals.
    const activityTtl = this.activityTtlMs();
    if (activityTtl > 0) {
      const age = Date.now() - (await this.newestMtimeMs(report.path));
      if (age < activityTtl) {
        throw new Error(
          `refused: worktree became active during the pass (newest change ${EstateReaper.formatAge(Math.max(age, 0))} ago)`
        );
      }
    }
    this.logger.info({ message: `Removing worktree ${report.path} (${report.reason})` });
    await this.git(report.repoGitDir, [`--git-dir=${report.repoGitDir}`, 'worktree', 'remove', '--force', report.path]);
  }

  /** Bounded, symlink-free directory walk collecting repo roots and loose worktree checkouts. */
  private async walk(dir: string, depth: number, repoRoots: string[], worktreeDirs: string[]): Promise<void> {
    if (depth > MAX_SCAN_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const gitEntry = entries.find((entry) => entry.name === '.git');
    if (gitEntry) {
      if (gitEntry.isDirectory()) {
        repoRoots.push(dir);
      } else {
        const gitdir = await this.readGitPointer(path.join(dir, '.git'));
        if (gitdir && /[\\/]worktrees[\\/]/.test(gitdir)) {
          worktreeDirs.push(dir);
        } else if (gitdir) {
          repoRoots.push(dir); // submodule checkout
        }
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      await this.walk(path.join(dir, entry.name), depth + 1, repoRoots, worktreeDirs);
    }
  }

  /** All worktrees a repo knows about, primary first (from `git worktree list --porcelain`). */
  private async listRepoWorktrees(repoRoot: string): Promise<WorktreeCandidate[]> {
    let commonDir: string;
    let porcelain: string;
    try {
      commonDir = await this.commonGitDir(repoRoot);
      porcelain = await this.git(repoRoot, ['worktree', 'list', '--porcelain']);
    } catch (error) {
      this.logger.warn({
        message: `Skipping ${repoRoot}: git worktree enumeration failed (${error instanceof Error ? error.message : String(error)})`,
      });
      return [];
    }

    const candidates: WorktreeCandidate[] = [];
    for (const block of porcelain.split(/\n\n+/)) {
      const lines = block.split('\n').filter((line) => line.length > 0);
      const worktreeLine = lines.find((line) => line.startsWith('worktree '));
      if (!worktreeLine) {
        continue;
      }
      const candidate: WorktreeCandidate = {
        path: worktreeLine.slice('worktree '.length),
        repoGitDir: commonDir,
        primary: candidates.length === 0,
      };
      for (const line of lines) {
        if (line.startsWith('HEAD ')) {
          candidate.head = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
          candidate.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        } else if (line === 'locked' || line.startsWith('locked ')) {
          candidate.locked = line === 'locked' ? '' : line.slice('locked '.length);
        } else if (line === 'prunable' || line.startsWith('prunable ')) {
          candidate.prunable = true;
        } else if (line === 'bare') {
          candidate.primary = true;
        }
      }
      candidates.push(candidate);
    }
    return candidates;
  }

  /** A worktree checkout found on disk whose owning repo was not enumerated (or whose admin is gone). */
  private async probeLooseWorktree(worktreeDir: string): Promise<WorktreeCandidate> {
    const candidate: WorktreeCandidate = { path: worktreeDir, repoGitDir: '', primary: false };
    try {
      candidate.repoGitDir = await this.commonGitDir(worktreeDir);
    } catch (error) {
      candidate.broken = `orphaned worktree: git cannot resolve its repository (${
        error instanceof Error ? error.message : String(error)
      })`;
      return candidate;
    }
    try {
      candidate.head = await this.git(worktreeDir, ['rev-parse', 'HEAD']);
    } catch {
      // classify() re-verifies the tip and degrades to unknown.
    }
    try {
      candidate.branch = await this.git(worktreeDir, ['symbolic-ref', '--short', '-q', 'HEAD']);
    } catch {
      // detached HEAD
    }
    try {
      const adminDir = path.resolve(worktreeDir, await this.git(worktreeDir, ['rev-parse', '--git-dir']));
      if (await this.exists(path.join(adminDir, 'locked'))) {
        candidate.locked = '';
      }
    } catch {
      // lock state stays undetected; dirt/process gates still apply.
    }
    return candidate;
  }

  /**
   * Default process-hold snapshot: ONE lsof pass over every process (cwd + open files + running
   * executables; memory maps and deleted fds excluded for volume), prefix-matched per worktree.
   * lsof likes exiting nonzero after warnings, so output wins over the exit code; no output and
   * a failure means "unavailable", which degrades would-be-safe verdicts to `unknown`.
   */
  private async snapshotProcessHolds(): Promise<ProcessHold[] | undefined> {
    if (this.options.processScan) {
      return await this.options.processScan();
    }
    try {
      const result = await this.quietCmd('lsof', ['-n', '-P', '-w', '-d', '^mem,^DEL', '-F', 'pcn']);
      return this.parseLsof(result.stdout);
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (typeof stdout === 'string' && stdout.length > 0) {
        return this.parseLsof(stdout);
      }
      return undefined;
    }
  }

  private parseLsof(output: string): ProcessHold[] {
    const holds: ProcessHold[] = [];
    let pid = 0;
    let command = '';
    for (const line of output.split('\n')) {
      if (line.startsWith('p')) {
        pid = Number(line.slice(1));
      } else if (line.startsWith('c')) {
        command = line.slice(1);
      } else if (line.startsWith('n/')) {
        holds.push({ pid, command, path: line.slice(1) });
      }
    }
    return holds;
  }

  /** Paths from `git status --porcelain` (rename lines yield the destination path). */
  private parseStatusPaths(statusOutput: string): string[] {
    return statusOutput
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => {
        const rawPath = line.slice(3);
        const renameArrow = rawPath.indexOf(' -> ');
        const chosen = renameArrow >= 0 ? rawPath.slice(renameArrow + 4) : rawPath;
        return chosen.replace(/^"|"$/g, '');
      });
  }

  private activityTtlMs(): number {
    return this.options.activityTtlMs ?? WorktreeCleaner.DEFAULT_ACTIVITY_TTL_MS;
  }

  /**
   * Newest mtime (ms) under a worktree: bounded walk (depth + stat budget), skipping `.git` and
   * heavy regenerable dirs but INCLUDING `dist` — a rebuild is exactly the activity evidence the
   * spare exists for. Directory mtimes count (creates/deletes bump the parent). On any stat
   * failure the entry is skipped; an unreadable tree yields the root's own mtime.
   */
  private async newestMtimeMs(dirPath: string): Promise<number> {
    let newest = 0;
    let budget = WorktreeCleaner.MAX_ACTIVITY_STATS;
    const probe = async (target: string, depth: number): Promise<void> => {
      if (budget-- <= 0) {
        return;
      }
      let stat;
      try {
        stat = await fs.lstat(target);
      } catch {
        return;
      }
      if (stat.mtimeMs > newest) {
        newest = stat.mtimeMs;
      }
      if (!stat.isDirectory() || depth >= WorktreeCleaner.MAX_ACTIVITY_DEPTH) {
        return;
      }
      let entries;
      try {
        entries = await fs.readdir(target, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === '.git' || ACTIVITY_SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        await probe(path.join(target, entry.name), depth + 1);
      }
    };
    await probe(dirPath, 0);
    return newest;
  }

  /** Measured disk usage in bytes, or undefined when measurement failed — never an estimate. */
  private async measure(dirPath: string): Promise<number | undefined> {
    try {
      const result = await this.quietCmd('du', ['-sk', dirPath]);
      const kilobytes = parseInt(result.stdout.trim().split(/\s+/)[0], 10);
      return Number.isNaN(kilobytes) ? undefined : kilobytes * 1024;
    } catch {
      return undefined;
    }
  }

  private async commonGitDir(dir: string): Promise<string> {
    return path.resolve(dir, await this.git(dir, ['rev-parse', '--git-common-dir']));
  }

  private async readGitPointer(gitFilePath: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(gitFilePath, 'utf-8');
      const match = content.match(/^gitdir:\s*(.+)\s*$/m);
      return match ? match[1] : undefined;
    } catch {
      return undefined;
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await this.quietCmd('git', args, cwd);
    return result.stdout.trim();
  }

  private async quietCmd(command: string, args: string[], cwd?: string) {
    return await cmd(
      command,
      args,
      { cwd: cwd ?? process.cwd() },
      { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }
    );
  }

  /** Realpath when resolvable (dedup across symlinked temp roots like /tmp vs /private/tmp). */
  private async canonicalPath(rawPath: string): Promise<string> {
    try {
      return await fs.realpath(rawPath);
    } catch {
      return path.resolve(rawPath);
    }
  }

  private async exists(checkPath: string): Promise<boolean> {
    try {
      await fs.access(checkPath);
      return true;
    } catch {
      return false;
    }
  }

  /** The PROCESS.md session-scratch ruling: younger than 36h = in use, whatever git says. */
  static readonly DEFAULT_ACTIVITY_TTL_MS = 36 * 3600_000;
  private static readonly MAX_ACTIVITY_DEPTH = 4;
  private static readonly MAX_ACTIVITY_STATS = 4000;
}
