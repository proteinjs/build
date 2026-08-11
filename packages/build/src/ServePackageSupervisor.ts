import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { PackageUtil, WorkspaceMetadata } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { WorkspaceDoctor, WorkspaceFinding } from './WorkspaceDoctor';
import { NodeModulesIdentityWatcher } from './NodeModulesIdentityWatcher';

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
  /**
   * How long an in-flight restart may make NO progress while no child is running before the
   * liveness watchdog abandons it and spawns a fresh child (default 60s). Measured against a
   * progress heartbeat, not elapsed time, so a legitimately long coherence wait never trips it.
   */
  restartStallMs?: number;
  /**
   * Deadline for one workspace diagnosis (default 30s) — applied everywhere the poll chain
   * diagnoses: the pre-kill coherence gate, the childless coherence wait, and recovery. A scan
   * that exceeds it is abandoned loudly and retried; it must never own the lane.
   */
  coherenceDeadlineMs?: number;
  /** Dist mtime poll interval. */
  pollMs?: number;
  /**
   * node_modules package-identity sample interval (default 7.5s — deliberately coarser than
   * pollMs: identity churn is rare and each sample stats every watched entry). See
   * NodeModulesIdentityWatcher for what a sample reads (and the dist non-goal it must not touch).
   */
  identityPollMs?: number;
  /** Quiet period after the last dist change before a restart is considered (builds settle). */
  quietMs?: number;
  /** Grace period between SIGTERM and SIGKILL when stopping the child. */
  graceMs?: number;
  /**
   * Initial delay before respawning a child that exited with RESTART_REQUEST_EXIT_CODE
   * (default 1s). Doubles per consecutive restart-requested exit, capped at 30s — the child is
   * deliberately down (waiting out a dependency outage), so respawns must pace themselves.
   */
  respawnBackoffMs?: number;
  /**
   * Consecutive restart-requested respawns granted WITHOUT a healthy period (a child alive
   * longer than bootFailWindowMs) before the supervisor mirrors the exit instead (default 5) —
   * a hot-crash loop must not spin forever.
   */
  maxConsecutiveRespawns?: number;
  /**
   * Called when the child exits on its own (not via a supervisor restart/stop). The CLI wires
   * this to process.exit(code) so plain-run semantics are preserved. Not called in daemon
   * posture — the daemon supervisor outlives its child (see `daemon`).
   */
  onChildExit?: (code: number) => void;
  /**
   * Daemon posture (the CLI sets this when the invocation was re-launched via --daemon): the
   * supervisor OUTLIVES a self-exiting child instead of mirroring its exit. A nonzero child
   * exit respawns through the coherence gate under an expiring budget (`crashRespawnLimit` per
   * `crashRespawnWindowMs`); a clean exit — or an exhausted budget — parks as state 'exited'
   * (exit code recorded in state.json) with the poll loop, SIGUSR2 (respawn), and SIGTERM
   * (clean shutdown) all still live. Plain-run mirroring made sense foregrounded; a daemon
   * that stays down all night — dead to SIGUSR2, state.json still claiming 'running' — does
   * not (observed 2026-08-06: the child OOM'd at 9:14 AM and recovery took SIGKILL + a manual
   * relaunch).
   */
  daemon?: boolean;
  /** Daemon posture: max crash respawns within `crashRespawnWindowMs` before parking as 'exited' (default 3). */
  crashRespawnLimit?: number;
  /** Daemon posture: rolling window for the crash-respawn budget (default 10 minutes). */
  crashRespawnWindowMs?: number;
};

type SupervisorState =
  | 'running'
  | 'stale'
  | 'waiting-holds'
  | 'waiting-coherence'
  | 'restarting'
  | 'failed'
  | 'stopped'
  | 'exited';

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
 * active HOLDS exist AND the workspace is coherent (the kill is gated on the same coherence the
 * spawn requires — killing first and waiting after turned "stale but serving" into unbounded
 * downtime); `rs` on stdin or SIGUSR2 forces a restart regardless. The supervisor is therefore
 * "attended" exactly while something is attending (a hold is alive) and automatic otherwise.
 *
 * Holds protocol (app-agnostic, portless): the child is spawned with SERVE_PACKAGE_IPC set to
 * a directory; anything may write TTL lease files under `<SERVE_PACKAGE_IPC>/holds/<name>.json`
 * shaped `{ "holder": string, "expiresAt": epochMs }` and refresh them while work is in flight
 * (an in-progress chat turn, a focused browser tab's dev heartbeat, the child's own
 * request-activity high-water lease — any real HTTP request defers restarts until the server
 * has been request-quiet for the lease's TTL). Expired leases are ignored
 * and reaped, so a crashed holder can never wedge the lane. Processes that never write holds
 * get plain announce-then-restart semantics. The holds dir is cleared on every spawn — leases
 * belong to the child that wrote them.
 *
 * Also written under SERVE_PACKAGE_IPC: `pid` (supervisor pid, for `kill -USR2 $(cat pid)`)
 * and `state.json` (queryable status: state, child pid, stale packages, active holds).
 *
 * LANE LIVENESS: the poll cadence is a self-re-arming timer chain (every tick arms the next
 * BEFORE doing any work) cross-checked against ipc filesystem activity — fs.watch on the ipc
 * and holds dirs revives the chain whenever a lease/request write lands while ticks are
 * overdue. Two independent continuation sources, because one is not enough: observed
 * 2026-08-04, the process-wide JS timer subsystem stopped scheduling (event loop and I/O
 * healthy, every timer dead), and the single poll interval this class then hung off died
 * silently mid waiting-holds — no reap, no announce, no restart for 7 hours while holders
 * kept writing leases. A watchdog timer would have died with it; the fs.watch channel does
 * not ride timers, and one fresh setTimeout from it restores the whole chain. For the same
 * reason no await in the poll chain may be unbounded: every workspace diagnosis is deadlined.
 *
 * RESTART-REQUESTED EXITS: a child that exits with RESTART_REQUEST_EXIT_CODE (86) is asking
 * for a supervised respawn — the contract for liveness monitors inside the child that give up
 * on a dependency (db, cache) and want a fresh process once it heals. The supervisor respawns
 * it with bounded backoff (respawnBackoffMs doubling per consecutive request, capped at 30s)
 * and gives up honestly after maxConsecutiveRespawns requests without a healthy period
 * (bootFailWindowMs alive), so a hot-crash loop cannot spin. The pending respawn is carried by
 * BOTH a timer and the poll chain (a due respawn runs from enforceChildLiveness), so it
 * survives the observed timer-subsystem death like every other lane.
 *
 * Every OTHER self-exit mirrors plain-run semantics ATOMICALLY: endSupervision is synchronous
 * end-to-end — pid file removed, state.json finalized ('exited'), THEN the exit code is
 * mirrored — because the mirror path runs exactly when things are already wrong (dead child,
 * dead timers, wedged event loop) and must not depend on any async machinery completing.
 * Observed 2026-08-06/07: the async version logged the mirror, parked in cleanup, and lingered
 * as a zombie holding the pid file with state.json stale-claiming `running` — which then made
 * the next relaunch silently fail on the single-instance guard.
 *
 * NODE_MODULES IDENTITY CHURN: the child's own coherence gate runs only at boot, so a live
 * child's webpack watcher recompiles across npm-install/symlink-workspace node_modules churn
 * with boot-time loader config — raw-TS "Module parse failed" bundles with no gate in sight
 * (the cooperative restart-request above covers workspace-package ops, but a bare npm i files
 * nothing). The supervisor closes the blind spot itself: a coarse poll (identityPollMs) of the
 * closure's symlink-set fingerprint via NodeModulesIdentityWatcher, and a fingerprint change is
 * absorbed EXACTLY like a dist change — stale banner, quiet window, holds, coherence gate,
 * restart. Watching dist contents is that watcher's explicit non-goal; dist churn keeps flowing
 * through webpack/HMR and the mtime watch untouched.
 *
 * The child owns its own coherence gate (chain verify-workspace in the package's serve script);
 * the supervisor owns only process freshness.
 */
export class ServePackageSupervisor {
  /**
   * Exit-code contract for DELIBERATE child restarts: a child exiting with this code is asking
   * its supervisor for a respawn (see the class doc's RESTART-REQUESTED EXITS paragraph). 86 is
   * far from the codes node and shells reserve (1–13, 126–128+n) and reads as intent ("86 it").
   * Children hard-code the number — the contract crosses a process boundary, like a signal.
   */
  static readonly RESTART_REQUEST_EXIT_CODE = 86;
  /** Cross-process restart-request lease consumed by the poll loop (see requestRestart). */
  private static readonly RESTART_REQUEST_FILE = 'restart-request';
  /** Respawn attempts after a failed restart before supervision honestly gives up. */
  private static readonly MAX_RECOVERY_ATTEMPTS = 3;
  /** Ceiling for the doubling restart-requested respawn backoff. */
  private static readonly MAX_RESPAWN_BACKOFF_MS = 30_000;

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
  // Tick chain + its independent cross-check (see the class doc's LANE LIVENESS paragraph):
  // tickTimer is re-armed at the START of every tick; lastTickAt is the chain's heartbeat; the
  // ipc watchers revive the chain from lease/request writes when that heartbeat goes stale.
  private tickTimer?: NodeJS.Timeout;
  private lastTickAt = 0;
  private ipcWatchers: fsSync.FSWatcher[] = [];
  // start() has run: signals may act. Before it there is nothing to restart into; after a
  // child self-exit there is no live child, but a restart must still be able to spawn one.
  private started = false;
  /** Last self-exit of a child (cleared on spawn); surfaces as exitCode/exitSignal in state.json. */
  private lastChildExit?: { code: number | null; signal: NodeJS.Signals | null };
  /** Timestamps of daemon-posture crash respawns inside the rolling budget window. */
  private crashRespawnAt: number[] = [];
  // node_modules identity watch (see the class doc's NODE_MODULES IDENTITY CHURN paragraph):
  // sampled from the poll chain at its own coarser cadence; the in-flight guard keeps
  // overlapping poll ticks from stacking fs scans, mirroring the coherence check's guard.
  private identityWatcher!: NodeModulesIdentityWatcher;
  private lastIdentitySampleAt = 0;
  private identitySampleInFlight = false;
  private lastHoldReport = '';
  private lastHoldAnnounceAt = 0;
  private lastCoherenceAnnounceAt = 0;
  private coherenceCheckInFlight = false;
  // Liveness invariant (see enforceChildLiveness): a restart chain stamps its generation and
  // heartbeats its progress, so a chain that stalls between kill and spawn is detectable —
  // and recoverable — instead of silently owning the lane forever.
  private restartGeneration = 0;
  private restartProgressAt = 0;
  private childlessSince = 0;
  // Set when OUR OWN restart ended with no child (the spawn threw). The watchdog reads it to
  // tell "we lost our child" (retry) from "someone killed our child" (mirror, never resurrect) —
  // the `restarting` flag alone can't: it is already false by the time the watchdog next ticks.
  private lostChildToFailedRestart = false;
  private recoveryAttempts = 0;
  private ipcDir!: string;
  private workspacePathResolved!: string;
  // Boot-retry accounting for RESTART-spawned children (see the exit handler): whether the
  // current child came from restart(), when it was spawned, how many consecutive spawns died
  // inside the boot window, and the timer that declares a child successfully booted.
  private spawnedByRestart = false;
  private spawnedAt = 0;
  private consecutiveBootFailures = 0;
  private bootSettleTimer?: NodeJS.Timeout;
  // Restart-requested respawn accounting (see the class doc's RESTART-REQUESTED EXITS
  // paragraph): the consecutive-request streak (reset by a healthy period, measured off
  // spawnedAt so no timer is load-bearing), when the pending respawn is due, and the backoff
  // timer that normally runs it — the poll chain is the backstop when that timer dies.
  private consecutiveRespawns = 0;
  private respawnDueAt = 0;
  private respawnTimer?: NodeJS.Timeout;

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
    this.identityWatcher = new NodeModulesIdentityWatcher(
      workspacePath,
      this.options.coherencePackages ?? [this.options.packageName]
    );
    this.ipcDir = path.join(this.packageDir, '.serve-package');
    await this.assertSingleInstance();
    await fs.mkdir(path.join(this.ipcDir, 'holds'), { recursive: true });
    await fs.writeFile(path.join(this.ipcDir, 'pid'), `${process.pid}\n`);
    // A request left behind for a dead supervisor is already satisfied by this fresh boot.
    await fs.rm(path.join(this.ipcDir, ServePackageSupervisor.RESTART_REQUEST_FILE), { force: true });
    this.logger.info({
      message: `> Watching dists of ${this.closure.length} workspace packages (closure of ${this.options.packageName}); restart triggers: dist change or node_modules identity churn (sampled every ${this.identityPollMs()}ms) + quiet ${this.quietMs()}ms + no holds + coherent workspace, or 'rs' / SIGUSR2`,
    });
    this.started = true;
    await this.spawnChild();
    this.lastTickAt = Date.now();
    this.startIpcWatchers();
    this.armTick();
  }

  /** Force a restart now, regardless of staleness or holds. */
  async restart(reason: string): Promise<void> {
    // !this.started rejects signals delivered before start() has spawned anything. A DEAD
    // child is no reason to refuse: post-self-exit (daemon posture parks as 'exited') a
    // SIGUSR2 restart is exactly how a fresh child gets spawned — killChild guards on child
    // liveness itself, so this path never awaits a stop that cannot complete.
    if (this.restarting || this.stopping || !this.started) {
      return;
    }
    this.restarting = true;
    // Generation stamp: if the liveness watchdog gives up on this chain and starts a fresh one,
    // this (possibly still-parked) chain must never spawn a second child behind its back.
    const generation = ++this.restartGeneration;
    this.touchRestartProgress();
    try {
      // Inside the try so nothing that runs after the latch can escape the finally that clears
      // it — a throw between latch and try would disable every future restart, permanently.
      this.setState('restarting');
      this.logger.info({ message: `> Restarting (${reason})` });
      await this.killChild();
      this.touchRestartProgress();
      // stop() may have raced in while the child was dying — respawning after stop() resolved
      // would leak a live, unsupervised child.
      if (this.stopping || this.restartGeneration !== generation) {
        return;
      }
      // Never spawn into an incoherent workspace: a restart triggered mid-BUILD would boot a
      // child whose own verify gate exits 1, and mirroring that exit killed the supervisor —
      // a rebuild-in-progress became permanent downtime (observed 2026-07-29). Coherence is
      // moments away by definition (a build is running); wait for it.
      await this.waitForCoherence();
      if (this.stopping || this.restartGeneration !== generation) {
        return;
      }
      await this.spawnChild(true);
      this.touchRestartProgress();
    } catch (error) {
      // The child is already dead at this point: an escaping error means NOTHING IS SERVING.
      // Pre-2026-08-04 this rejected into the caller's `void supervisor.restart(...)` — no log,
      // no honest state — and the watchdog below is what now recovers it.
      this.logger.error({
        message: `> Restart FAILED after the child was stopped — no child is running; recovering on the next poll`,
        error: error as Error,
      });
      if (this.restartGeneration === generation) {
        this.lostChildToFailedRestart = true; // OUR failure — the watchdog must retry, not mirror
        this.setState('failed');
      }
    } finally {
      // Without this, one throw in kill/spawn would leave restarting=true forever and
      // permanently disable every future restart, including rs/SIGUSR2. Only the generation
      // that still owns the lane may clear it — a superseded chain must not unlatch its successor.
      if (this.restartGeneration === generation) {
        this.restarting = false;
      }
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
  /**
   * Re-launch a serve-package invocation as a DETACHED daemon so the supervisor survives its
   * launching shell/session (a terminal closing, an agent harness reaping its background task
   * tree — observed 2026-08-05: a session ending SIGKILLed the supervisor mid-state-write).
   * The daemon logs to `<packageDir>/.serve-package/serve.log` (previous log rotated to
   * `serve.log.prev`), discoverable next to `pid`/`state.json`. Returns the daemon's pid and
   * log path; the caller (the CLI's --daemon branch) prints them and exits.
   */
  static async daemonize(options: {
    packageName: string;
    /**
     * argv to re-run detached (script path + args), passed to process.execPath — with
     * `--daemon` replaced by `--daemonized` so the re-launched supervisor adopts the daemon
     * posture (crash respawns, signal-responsive after child death) instead of daemonizing
     * again or mirroring child exits plain-run style.
     */
    argv: string[];
    workspacePath?: string;
  }): Promise<{ pid: number; logPath: string }> {
    const workspacePath = options.workspacePath ?? (await WorkspaceDoctor.findWorkspaceRoot(process.cwd()));
    const metadata = await PackageUtil.getWorkspaceMetadata(workspacePath);
    const localPackage = metadata.packageMap[options.packageName];
    if (!localPackage) {
      throw new Error(`Package (${options.packageName}) does not exist in workspace: ${workspacePath}`);
    }
    const ipcDir = path.join(path.dirname(localPackage.filePath), '.serve-package');
    await fs.mkdir(ipcDir, { recursive: true });
    const logPath = path.join(ipcDir, 'serve.log');
    await fs.rename(logPath, `${logPath}.prev`).catch(() => undefined);
    const log = await fs.open(logPath, 'a');
    try {
      const daemon = spawn(process.execPath, options.argv, {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        cwd: process.cwd(),
        env: process.env,
      });
      daemon.unref();
      return { pid: daemon.pid!, logPath };
    } finally {
      // The daemon holds its own dup of the fd from spawn; ours must not leak.
      await log.close();
    }
  }

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
      snapshot.state === 'exited' ||
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
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    for (const watcher of this.ipcWatchers) {
      watcher.close();
    }
    this.ipcWatchers = [];
    if (this.bootSettleTimer) {
      clearTimeout(this.bootSettleTimer);
    }
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
    }
    await this.killChild();
    // Sync, like every exit path: no exit may leave a pid file behind (zombie-shape guard).
    fsSync.rmSync(path.join(this.ipcDir, 'pid'), { force: true });
    // Callers exit the process right after stop() resolves — setState writes synchronously, so
    // the final state is on disk by then (wedge #6 class).
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

  /**
   * One tick: heartbeat, arm the NEXT tick, then run the poll. Arming comes FIRST and
   * unconditionally — no outcome of this tick (a throw, an early return, a parked await inside
   * an in-flight restart) can end the cadence, and overlapping polls are by design: the
   * liveness watchdog needs ticks WHILE a restart chain is parked.
   */
  private tick(): void {
    this.lastTickAt = Date.now();
    this.armTick();
    void this.poll().catch((e) => this.logger.error({ error: e }));
  }

  private armTick(): void {
    if (this.stopping) {
      return;
    }
    this.tickTimer = setTimeout(() => this.tick(), this.pollMs());
  }

  /**
   * The tick chain's independent revival source (see the class doc's LANE LIVENESS paragraph).
   * fs.watch rides the platform's file-event channel, not JS timers, so it survives the
   * observed timer-subsystem death — and the writes it reports (lease renewals, restart
   * requests) arrive exactly while someone is depending on this supervisor. Cheap and
   * idempotent: while ticks are healthy every event is two comparisons.
   */
  private startIpcWatchers(): void {
    for (const dir of [this.ipcDir, path.join(this.ipcDir, 'holds')]) {
      const watcher = fsSync.watch(dir, { persistent: false }, () => this.onIpcActivity());
      // Without a listener an FSWatcher 'error' (e.g. the dir removed under us) would crash the
      // process; the tick chain still covers the lane, so log and carry on.
      watcher.on('error', (error) => this.logger.error({ message: `> ipc watcher failed (${dir})`, error }));
      this.ipcWatchers.push(watcher);
    }
  }

  private onIpcActivity(): void {
    if (this.stopping) {
      return;
    }
    const sinceLastTick = Date.now() - this.lastTickAt;
    if (sinceLastTick < this.tickStallMs()) {
      return; // the chain is ticking — cadence stays timer-driven
    }
    this.logger.error({
      message: `> Poll tick chain STALLED (no tick for ${Math.round(sinceLastTick / 1000)}s) — reviving from ipc activity; a fresh timer restores the cadence`,
    });
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.tick();
  }

  private async poll(): Promise<void> {
    // FIRST, unconditionally: the supervisor must never sit with no child while believing it
    // has one. This runs BEFORE the restarting/stopping early-return precisely because the
    // wedge class lives inside an in-flight restart.
    await this.enforceChildLiveness();
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
    // node_modules PACKAGE-IDENTITY churn rides the same stale path as a dist change (see the
    // class doc paragraph). Latched, not endpoint-compared: churn that settles back to the
    // boot-time fingerprint (npm i then re-symlink) still restarts — the child compiled
    // through the hole and its broken bundle would otherwise stick.
    if (!this.identitySampleInFlight && now - this.lastIdentitySampleAt >= this.identityPollMs()) {
      this.identitySampleInFlight = true;
      this.lastIdentitySampleAt = now;
      let changed: string[];
      try {
        changed = await this.identityWatcher.sampleChanged();
      } finally {
        this.identitySampleInFlight = false;
      }
      if (this.restarting || this.stopping) {
        return; // a forced restart or stop raced in while sampling
      }
      if (changed.length > 0) {
        this.lastChangeAt = Date.now();
        const token = 'node_modules package identity';
        if (!this.stalePackages.has(token)) {
          this.stalePackages.add(token);
          if (this.state === 'running') {
            this.staleSince = now;
          }
          this.setState('stale');
          this.logger.warn({
            message: `> STALE — node_modules package identity changed under the running child: ${changed.join(', ')} (its watcher compiles with boot-time loader config; the bundle may be broken until a restart)`,
          });
        }
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
    // Gate the KILL on the same coherence the spawn requires. restart() only re-checks
    // coherence AFTER the child is dead, so an automatic restart firing mid-rebuild (or into
    // an agent-clobbered workspace) turned "stale but serving" into unbounded downtime
    // (observed 2026-08-01: child killed at 1:08 AM, workspace incoherent until 11:03 AM —
    // dead server for ~10 hours). A stale child that keeps serving old code is strictly
    // better than no child; rs/SIGUSR2 still bypass via restart() directly.
    if (this.coherenceCheckInFlight) {
      return; // diagnose from the previous tick is still running — don't stack fs scans
    }
    this.coherenceCheckInFlight = true;
    let findings: WorkspaceFinding[] | undefined;
    try {
      // Deadlined: this await sits directly in the poll chain, and its in-flight guard above
      // short-circuits every later tick — an unbounded hang here would end automatic restarts
      // permanently while the guard advertises nothing. The abandoned scan is read-only.
      findings = await this.withDeadline(
        new WorkspaceDoctor(this.workspacePathResolved).diagnose(
          this.options.coherencePackages ?? [this.options.packageName]
        ),
        this.coherenceDeadlineMs()
      );
    } finally {
      this.coherenceCheckInFlight = false;
    }
    if (this.restarting || this.stopping) {
      return; // a forced restart or stop raced in while diagnosing
    }
    if (findings === undefined) {
      if (Date.now() - this.lastCoherenceAnnounceAt >= 30_000) {
        this.lastCoherenceAnnounceAt = Date.now();
        this.logger.error({
          message: `> Workspace diagnosis exceeded ${Math.round(this.coherenceDeadlineMs() / 1000)}s — abandoning it and retrying next poll; the stale restart stays pending`,
        });
      }
      return;
    }
    if (findings.length > 0) {
      this.setState('waiting-coherence');
      if (Date.now() - this.lastCoherenceAnnounceAt >= 30_000) {
        this.lastCoherenceAnnounceAt = Date.now();
        this.logger.warn({
          message: `> STALE ${Math.round((Date.now() - this.staleSince) / 1000)}s, restart blocked: workspace incoherent (${findings.length} finding${findings.length !== 1 ? 's' : ''}: ${findings
            .map((f) => `${f.packageName} ${f.kind}`)
            .join(', ')}) — keeping the running child alive until the build finishes`,
        });
      }
      return;
    }
    this.lastCoherenceAnnounceAt = 0;
    await this.restart(`stale: ${Array.from(this.stalePackages).join(', ')}`);
  }

  // ── Child lifecycle ───────────────────────────────────────────────────────

  /**
   * LIVENESS INVARIANT: either a live child is serving, or the supervisor is deliberately down
   * and says so. Never "alive, believes it has a child, has none" — the 2026-08-04 wedge, where
   * a SIGUSR2 restart killed its child at 2:52:17 PM, the spawn never happened, and the
   * supervisor sat childless for 15+ minutes still advertising `state: running, childPid: 29503`
   * (a dead pid). Nothing could recover it: the stalled chain never reached the `finally` that
   * clears `restarting`, so every later SIGUSR2 / `rs` / staleness restart silently no-opped on
   * the re-entrancy guard, by construction.
   *
   * The process table is the truth (`kill(pid, 0)`), and INTENT decides the response:
   *  - not our doing (no restart/stop in flight) — the child vanished without its 'exit' event
   *    ever firing (the documented npm-wrapper class). Mirror plain-run semantics and stay down:
   *    an externally killed child must never be resurrected.
   *  - our own restart lost its child — recover. Gated on PROGRESS staleness, not elapsed time,
   *    so a legitimately long coherence wait (which heartbeats every ~2s) is never mistaken for
   *    a stall; only a chain that has stopped making progress is abandoned and replaced.
   */
  private async enforceChildLiveness(): Promise<void> {
    if (this.stopping || !this.child?.pid) {
      return;
    }
    if (ServePackageSupervisor.processAlive(this.child.pid)) {
      this.childlessSince = 0;
      return;
    }
    const pid = this.child.pid;
    const now = Date.now();
    if (!this.childlessSince) {
      this.childlessSince = now;
    }
    // A pending restart-requested respawn: the child is down ON PURPOSE (backoff pacing a
    // deliberate exit), so this is neither a vanished child nor a stalled restart. Once the
    // backoff is due, run the respawn from the poll chain too — the backoff timer alone must
    // not carry the lane (the observed timer-subsystem death class).
    if (this.respawnDueAt) {
      if (now < this.respawnDueAt) {
        return;
      }
      this.childlessSince = 0;
      await this.respawnNow();
      return;
    }
    if (!this.restarting) {
      if (this.lostChildToFailedRestart) {
        // WE killed it and then failed to replace it — a transient spawn failure (EAGAIN/EMFILE)
        // must not end supervision. Bounded so a permanently unspawnable child still surfaces.
        if (this.recoveryAttempts >= ServePackageSupervisor.MAX_RECOVERY_ATTEMPTS) {
          this.logger.error({
            message: `> Could not respawn after ${this.recoveryAttempts} attempts — giving up and mirroring plain-run semantics`,
          });
          this.setState('failed');
          this.endSupervision(1);
          return;
        }
        this.recoveryAttempts += 1;
        this.logger.warn({
          message: `> No child is running after a failed restart — respawning (attempt ${this.recoveryAttempts}/${ServePackageSupervisor.MAX_RECOVERY_ATTEMPTS})`,
        });
        this.childlessSince = 0;
        await this.recoverChild();
        return;
      }
      this.logger.error({
        message: `> Child pid ${pid} is GONE but its exit event never fired — mirroring plain-run semantics (an externally killed child is never resurrected)`,
      });
      this.setState('failed');
      this.endSupervision(1);
      return;
    }
    if (now - this.restartProgressAt < this.restartStallMs()) {
      return; // a restart is genuinely in flight (killing, waiting for coherence, spawning)
    }
    this.logger.error({
      message: `> Restart STALLED — no child has been running for ${Math.round((now - this.childlessSince) / 1000)}s and the restart made no progress for ${Math.round((now - this.restartProgressAt) / 1000)}s; abandoning that attempt and spawning a fresh child`,
    });
    this.childlessSince = 0;
    await this.recoverChild();
  }

  /**
   * Get a child serving again after a stalled restart. Every step is BOUNDED and it always ends
   * in a spawn or an honest `failed` state — recovery must never re-enter the step that stalled
   * (routing back through restart() would just park on the same unbounded coherence wait).
   *
   * Coherence is advisory here rather than blocking: nothing is serving, so a child on possibly
   * stale code strictly beats no child, and a genuinely unbootable one still surfaces through
   * the existing boot-retry → mirrored-exit path.
   */
  private async recoverChild(): Promise<void> {
    // Bumping the generation makes the abandoned chain's eventual spawn a no-op.
    const generation = ++this.restartGeneration;
    this.restarting = true;
    this.touchRestartProgress();
    this.setState('restarting');
    try {
      await this.killChild(); // no-op when already dead; reaps a half-dead child
      this.touchRestartProgress();
      const findings = await this.withDeadline(
        new WorkspaceDoctor(this.workspacePathResolved).diagnose(
          this.options.coherencePackages ?? [this.options.packageName]
        ),
        this.coherenceDeadlineMs()
      );
      this.touchRestartProgress();
      if (findings === undefined) {
        this.logger.warn({
          message: `> Recovery: workspace diagnosis timed out — spawning anyway (nothing is serving)`,
        });
      } else if (findings.length > 0) {
        this.logger.warn({
          message: `> Recovery: workspace is incoherent (${findings.length} finding${findings.length !== 1 ? 's' : ''}: ${findings
            .map((f) => `${f.packageName} ${f.kind}`)
            .join(', ')}) — spawning anyway (nothing is serving; a stale child beats no child)`,
        });
      }
      if (this.stopping || this.restartGeneration !== generation) {
        return;
      }
      await this.spawnChild(true);
      this.touchRestartProgress();
    } catch (error) {
      this.logger.error({
        message: `> Recovery spawn FAILED — no child is running; retrying on the next poll`,
        error: error as Error,
      });
      if (this.restartGeneration === generation) {
        this.lostChildToFailedRestart = true;
        this.setState('failed');
      }
    } finally {
      if (this.restartGeneration === generation) {
        this.restarting = false;
      }
    }
  }

  private touchRestartProgress(): void {
    this.restartProgressAt = Date.now();
  }

  /**
   * A child exited with RESTART_REQUEST_EXIT_CODE: schedule a respawn with bounded backoff.
   * The streak counter resets whenever the exiting child had a HEALTHY PERIOD (alive longer
   * than bootFailWindowMs) — the dependency-outage loop (child serves for minutes, its monitor
   * trips, exit, respawn) therefore never accumulates toward the cap; only a hot-crash loop
   * (restart-requested exits faster than the boot window, maxConsecutiveRespawns in a row)
   * exhausts it and gets mirrored like any other death.
   */
  private onRestartRequestedExit(): void {
    const aliveMs = Date.now() - this.spawnedAt;
    if (aliveMs >= this.bootFailWindowMs()) {
      this.consecutiveRespawns = 0; // healthy period: a fresh streak
    }
    this.consecutiveRespawns += 1;
    if (this.consecutiveRespawns > this.maxConsecutiveRespawns()) {
      this.logger.error({
        message: `> Child requested a restart (exit ${ServePackageSupervisor.RESTART_REQUEST_EXIT_CODE}) ${this.consecutiveRespawns} times in a row without a healthy period — hot-crash loop; giving up and mirroring the exit`,
      });
      this.endSupervision(ServePackageSupervisor.RESTART_REQUEST_EXIT_CODE);
      return;
    }
    const backoffMs = Math.min(
      this.respawnBackoffMs() * 2 ** (this.consecutiveRespawns - 1),
      ServePackageSupervisor.MAX_RESPAWN_BACKOFF_MS
    );
    this.logger.warn({
      message: `> Child requested a restart (exit ${ServePackageSupervisor.RESTART_REQUEST_EXIT_CODE}, ${Math.round(aliveMs / 1000)}s alive) — respawning in ${backoffMs}ms (request ${this.consecutiveRespawns}/${this.maxConsecutiveRespawns()})`,
    });
    this.respawnDueAt = Date.now() + backoffMs;
    this.setState('restarting');
    // The poll chain is the backstop: enforceChildLiveness runs a DUE respawn even if this
    // timer dies with the timer subsystem (the observed 2026-08-04 class).
    this.respawnTimer = setTimeout(
      () => void this.respawnNow().catch((e) => this.logger.error({ error: e })),
      backoffMs
    );
  }

  /**
   * Run the pending restart-requested respawn. Guarded on respawnDueAt so the two carriers
   * (backoff timer, poll chain) and any interleaved spawn (rs/SIGUSR2 during the backoff park
   * clears the pending respawn — see spawnChild) can never double-spawn.
   */
  private async respawnNow(): Promise<void> {
    if (!this.respawnDueAt || this.stopping || this.restarting) {
      return;
    }
    this.respawnDueAt = 0;
    await this.recoverChild();
  }

  /**
   * End supervision and mirror an exit code through onChildExit. SYNCHRONOUS end-to-end, by
   * design: this path runs exactly when things are already wrong (dead child, dead timers, a
   * wedged event loop), so it must not depend on any async machinery completing. The prior
   * version routed through the async stop() chain and produced the observed zombie — mirror
   * logged, cleanup parked, supervisor lingering with a pid file and a state.json claiming
   * `running`, which then made the next relaunch silently fail on the single-instance guard.
   * By the time onChildExit (process.exit in the CLI) runs, the pid file is gone and state.json
   * says `exited` — the zombie shape is unrepresentable.
   */
  private endSupervision(code: number): void {
    this.stopping = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    if (this.bootSettleTimer) {
      clearTimeout(this.bootSettleTimer);
    }
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
    }
    for (const watcher of this.ipcWatchers) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    this.ipcWatchers = [];
    // The direct child is already dead on every path here, but its process GROUP can outlive
    // it (the documented npm-wrapper class) — sync best-effort sweep so nothing squats the
    // port after the supervisor is gone.
    if (this.child?.pid) {
      this.signalChildGroup(this.child.pid, 'SIGKILL');
    }
    try {
      fsSync.rmSync(path.join(this.ipcDir, 'pid'), { force: true });
    } catch {
      // best-effort: a leftover pid file from a dead process fails the alive-check on relaunch
    }
    this.setState('exited');
    this.options.onChildExit?.(code);
  }

  private async spawnChild(viaRestart = false): Promise<void> {
    // ANY spawn satisfies a pending restart-requested respawn (a forced rs/SIGUSR2 restart may
    // land during the backoff park) — clear it so the parked timer can't double-spawn.
    this.respawnDueAt = 0;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = undefined;
    }
    await this.clearHolds();
    await this.snapshotBaseline();
    // The child boots through its own verify gate, so whatever identity the workspace has RIGHT
    // NOW is what it compiles against — churn history before this spawn is absorbed.
    await this.identityWatcher.baseline();
    this.stalePackages.clear();
    this.staleSince = 0;
    this.spawnedByRestart = viaRestart;
    this.spawnedAt = Date.now();
    this.lastChildExit = undefined;
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
    // A child is serving again: the failed-restart recovery budget resets.
    this.lostChildToFailedRestart = false;
    this.recoveryAttempts = 0;
    this.childlessSince = 0;
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
      this.endSupervision(1);
    });
    child.on('exit', (code, signal) => {
      if (this.restarting || this.stopping) {
        return; // we initiated it
      }
      // The child is gone: drop the handle so state.json never advertises a dead childPid,
      // and so restart paths (killChild) see there is nothing to stop.
      this.child = undefined;
      this.lastChildExit = { code, signal };
      // A deliberate restart-requested exit is never a crash and never a boot failure — it is
      // the child invoking the respawn contract. Checked FIRST so the boot-fail heuristic below
      // can't misread it.
      if (code === ServePackageSupervisor.RESTART_REQUEST_EXIT_CODE) {
        this.onRestartRequestedExit();
        return;
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
      if (this.options.daemon) {
        this.handleDaemonChildExit(code, signal);
        return;
      }
      this.logger.error({
        message: `> Child exited on its own (${signal ?? `code ${code}`}) — mirroring plain-run semantics`,
      });
      this.endSupervision(code ?? 1);
    });
  }

  /**
   * Daemon posture: the supervisor OUTLIVES a self-exiting child. A crash (nonzero/signal
   * exit) respawns through the coherence gate under the expiring budget; a clean exit or an
   * exhausted budget parks as 'exited' (exit recorded in state.json) with the poll loop and
   * SIGUSR2/SIGTERM still live — recovery is one signal (or one fresh build) away instead of
   * SIGKILL + a manual relaunch.
   */
  private handleDaemonChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    const description = signal ?? `code ${code}`;
    const crashed = (code ?? 1) !== 0;
    if (crashed && this.consumeCrashRespawnBudget()) {
      this.logger.warn({
        message: `> Child crashed (${description}) — respawning (${this.crashRespawnAt.length}/${this.crashRespawnLimit()} respawns in the last ${Math.round(this.crashRespawnWindowMs() / 60_000)}m)`,
      });
      void this.restart(`respawn after child crash (${description})`).catch((e) => this.logger.error({ error: e }));
      return;
    }
    this.logger.error({
      message: crashed
        ? `> Child crashed (${description}) and the respawn budget (${this.crashRespawnLimit()} per ${Math.round(this.crashRespawnWindowMs() / 60_000)}m) is exhausted — parked as 'exited'; SIGUSR2 respawns, SIGTERM shuts down`
        : `> Child exited cleanly (${description}) — parked as 'exited'; SIGUSR2 respawns, SIGTERM shuts down`,
    });
    this.setState('exited');
  }

  /** True when a crash respawn is still inside the rolling budget (and consumes one slot). */
  private consumeCrashRespawnBudget(): boolean {
    const now = Date.now();
    this.crashRespawnAt = this.crashRespawnAt.filter((at) => now - at < this.crashRespawnWindowMs());
    if (this.crashRespawnAt.length >= this.crashRespawnLimit()) {
      return false;
    }
    this.crashRespawnAt.push(now);
    return true;
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
    // Child already dead at the OS level but its 'exit' event hasn't been delivered yet (a
    // self-exit racing this restart/stop): nothing to signal, no grace cycle to serve on a
    // corpse — absorb the imminent event briefly and move on.
    if (!ServePackageSupervisor.processAlive(pid)) {
      await this.settled(exited, 2000);
      return;
    }
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
      this.touchRestartProgress();
      // Deadline every diagnosis: this await sits between the kill and the spawn with NOTHING
      // logged before its first result, so a hang here is exactly the silent childless wedge.
      // A timeout is loud and retried (the scan is read-only; an abandoned one is harmless).
      const findings = await this.withDeadline(
        doctor.diagnose(this.options.coherencePackages ?? [this.options.packageName]),
        this.coherenceDeadlineMs()
      );
      this.touchRestartProgress();
      if (findings === undefined) {
        this.logger.error({
          message: `> Workspace diagnosis exceeded ${Math.round(this.coherenceDeadlineMs() / 1000)}s while no child is running — retrying (the restart is holding here, nothing is being served)`,
        });
        continue;
      }
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

  /** Await a value with a deadline; undefined when the deadline wins (the work keeps running). */
  private async withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    });
    const result = await Promise.race([promise, timedOut]);
    clearTimeout(timer);
    return result;
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
    // Empty the CONTENTS, never the dir: the ipc watcher holds its identity on the holds dir,
    // and fs.watch goes silently dead when its target is deleted and recreated.
    const holdsDir = path.join(this.ipcDir, 'holds');
    await fs.mkdir(holdsDir, { recursive: true });
    for (const entry of await fs.readdir(holdsDir).catch(() => [] as string[])) {
      await fs.rm(path.join(holdsDir, entry), { recursive: true, force: true });
    }
  }

  private setState(state: SupervisorState): void {
    this.state = state;
    const snapshot = {
      state,
      supervisorPid: process.pid,
      childPid: this.child?.pid,
      // Truth about the last self-exit (wedge #6): present while state is 'exited', cleared on
      // the next spawn. `?? undefined` folds a null code (signal death) out of the JSON.
      exitCode: this.lastChildExit?.code ?? undefined,
      exitSignal: this.lastChildExit?.signal ?? undefined,
      packageName: this.options.packageName,
      stalePackages: Array.from(this.stalePackages),
      staleSince: this.staleSince || undefined,
    };
    // SYNCHRONOUS write-then-rename. state.json is the one artifact an operator inspects when
    // things are wrong, so it must not be able to lie: the async version left the file
    // advertising `running` with a dead childPid through the entire 2026-08-04 wedge (the
    // transition was issued, but its completion callback needed an event loop that had stopped
    // turning). A truncate+write could also be read back empty cross-process (2026-08-02).
    const statePath = path.join(this.ipcDir, 'state.json');
    const tmpPath = `${statePath}.tmp-${process.pid}`;
    try {
      fsSync.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
      fsSync.renameSync(tmpPath, statePath);
    } catch {
      // best-effort: state.json is diagnostics, never a control input for this process
    }
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

  /** node_modules package-identity sample interval (coarser than pollMs by design). */
  private identityPollMs(): number {
    return this.options.identityPollMs ?? 7_500;
  }

  /** Ticks older than this are a dead chain — ipc activity may revive it. Healthy ticks re-arm every pollMs regardless of poll duration, so 5 periods of silence is unambiguous. */
  private tickStallMs(): number {
    return this.pollMs() * 5;
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

  /** Initial restart-requested respawn backoff; doubles per consecutive request. */
  private respawnBackoffMs(): number {
    return this.options.respawnBackoffMs ?? 1000;
  }

  /** Consecutive restart-requested respawns granted without a healthy period before mirroring. */
  private maxConsecutiveRespawns(): number {
    return this.options.maxConsecutiveRespawns ?? 5;
  }

  /** How long a restart may make NO progress while childless before the watchdog replaces it. */
  private restartStallMs(): number {
    return this.options.restartStallMs ?? 60_000;
  }

  /** Crash respawns granted inside the rolling window in daemon posture before mirroring. */
  private crashRespawnLimit(): number {
    return this.options.crashRespawnLimit ?? 3;
  }

  /** The daemon crash-respawn budget window. */
  private crashRespawnWindowMs(): number {
    return this.options.crashRespawnWindowMs ?? 600_000;
  }

  /** Deadline for a single workspace diagnosis inside the childless coherence wait. */
  private coherenceDeadlineMs(): number {
    return this.options.coherenceDeadlineMs ?? 30_000;
  }
}
