import * as path from 'path';
import * as fs from 'fs/promises';
import { ChildProcess, spawn } from 'child_process';
import { PackageUtil, WorkspaceMetadata } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { WorkspaceDoctor } from './WorkspaceDoctor';

export type ServePackageOptions = {
  /** Workspace package whose process this supervises (e.g. @n3xa/app-server). */
  packageName: string;
  /** Command to run in the package dir (e.g. ['node', 'dist/generated/index.js']). */
  command: string[];
  /** Override workspace root discovery (default: outermost ancestor of cwd with a package.json). */
  workspacePath?: string;
  /**
   * Packages whose closures must be COHERENT before a (re)spawn — set to the SAME scope the
   * child's own verify gate checks. A dev server that also webpack-builds a sibling UI package
   * verifies BOTH (e.g. --for=app-server,app-ui); if the supervisor only waits on the server
   * closure, a restart landing mid-UI-build spawns a child whose verify gate exits 1 (observed
   * 2026-07-29: thought-server build finished, restart fired, thought-ui build still running →
   * child died, supervisor mirrored the exit). Defaults to [packageName].
   */
  coherencePackages?: string[];
  /**
   * How long a freshly-spawned child must stay alive to count as BOOTED (default 90s). A child
   * that dies nonzero inside this window after a RESTART spawn is treated as a mid-churn boot
   * failure and retried through the coherence gate instead of killing the supervisor.
   */
  bootFailWindowMs?: number;
  /** Dist mtime poll interval. */
  pollMs?: number;
  /** Quiet period after the last dist change before a restart is considered (builds settle). */
  quietMs?: number;
  /** Grace period between SIGTERM and SIGKILL when stopping the child. */
  graceMs?: number;
  /**
   * Called when the child exits on its own (not via a supervisor restart/stop). The CLI wires
   * this to process.exit(code) so plain-run semantics are preserved.
   */
  onChildExit?: (code: number) => void;
};

type SupervisorState = 'running' | 'stale' | 'waiting-holds' | 'restarting' | 'stopped';

type Hold = {
  holder: string;
  expiresAt: number;
};

/**
 * Dev process supervisor: runs a package's serve command and restarts it when the package's
 * TRANSITIVE WORKSPACE CLOSURE's dists change on disk — the freshness class the node server
 * cannot cover itself (server-side dists land only on process restart).
 *
 * One rule, no modes: stale → announce; restart only once the change burst is quiet AND no
 * active HOLDS exist; `rs` on stdin or SIGUSR2 forces a restart regardless. The supervisor is
 * therefore "attended" exactly while something is attending (a hold is alive) and automatic
 * otherwise.
 *
 * Holds protocol (app-agnostic, portless): the child is spawned with SERVE_PACKAGE_IPC set to
 * a directory; anything may write TTL lease files under `<SERVE_PACKAGE_IPC>/holds/<name>.json`
 * shaped `{ "holder": string, "expiresAt": epochMs }` and refresh them while work is in flight
 * (an in-progress chat turn, a focused browser tab's dev heartbeat). Expired leases are ignored
 * and reaped, so a crashed holder can never wedge the lane. Processes that never write holds
 * get plain announce-then-restart semantics. The holds dir is cleared on every spawn — leases
 * belong to the child that wrote them.
 *
 * Also written under SERVE_PACKAGE_IPC: `pid` (supervisor pid, for `kill -USR2 $(cat pid)`)
 * and `state.json` (queryable status: state, child pid, stale packages, active holds).
 *
 * The child owns its own coherence gate (chain verify-workspace in the package's serve script);
 * the supervisor owns only process freshness.
 */
export class ServePackageSupervisor {
  /** Cross-process restart-request lease consumed by the poll loop (see requestRestart). */
  private static readonly RESTART_REQUEST_FILE = 'restart-request';

  private logger: Logger;
  private packageDir!: string;
  private closure: string[] = [];
  private distDirs: Record<string, string> = {};
  private baseline: Record<string, number> = {};
  private child?: ChildProcess;
  private state: SupervisorState = 'running';
  private stalePackages = new Set<string>();
  private staleSince = 0;
  private lastChangeAt = 0;
  private restarting = false;
  private stopping = false;
  private pollTimer?: NodeJS.Timeout;
  private lastHoldReport = '';
  private lastHoldAnnounceAt = 0;
  private ipcDir!: string;
  private workspacePathResolved!: string;
  // Boot-retry accounting for RESTART-spawned children (see the exit handler): whether the
  // current child came from restart(), when it was spawned, how many consecutive spawns died
  // inside the boot window, and the timer that declares a child successfully booted.
  private spawnedByRestart = false;
  private spawnedAt = 0;
  private consecutiveBootFailures = 0;
  private bootSettleTimer?: NodeJS.Timeout;

  constructor(private options: ServePackageOptions) {
    this.logger = new Logger({ name: `serve:${options.packageName.split('/').pop()}` });
  }

  /** Resolve the workspace, snapshot dist baselines, spawn the child, and start the poll loop. */
  async start(): Promise<void> {
    const workspacePath = this.options.workspacePath ?? (await WorkspaceDoctor.findWorkspaceRoot(process.cwd()));
    this.workspacePathResolved = workspacePath;
    const metadata = await PackageUtil.getWorkspaceMetadata(workspacePath);
    const localPackage = metadata.packageMap[this.options.packageName];
    if (!localPackage) {
      throw new Error(`Package (${this.options.packageName}) does not exist in workspace: ${workspacePath}`);
    }
    this.packageDir = path.dirname(localPackage.filePath);
    this.closure = await this.resolveClosure(metadata);
    for (const packageName of this.closure) {
      this.distDirs[packageName] = path.join(path.dirname(metadata.packageMap[packageName].filePath), 'dist');
    }
    this.ipcDir = path.join(this.packageDir, '.serve-package');
    await this.assertSingleInstance();
    await fs.mkdir(path.join(this.ipcDir, 'holds'), { recursive: true });
    await fs.writeFile(path.join(this.ipcDir, 'pid'), `${process.pid}\n`);
    // A request left behind for a dead supervisor is already satisfied by this fresh boot.
    await fs.rm(path.join(this.ipcDir, ServePackageSupervisor.RESTART_REQUEST_FILE), { force: true });
    this.logger.info({
      message: `> Watching dists of ${this.closure.length} workspace packages (closure of ${this.options.packageName}); restart triggers: dist change + quiet ${this.quietMs()}ms + no holds, or 'rs' / SIGUSR2`,
    });
    await this.spawnChild();
    this.pollTimer = setInterval(() => void this.poll().catch((e) => this.logger.error({ error: e })), this.pollMs());
  }

  /** Force a restart now, regardless of staleness or holds. */
  async restart(reason: string): Promise<void> {
    // !this.child also rejects signals delivered before start() has spawned anything.
    if (this.restarting || this.stopping || !this.child) {
      return;
    }
    this.restarting = true;
    this.setState('restarting');
    this.logger.info({ message: `> Restarting (${reason})` });
    try {
      await this.killChild();
      // stop() may have raced in while the child was dying — respawning after stop() resolved
      // would leak a live, unsupervised child.
      if (this.stopping) {
        return;
      }
      // Never spawn into an incoherent workspace: a restart triggered mid-BUILD would boot a
      // child whose own verify gate exits 1, and mirroring that exit killed the supervisor —
      // a rebuild-in-progress became permanent downtime (observed 2026-07-29). Coherence is
      // moments away by definition (a build is running); wait for it.
      await this.waitForCoherence();
      if (this.stopping) {
        return;
      }
      await this.spawnChild(true);
    } finally {
      // Without this, one throw in kill/spawn would leave restarting=true forever and
      // permanently disable every future restart, including rs/SIGUSR2.
      this.restarting = false;
    }
  }

  /**
   * Ask the supervisor of `packageDir` (if one is alive) for a HOLD- and COHERENCE-GATED
   * restart by dropping a `restart-request` lease in its ipc dir; the poll loop absorbs it
   * like a dist change (quiet window, holds, boot coherence all apply — unlike SIGUSR2,
   * this never bulldozes an active hold such as a chat turn).
   *
   * Exists for package-manager operations: npm tears node_modules down and rebuilds it, and
   * a watcher inside the running child (webpack dev middleware) can compile DURING that hole
   * and bake ENOENTs into its bundle. The post-op re-symlink restores identical mtimes, so
   * nothing the watcher watches ever changes again — the broken bundle sticks until the next
   * unrelated edit (observed 2026-07-29: /space dead on :3002 after a lockfile regen). A
   * settled-state restart is the categorical cure.
   *
   * Returns true when a live supervisor was found and the request was filed.
   */
  static async requestRestart(packageDir: string, requester: string): Promise<boolean> {
    const ipcDir = path.join(packageDir, '.serve-package');
    const raw = await fs.readFile(path.join(ipcDir, 'state.json'), 'utf-8').catch(() => undefined);
    if (!raw) {
      return false;
    }
    let snapshot: { supervisorPid?: number; state?: string };
    try {
      snapshot = JSON.parse(raw);
    } catch {
      return false; // partial write mid-update; the next op can retry
    }
    if (
      !snapshot.supervisorPid ||
      snapshot.state === 'stopped' ||
      !ServePackageSupervisor.processAlive(snapshot.supervisorPid)
    ) {
      return false;
    }
    await fs.writeFile(path.join(ipcDir, ServePackageSupervisor.RESTART_REQUEST_FILE), requester);
    return true;
  }

  /**
   * File a restart request with every live supervisor in the workspace (see requestRestart).
   * Unscoped on purpose: mapping "which supervised closure consumes the touched package"
   * requires app-specific server/ui closure knowledge; a spurious settled-state restart is
   * cheap and safe, a missed one is a silently broken dev server. Returns the packageNames
   * of supervisors that accepted a request.
   */
  static async requestWorkspaceRestarts(
    packageMap: Record<string, { filePath: string }>,
    requester: string
  ): Promise<string[]> {
    const requested: string[] = [];
    const seenDirs = new Set<string>();
    for (const [packageName, localPackage] of Object.entries(packageMap)) {
      const packageDir = path.dirname(localPackage.filePath);
      if (seenDirs.has(packageDir)) {
        continue;
      }
      seenDirs.add(packageDir);
      if (await ServePackageSupervisor.requestRestart(packageDir, requester)) {
        requested.push(packageName);
      }
    }
    return requested;
  }

  /** Stop the child and the poll loop (idempotent). Process exit is the caller's concern. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    if (this.bootSettleTimer) {
      clearTimeout(this.bootSettleTimer);
    }
    await this.killChild();
    await fs.rm(path.join(this.ipcDir, 'pid'), { force: true });
    this.setState('stopped');
  }

  /**
   * Two supervisors on one package dir would clobber each other's pid/state and wipe each
   * other's live holds on every spawn — refuse to start while another instance's pid is alive.
   */
  private async assertSingleInstance(): Promise<void> {
    const pidPath = path.join(this.ipcDir, 'pid');
    const raw = await fs.readFile(pidPath, 'utf-8').catch(() => undefined);
    const existingPid = raw ? Number(raw.trim()) : undefined;
    if (!existingPid) {
      return;
    }
    try {
      process.kill(existingPid, 0);
    } catch {
      return; // stale pid file from a dead supervisor — safe to take over
    }
    throw new Error(
      `Another serve-package instance (pid ${existingPid}) already supervises ${this.options.packageName} (${pidPath}). Stop it first, or force-restart it with: kill -USR2 ${existingPid}`
    );
  }

  // ── Poll loop ─────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.restarting || this.stopping) {
      return;
    }
    const now = Date.now();
    // Absorb a cross-process restart request (workspace-package after an npm op) as staleness:
    // it rides the same quiet window, holds, and coherence gate as a dist change.
    const requestPath = path.join(this.ipcDir, ServePackageSupervisor.RESTART_REQUEST_FILE);
    const requester = await fs.readFile(requestPath, 'utf-8').catch(() => undefined);
    if (requester !== undefined) {
      await fs.rm(requestPath, { force: true });
      this.lastChangeAt = now;
      const token = `requested by ${requester.trim() || 'unknown'}`;
      if (!this.stalePackages.has(token)) {
        this.stalePackages.add(token);
        if (this.state === 'running') {
          this.staleSince = now;
        }
        this.setState('stale');
        this.logger.warn({
          message: `> STALE — restart ${token} (node_modules were rebuilt under the running child; its watcher may serve a bundle compiled mid-op)`,
        });
      }
    }
    const newlyStale: string[] = [];
    for (const packageName of this.closure) {
      const current = await this.newestMtime(this.distDirs[packageName]);
      if (current > (this.baseline[packageName] ?? 0)) {
        this.lastChangeAt = now;
        this.baseline[packageName] = current; // advance so an ongoing build keeps refreshing lastChangeAt
        if (!this.stalePackages.has(packageName)) {
          this.stalePackages.add(packageName);
          newlyStale.push(packageName);
        }
      }
    }
    if (newlyStale.length > 0) {
      if (this.state === 'running') {
        this.staleSince = now;
      }
      this.setState('stale');
      this.logger.warn({
        message: `> STALE — new dist for: ${newlyStale.join(', ')} (running process still serves the old code)`,
      });
    }
    if (this.stalePackages.size === 0) {
      return;
    }
    if (now - this.lastChangeAt < this.quietMs()) {
      return; // build burst still settling
    }
    const holds = await this.activeHolds();
    if (holds.length > 0) {
      this.setState('waiting-holds');
      // Announce on holder-set changes, with a 30s heartbeat otherwise — keying on TTLs would
      // log every poll.
      const holderSet = holds
        .map((h) => h.holder)
        .sort()
        .join(', ');
      if (holderSet !== this.lastHoldReport || now - this.lastHoldAnnounceAt >= 30_000) {
        this.lastHoldReport = holderSet;
        this.lastHoldAnnounceAt = now;
        const report = holds
          .map((h) => `${h.holder} (${Math.round((h.expiresAt - Date.now()) / 1000)}s ttl)`)
          .join(', ');
        this.logger.warn({
          message: `> STALE ${Math.round((now - this.staleSince) / 1000)}s, restart held by: ${report} — 'rs' or SIGUSR2 to force`,
        });
      }
      return;
    }
    this.lastHoldReport = '';
    await this.restart(`stale: ${Array.from(this.stalePackages).join(', ')}`);
  }

  // ── Child lifecycle ───────────────────────────────────────────────────────

  private async spawnChild(viaRestart = false): Promise<void> {
    await this.clearHolds();
    await this.snapshotBaseline();
    this.stalePackages.clear();
    this.staleSince = 0;
    this.spawnedByRestart = viaRestart;
    this.spawnedAt = Date.now();
    const [cmd, ...args] = this.options.command;
    this.child = spawn(cmd, args, {
      cwd: this.packageDir,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, SERVE_PACKAGE_IPC: this.ipcDir },
      // Own process group, so killChild can signal the WHOLE tree — wrapper commands
      // (npm run dev → node server) would otherwise orphan the real server on restart,
      // leaving it squatting the port.
      detached: true,
    });
    this.setState('running');
    this.logger.info({ message: `> Started: ${this.options.command.join(' ')} (pid ${this.child.pid})` });
    // Surviving the boot window resets the retry budget — failures only count consecutively.
    if (this.bootSettleTimer) {
      clearTimeout(this.bootSettleTimer);
    }
    this.bootSettleTimer = setTimeout(() => {
      this.consecutiveBootFailures = 0;
    }, this.bootFailWindowMs());
    const child = this.child;
    child.on('error', (error) => {
      this.logger.error({ message: `> Failed to spawn '${this.options.command.join(' ')}'`, error });
      void this.stop().then(() => this.options.onChildExit?.(1));
    });
    child.on('exit', (code, signal) => {
      if (this.restarting || this.stopping) {
        return; // we initiated it
      }
      // A RESTART-spawned child dying nonzero inside the boot window is almost always a
      // mid-churn boot (a build landed between the coherence check and the child's own verify
      // gate — check-then-spawn is inherently racy). Killing the supervisor for that turns one
      // race into permanent downtime (observed 2026-07-29 11:30: server build settled, restart
      // fired, the sibling UI build was still running, child verify exited 1, supervisor died).
      // Retry through the coherence gate, bounded to 2 consecutive attempts — a genuinely
      // broken child still surfaces as the mirrored exit below.
      const bootAgeMs = Date.now() - this.spawnedAt;
      if (
        this.spawnedByRestart &&
        (code ?? 1) !== 0 &&
        bootAgeMs < this.bootFailWindowMs() &&
        this.consecutiveBootFailures < 2
      ) {
        this.consecutiveBootFailures += 1;
        this.logger.warn({
          message: `> Child failed to boot after a restart (code ${code}, ${Math.round(bootAgeMs / 1000)}s in) — likely a build landed mid-spawn; waiting for coherence and retrying (attempt ${this.consecutiveBootFailures}/2)`,
        });
        void this.restart('retry after failed post-restart boot').catch((e) => this.logger.error({ error: e }));
        return;
      }
      this.logger.error({
        message: `> Child exited on its own (${signal ?? `code ${code}`}) — mirroring plain-run semantics`,
      });
      void this.stop().then(() => this.options.onChildExit?.(code ?? 1));
    });
  }

  /**
   * Bounded kill: SIGTERM the group, escalate to SIGKILL after the grace period, and treat the
   * process table — not the 'exit' event — as the truth. Observed in the wild (2026-07-29): an
   * npm-wrapped child's whole group died on the group signal but the direct child's 'exit'
   * event never fired, wedging shutdown on an unbounded await and leaving a zombie supervisor
   * holding the pid file. Every stage here has a deadline.
   */
  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const pid = child.pid!;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    this.signalChildGroup(pid, 'SIGTERM');
    if (await this.settled(exited, this.graceMs())) {
      return;
    }
    this.signalChildGroup(pid, 'SIGKILL');
    if (await this.settled(exited, 2000)) {
      return;
    }
    if (!ServePackageSupervisor.processAlive(pid)) {
      this.logger.warn({
        message: `> Child pid ${pid} is dead but its exit event never fired — proceeding with shutdown`,
      });
      return;
    }
    this.logger.error({
      message: `> Child pid ${pid} survived SIGKILL (uninterruptible?) — proceeding; the next spawn will surface any port conflict`,
    });
  }

  /**
   * Poll the workspace doctor (scoped to this package's closure) until no findings remain,
   * announcing every 30s. Unbounded by design: the operator is mid-rebuild; the wait ends
   * when their build does. stop() interrupts it.
   */
  private async waitForCoherence(): Promise<void> {
    const doctor = new WorkspaceDoctor(this.workspacePathResolved);
    let lastAnnounceAt = 0;
    for (;;) {
      if (this.stopping) {
        return;
      }
      const findings = await doctor.diagnose(this.options.coherencePackages ?? [this.options.packageName]);
      if (findings.length === 0) {
        return;
      }
      const now = Date.now();
      if (now - lastAnnounceAt >= 30_000) {
        lastAnnounceAt = now;
        this.logger.warn({
          message: `> Holding restart: workspace incoherent (${findings.length} finding${findings.length !== 1 ? 's' : ''}: ${findings
            .map((f) => `${f.packageName} ${f.kind}`)
            .join(', ')}) — waiting for the build to finish`,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  /** Await a promise with a deadline; true if it settled in time. */
  private async settled(promise: Promise<void>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([promise.then(() => true), timedOut]);
    clearTimeout(timer);
    return result;
  }

  private static processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Signal the child's whole process group (it is spawned detached into its own group). */
  private signalChildGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      // group already gone
    }
  }

  // ── Holds ─────────────────────────────────────────────────────────────────

  private async activeHolds(): Promise<Hold[]> {
    const holdsDir = path.join(this.ipcDir, 'holds');
    const holds: Hold[] = [];
    const entries = await fs.readdir(holdsDir).catch(() => [] as string[]);
    for (const entry of entries) {
      const holdPath = path.join(holdsDir, entry);
      try {
        const hold = JSON.parse(await fs.readFile(holdPath, 'utf-8')) as Hold;
        if (typeof hold.expiresAt === 'number' && hold.expiresAt > Date.now()) {
          holds.push(hold);
        } else {
          await fs.rm(holdPath, { force: true }); // reap expired lease
        }
      } catch {
        // unreadable lease (partial write) — skip this cycle; TTL reaps it if it never heals
      }
    }
    return holds;
  }

  private async clearHolds(): Promise<void> {
    const holdsDir = path.join(this.ipcDir, 'holds');
    await fs.rm(holdsDir, { recursive: true, force: true });
    await fs.mkdir(holdsDir, { recursive: true });
  }

  private setState(state: SupervisorState): void {
    this.state = state;
    const snapshot = {
      state,
      supervisorPid: process.pid,
      childPid: this.child?.pid,
      packageName: this.options.packageName,
      stalePackages: Array.from(this.stalePackages),
      staleSince: this.staleSince || undefined,
    };
    void fs.writeFile(path.join(this.ipcDir, 'state.json'), JSON.stringify(snapshot, null, 2)).catch(() => undefined);
  }

  // ── Staleness ─────────────────────────────────────────────────────────────

  private async resolveClosure(metadata: WorkspaceMetadata): Promise<string[]> {
    const localPackage = metadata.packageMap[this.options.packageName];
    const deps = await PackageUtil.getTransitiveWorkspaceDependencies(localPackage, metadata.packageMap);
    return [this.options.packageName, ...deps];
  }

  private async snapshotBaseline(): Promise<void> {
    for (const packageName of this.closure) {
      this.baseline[packageName] = await this.newestMtime(this.distDirs[packageName]);
    }
    this.lastChangeAt = 0;
  }

  /** Newest mtime (ms) under a file or directory tree; 0 when absent. */
  private async newestMtime(targetPath: string): Promise<number> {
    let stat;
    try {
      stat = await fs.lstat(targetPath);
    } catch {
      return 0;
    }
    if (!stat.isDirectory()) {
      return stat.mtimeMs;
    }
    let newest = 0;
    const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const childNewest = await this.newestMtime(path.join(targetPath, entry.name));
      if (childNewest > newest) {
        newest = childNewest;
      }
    }
    return newest;
  }

  private pollMs(): number {
    return this.options.pollMs ?? 2000;
  }

  private quietMs(): number {
    return this.options.quietMs ?? 1500;
  }

  private graceMs(): number {
    return this.options.graceMs ?? 10000;
  }

  private bootFailWindowMs(): number {
    return this.options.bootFailWindowMs ?? 90_000;
  }
}
