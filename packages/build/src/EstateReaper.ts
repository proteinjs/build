import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { EstateRecord, EstateRegistry } from './EstateRegistry';

export type EstateVerdict = 'reaped' | 'partial' | 'spared' | 'failed';

export type EstateSweepReport = {
  estate: EstateRecord;
  verdict: EstateVerdict;
  /** Why the verdict (pin cause, liveness proof, or the reap rationale). */
  reason: string;
  /** What was actually done (apply mode) or would be done (dry-run), one line per act. */
  acts: string[];
  /** Per-item safety refusals — listed, never overridden (there is no --force). */
  refusals: string[];
  /** Measured bytes reclaimed by dir deletions (du, never estimated); undefined when nothing measured. */
  reclaimedBytes?: number;
};

export type ReapEstatesResult = {
  reports: EstateSweepReport[];
  /** Estate files that could not be parsed — reported, never touched. */
  unreadable: string[];
  apply: boolean;
  ownerScope?: string;
  reclaimedBytes: number;
};

/** How a pid's liveness resolved. `cwd` present only for `alive-ours`. */
type PidLiveness = { state: 'dead' | 'alive-ours' | 'alive-foreign' | 'alive-unverifiable'; cwd?: string };

export type EstateReaperOptions = {
  registry?: EstateRegistry;
  /** Dead-by-contract TTL (default 36h — the ruled session-scratch contract, PROCESS.md). */
  ttlMs?: number;
  /**
   * Owner-scoped exit sweep (`reap-estates --owner=<lane>`): the owner explicitly reaps its own
   * estates at lane exit. TTL is waived and OWNED pids are killed (cwd-verified first) — this is
   * the gated act, invoked by the owner itself. The scheduled sweep NEVER kills (D-3: locally no
   * automatic kills, ever — surfacing only).
   */
  owner?: string;
  /** Actually act. Default: dry-run (classify + report only), like clean-worktrees. */
  apply?: boolean;
  // ── Test seams (defaults are the real probes) ─────────────────────────────
  /** Is anything LISTENING on this local port? */
  portProbe?: (port: number) => Promise<boolean>;
  /** Pid liveness + cwd verification (pid-reuse guard). */
  pidProbe?: (pid: number, estateDirs: string[]) => Promise<PidLiveness>;
  /** Docker runner; undefined result = docker unavailable (container acts fail, dirs still sweep). */
  dockerRun?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string } | undefined>;
  /** Kill runner for owner-scoped sweeps (default: SIGTERM the pid's process group, then SIGKILL). */
  killPid?: (pid: number) => Promise<void>;
  now?: () => number;
};

/**
 * The estate reaper (RESOURCE_GOVERNANCE §B.2): sweeps DEAD estates on schedule and on demand,
 * mechanizing the PROCESS.md hygiene ruling's safety rules. The judgment line (§B.5):
 *
 *  - Only REGISTERED estates are ever touched — unregistered things are outside the boundary.
 *  - Never a live estate: fresh heartbeat (< TTL), an answering port, or a live cwd-verified pid
 *    each pin the estate (a serving instance is never swept, even with a stale heartbeat — it is
 *    SURFACED as a refusal instead).
 *  - Never unpushed git work: every git repo/worktree found under an estate's dirs must have no
 *    uncommitted non-lockfile dirt, no stashes, and no commits missing from the remote (with a
 *    patch-id equivalence check so re-landed work — the "orphaned lane" dup class — still sweeps).
 *  - Refusals are listed, never overridden; there is no --force (a human deletes by hand or the
 *    owner unpins — mixed estates reap their clean parts and RETAIN the record trimmed to what
 *    was refused, so the refusal stays visible).
 *  - No kills on the scheduled path (D-3). Owner-scoped exit sweeps (`--owner`) kill the estate's
 *    own cwd-verified pids — the owner asking for its own teardown is the gated act itself.
 *  - Every reap is logged with what/why (stdout + logs/reap.log receipts).
 *
 * Worktree lifecycle stays with WorktreeCleaner (no second owner): the reap-estates CLI runs it
 * as a delegated pass; this class only sweeps estate-owned dirs/containers/registrations.
 */
export class EstateReaper {
  private logger = new Logger({ name: 'EstateReaper' });
  private registry: EstateRegistry;

  constructor(private options: EstateReaperOptions = {}) {
    this.registry = options.registry ?? new EstateRegistry();
  }

  /** Classify every registered estate; apply mode reaps what is dead-by-contract. */
  async sweep(): Promise<ReapEstatesResult> {
    const apply = !!this.options.apply;
    const { estates, unreadable } = await this.registry.list();
    const result: ReapEstatesResult = {
      reports: [],
      unreadable,
      apply,
      ownerScope: this.options.owner,
      reclaimedBytes: 0,
    };
    for (const estate of estates) {
      if (this.options.owner !== undefined && estate.owner !== this.options.owner) {
        continue;
      }
      const report = await this.sweepEstate(estate, apply);
      result.reports.push(report);
      result.reclaimedBytes += report.reclaimedBytes ?? 0;
      this.appendReceipt(report, apply);
    }
    return result;
  }

  private async sweepEstate(estate: EstateRecord, apply: boolean): Promise<EstateSweepReport> {
    const report: EstateSweepReport = { estate, verdict: 'spared', reason: '', acts: [], refusals: [] };
    const now = (this.options.now ?? Date.now)();
    const ownerScoped = this.options.owner !== undefined;

    if (estate.pinned) {
      report.reason = 'pinned';
      return report;
    }
    const heartbeatAgeMs = now - estate.heartbeatAt;
    if (!ownerScoped && heartbeatAgeMs < this.ttlMs()) {
      report.reason = `heartbeat fresh (${EstateReaper.formatAge(heartbeatAgeMs)} old < TTL ${EstateReaper.formatAge(this.ttlMs())})`;
      return report;
    }

    // ── Liveness proofs: a serving estate is never swept, whatever its heartbeat says ────────
    for (const port of estate.ports) {
      if (await this.probePort(port)) {
        report.reason = ownerScoped
          ? `port ${port} still answering — stop the service before an owner sweep`
          : `port ${port} answering with a stale heartbeat (${EstateReaper.formatAge(heartbeatAgeMs)}) — serving instance, refusing; investigate the missing heartbeat`;
        report.refusals.push(report.reason);
        return report;
      }
    }
    const livePids: { pid: number; cwd?: string }[] = [];
    const unverifiablePids: number[] = [];
    for (const pid of estate.pids) {
      const liveness = await this.probePid(pid, estate.dirs);
      if (liveness.state === 'alive-ours') {
        livePids.push({ pid, cwd: liveness.cwd });
      } else if (liveness.state === 'alive-unverifiable') {
        unverifiablePids.push(pid);
      }
      // 'dead' and 'alive-foreign' (pid reuse — alive but cwd outside the estate) count as gone.
    }
    if (unverifiablePids.length > 0) {
      report.reason = `pid ${unverifiablePids[0]} alive but its cwd could not be verified — refusing (cannot prove the estate is dead)`;
      report.refusals.push(report.reason);
      return report;
    }
    if (livePids.length > 0 && !ownerScoped) {
      report.reason = `live process ${livePids.map((p) => p.pid).join(', ')} (cwd inside the estate) with a stale heartbeat — orphan candidate; surfacing only, never an automatic kill (D-3)`;
      report.refusals.push(report.reason);
      return report;
    }

    // ── Git safety per dir: never unpushed work ──────────────────────────────
    const reapableDirs: string[] = [];
    const refusedDirs: string[] = [];
    for (const dir of estate.dirs) {
      if (!(await this.exists(dir))) {
        continue; // already gone — the registration cleanup below still applies
      }
      const refusal = await this.gitSafetyRefusal(dir);
      if (refusal) {
        refusedDirs.push(dir);
        report.refusals.push(`${dir}: ${refusal}`);
      } else {
        reapableDirs.push(dir);
      }
    }

    // ── Act ──────────────────────────────────────────────────────────────────
    if (ownerScoped) {
      for (const { pid } of livePids) {
        report.acts.push(`kill pid ${pid} (owner sweep; cwd-verified)`);
        if (apply) {
          await this.killPid(pid);
        }
      }
    }
    for (const container of estate.containers) {
      report.acts.push(`stop+rm container ${container}`);
      if (apply) {
        const stopped = await this.dockerRun(['stop', container]);
        const removed = await this.dockerRun(['rm', container]);
        if (stopped === undefined || removed === undefined) {
          report.refusals.push(`container ${container}: docker unavailable — left as-is`);
        } else if (removed.code !== 0 && !/No such container/i.test(removed.stderr + stopped.stderr)) {
          report.refusals.push(`container ${container}: docker rm failed (${removed.stderr.trim() || removed.code})`);
        }
      }
    }
    let reclaimed = 0;
    for (const dir of reapableDirs) {
      const sizeBytes = await this.measure(dir);
      report.acts.push(`delete ${dir}${sizeBytes !== undefined ? ` (${EstateReaper.formatBytes(sizeBytes)})` : ''}`);
      if (apply) {
        await fs.rm(dir, { recursive: true, force: true });
      }
      reclaimed += sizeBytes ?? 0;
    }
    report.reclaimedBytes = reclaimed;

    if (refusedDirs.length === 0) {
      report.verdict = report.refusals.length > 0 ? 'failed' : 'reaped';
      report.reason =
        report.verdict === 'reaped'
          ? ownerScoped
            ? `owner sweep (${estate.owner})`
            : `dead-by-contract: heartbeat ${EstateReaper.formatAge(heartbeatAgeMs)} stale, no live port/pid`
          : `reap incomplete: ${report.refusals[0]}`;
      if (apply && report.verdict === 'reaped') {
        await this.registry.unregister(estate.id);
        report.acts.push(`unregister ${estate.id}`);
      }
    } else {
      // Mixed estate: clean parts reaped, refused dirs kept, and the RECORD retained trimmed to
      // the refusals — the dogfood recovery's exact practice (sweep around the unpushed heads),
      // with the refusal kept visible instead of silently re-sparing everything.
      report.verdict = 'partial';
      report.reason = `partial: ${refusedDirs.length} dir${refusedDirs.length !== 1 ? 's' : ''} refused (${report.refusals[0]})`;
      if (apply) {
        const trimmedNote = `reap ${new Date(now).toISOString()}: kept ${refusedDirs.length} refused dir(s); ${report.refusals.join(' | ')}`;
        await this.registry.heartbeat(estate.id, { dirs: refusedDirs, containers: [], note: trimmedNote });
        report.acts.push(`retain registration trimmed to refused dirs (${refusedDirs.join(', ')})`);
      }
    }
    return report;
  }

  // ── Git safety ─────────────────────────────────────────────────────────────

  /**
   * The reason this dir may NOT be deleted, or undefined when it is provably safe. Walks for git
   * checkouts (repos, submodules, worktrees) to a bounded depth; each must prove: no uncommitted
   * non-lockfile dirt, no stashes, and every local commit present on the remote — by ancestry
   * first, then by patch-id equivalence (re-landed lane work sweeps; genuinely unpushed work
   * refuses). A repo with no remote can prove nothing and refuses.
   */
  private async gitSafetyRefusal(dir: string): Promise<string | undefined> {
    const checkouts: { checkoutPath: string; worktree: boolean }[] = [];
    await this.findGitCheckouts(dir, 0, checkouts);
    for (const { checkoutPath, worktree } of checkouts) {
      const refusal = await this.checkoutRefusal(checkoutPath, worktree);
      if (refusal) {
        return `${path.relative(dir, checkoutPath) || '.'}: ${refusal}`;
      }
    }
    return undefined;
  }

  /**
   * `worktree` relaxes the proof to dirt-only: a LINKED WORKTREE's commits and stashes live in
   * the owning repo's object store and survive deletion (the PROCESS.md ruling clean-worktrees is
   * built on — deleting a worktree never deletes commits). Full clones and submodule checkouts
   * carry their object store with them and need the full unpushed/stash proof.
   */
  private async checkoutRefusal(checkout: string, worktree: boolean): Promise<string | undefined> {
    const status = await this.git(checkout, ['status', '--porcelain']);
    if (status === undefined) {
      return 'git status failed — cannot prove clean';
    }
    const dirt = EstateReaper.parseStatusPaths(status).filter(
      (dirtPath) => !EstateReaper.IGNORABLE_DIRT_BASENAMES.includes(path.basename(dirtPath))
    );
    if (dirt.length > 0) {
      return `uncommitted dirt: ${dirt.length} file${dirt.length !== 1 ? 's' : ''} (e.g. ${dirt[0]})`;
    }
    if (worktree) {
      return undefined;
    }
    const stashes = await this.git(checkout, ['stash', 'list']);
    if (stashes === undefined || stashes.trim().length > 0) {
      return stashes === undefined ? 'git stash list failed' : 'stash entries present';
    }
    const remotes = await this.git(checkout, ['remote']);
    if (!remotes || remotes.trim().length === 0) {
      return 'no git remote — cannot prove commits are train-visible';
    }
    const unpushed = await this.git(checkout, ['log', '--branches', '--tags', '--not', '--remotes', '--format=%H']);
    if (unpushed === undefined) {
      return 'git log failed — cannot prove commits are pushed';
    }
    const unpushedShas = unpushed
      .split('\n')
      .map((sha) => sha.trim())
      .filter((sha) => sha.length > 0);
    if (unpushedShas.length === 0) {
      return undefined;
    }
    if (unpushedShas.length > EstateReaper.MAX_PATCH_ID_COMMITS) {
      return `${unpushedShas.length} unpushed commits (too many for patch-id reconciliation)`;
    }
    // Patch-id equivalence (the worktree-reconcile idiom): a commit whose patch-id matches an
    // upstream commit's already landed — cherry-pick/rebase dups must not pin dead estates.
    const upstreamIds = await this.patchIds(checkout, ['--remotes', `-n`, `${EstateReaper.MAX_UPSTREAM_PATCH_IDS}`]);
    if (upstreamIds === undefined) {
      return `${unpushedShas.length} unpushed commit${unpushedShas.length !== 1 ? 's' : ''} (patch-id check unavailable)`;
    }
    for (const sha of unpushedShas) {
      const patchId = await this.patchIdOf(checkout, sha);
      if (!patchId || !upstreamIds.has(patchId)) {
        return `unpushed commit ${sha.slice(0, 8)} not found upstream (by ancestry or patch-id)`;
      }
    }
    return undefined;
  }

  /** Patch-ids of upstream commits (bounded). Undefined on git failure. */
  private async patchIds(checkout: string, revListArgs: string[]): Promise<Set<string> | undefined> {
    const revs = await this.git(checkout, ['rev-list', ...revListArgs]);
    if (revs === undefined) {
      return undefined;
    }
    const ids = new Set<string>();
    for (const sha of revs.split('\n').filter((line) => line.trim().length > 0)) {
      const patchId = await this.patchIdOf(checkout, sha.trim());
      if (patchId) {
        ids.add(patchId);
      }
    }
    return ids;
  }

  private async patchIdOf(checkout: string, sha: string): Promise<string | undefined> {
    try {
      const show = await cmd('git', ['show', sha], { cwd: checkout }, this.quiet());
      if (show.code !== 0) {
        return undefined;
      }
      const result = await cmd(
        'git',
        ['patch-id', '--stable'],
        { cwd: checkout },
        { ...this.quiet(), stdin: show.stdout }
      );
      if (result.code !== 0) {
        return undefined;
      }
      return result.stdout.trim().split(/\s+/)[0] || undefined;
    } catch {
      return undefined;
    }
  }

  /** Bounded walk collecting git checkout roots (a `.git` dir OR file — submodules and worktrees). */
  private async findGitCheckouts(
    dir: string,
    depth: number,
    found: { checkoutPath: string; worktree: boolean }[]
  ): Promise<void> {
    if (depth > EstateReaper.MAX_GIT_SCAN_DEPTH) {
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
      let worktree = false;
      if (!gitEntry.isDirectory()) {
        const pointer = await fs.readFile(path.join(dir, '.git'), 'utf-8').catch(() => '');
        worktree = /[\\/]worktrees[\\/]/.test(pointer);
      }
      found.push({ checkoutPath: dir, worktree });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || EstateReaper.SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      await this.findGitCheckouts(path.join(dir, entry.name), depth + 1, found);
    }
  }

  // ── Probes (seam-backed) ──────────────────────────────────────────────────

  private async probePort(port: number): Promise<boolean> {
    if (this.options.portProbe) {
      return this.options.portProbe(port);
    }
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      const done = (answer: boolean) => {
        socket.destroy();
        resolve(answer);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(1000, () => done(false));
    });
  }

  private async probePid(pid: number, estateDirs: string[]): Promise<PidLiveness> {
    if (this.options.pidProbe) {
      return this.options.pidProbe(pid, estateDirs);
    }
    try {
      process.kill(pid, 0);
    } catch {
      return { state: 'dead' };
    }
    // cwd verification (the pid-reuse guard): only a process actually WORKING IN the estate's
    // dirs proves the estate live. lsof -a -p <pid> -d cwd prints the cwd as an `n` field.
    try {
      const result = await cmd('lsof', ['-a', '-p', `${pid}`, '-d', 'cwd', '-Fn'], undefined, this.quiet());
      if (result.code !== 0) {
        return { state: 'alive-unverifiable' };
      }
      const cwdLine = result.stdout.split('\n').find((line) => line.startsWith('n'));
      if (!cwdLine) {
        return { state: 'alive-unverifiable' };
      }
      const cwd = cwdLine.slice(1).trim();
      const inside = estateDirs.some((dir) => cwd === dir || cwd.startsWith(dir + path.sep));
      return { state: inside ? 'alive-ours' : 'alive-foreign', cwd };
    } catch {
      return { state: 'alive-unverifiable' };
    }
  }

  private async dockerRun(args: string[]): Promise<{ code: number; stdout: string; stderr: string } | undefined> {
    if (this.options.dockerRun) {
      return this.options.dockerRun(args);
    }
    try {
      return await cmd('docker', args, undefined, this.quiet());
    } catch {
      return undefined;
    }
  }

  private async killPid(pid: number): Promise<void> {
    if (this.options.killPid) {
      return this.options.killPid(pid);
    }
    // The estate's own process tree: TERM the group (estates spawn detached trees), then KILL.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        return; // already gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }

  // ── Receipts ──────────────────────────────────────────────────────────────

  /** Append a JSON-line receipt for every swept estate — every reap logged with what/why. */
  private appendReceipt(report: EstateSweepReport, apply: boolean): void {
    try {
      fsSync.mkdirSync(this.registry.logsDir(), { recursive: true });
      const line = JSON.stringify({
        at: new Date().toISOString(),
        apply,
        ownerScope: this.options.owner,
        estate: report.estate.id,
        owner: report.estate.owner,
        verdict: report.verdict,
        reason: report.reason,
        acts: report.acts,
        refusals: report.refusals,
        reclaimedBytes: report.reclaimedBytes,
      });
      fsSync.appendFileSync(path.join(this.registry.logsDir(), 'reap.log'), line + '\n');
    } catch (error) {
      this.logger.warn({ message: `reap receipt write failed: ${error instanceof Error ? error.message : error}` });
    }
  }

  // ── Leaf utilities ─────────────────────────────────────────────────────────

  private ttlMs(): number {
    return this.options.ttlMs ?? EstateReaper.DEFAULT_TTL_MS;
  }

  private async git(cwd: string, args: string[]): Promise<string | undefined> {
    try {
      const result = await cmd('git', args, { cwd }, this.quiet());
      return result.code === 0 ? result.stdout : undefined;
    } catch {
      return undefined;
    }
  }

  private quiet() {
    return { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } };
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Measured size in bytes (du -sk), never estimated; undefined when measurement fails. */
  private async measure(dir: string): Promise<number | undefined> {
    try {
      const result = await cmd('du', ['-sk', dir], undefined, this.quiet());
      if (result.code !== 0) {
        return undefined;
      }
      const kb = Number(result.stdout.trim().split(/\s+/)[0]);
      return Number.isFinite(kb) ? kb * 1024 : undefined;
    } catch {
      return undefined;
    }
  }

  private static parseStatusPaths(statusOutput: string): string[] {
    return statusOutput
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''));
  }

  static formatAge(ms: number): string {
    if (ms >= 24 * 3600_000) {
      return `${(ms / (24 * 3600_000)).toFixed(1)}d`;
    }
    if (ms >= 3600_000) {
      return `${(ms / 3600_000).toFixed(1)}h`;
    }
    return `${Math.round(ms / 60_000)}m`;
  }

  static formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${Math.ceil(bytes / 1024)} KB`;
  }

  static readonly DEFAULT_TTL_MS = 36 * 3600_000;
  private static readonly MAX_GIT_SCAN_DEPTH = 5;
  private static readonly MAX_PATCH_ID_COMMITS = 50;
  private static readonly MAX_UPSTREAM_PATCH_IDS = 500;
  private static readonly SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git', '.nx', '.cache', 'coverage']);
  /** The stale-lock rule: local lock regens are never shipped and never block a reap. */
  static readonly IGNORABLE_DIRT_BASENAMES = [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
  ];
}
