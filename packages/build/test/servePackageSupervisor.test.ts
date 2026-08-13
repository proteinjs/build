import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import { PackageUtil } from '@proteinjs/util-node';
import { ServePackageOptions, ServePackageSupervisor } from '../src/ServePackageSupervisor';
import { WorkspaceDoctor } from '../src/WorkspaceDoctor';

/**
 * Hermetic fixture workspace (no npm, no network): lib <- consumer, where consumer's serve
 * command is a tiny node script that records its pid. Each behavior is exercised end-to-end
 * through the real poll loop with short timings: staleness restart, hold deferral + TTL expiry,
 * forced restart while held, plain-run exit mirroring, and stop().
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => Promise<boolean> | boolean, timeoutMs: number, label: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for: ${label}`);
};

describe('ServePackageSupervisor', () => {
  let workspacePath: string;
  let libDir: string;
  let consumerDir: string;
  let supervisor: ServePackageSupervisor | undefined;

  const writeJson = async (filePath: string, value: unknown) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2));
  };

  const childPid = async (): Promise<number | undefined> => {
    try {
      return Number(await fs.readFile(path.join(consumerDir, 'child.pid'), 'utf-8'));
    } catch {
      return undefined;
    }
  };

  const touchLibDist = async () => {
    await fs.writeFile(path.join(libDir, 'dist', `change-${Date.now()}-${Math.random()}.js`), '// rebuilt');
  };

  const holdsDir = () => path.join(consumerDir, '.serve-package', 'holds');

  const writeHold = async (holder: string, ttlMs: number) => {
    await fs.mkdir(holdsDir(), { recursive: true });
    await fs.writeFile(
      path.join(holdsDir(), `${holder}.json`),
      JSON.stringify({ holder, expiresAt: Date.now() + ttlMs })
    );
  };

  const startSupervisor = async (onChildExit?: (code: number) => void) => {
    supervisor = new ServePackageSupervisor({
      packageName: '@test/consumer',
      command: ['node', 'server.js'],
      workspacePath,
      pollMs: 100,
      quietMs: 200,
      graceMs: 1500,
      onChildExit,
    });
    await supervisor.start();
    await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
    return (await childPid())!;
  };

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-package-test-'));
    await writeJson(path.join(workspacePath, 'package.json'), { name: 'root', private: true });

    libDir = path.join(workspacePath, 'packages', 'lib');
    await writeJson(path.join(libDir, 'package.json'), { name: '@test/lib', version: '1.0.0' });
    await fs.mkdir(path.join(libDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(libDir, 'dist', 'index.js'), '');

    consumerDir = path.join(workspacePath, 'packages', 'consumer');
    await writeJson(path.join(consumerDir, 'package.json'), {
      name: '@test/consumer',
      version: '1.0.0',
      dependencies: { '@test/lib': '1.0.0' },
    });
    // The "server": records pid + the IPC dir it was handed, then stays alive.
    await fs.writeFile(
      path.join(consumerDir, 'server.js'),
      [
        "const fs = require('fs');",
        "fs.writeFileSync('child.pid', String(process.pid));",
        "fs.writeFileSync('ipc.txt', process.env.SERVE_PACKAGE_IPC ?? '');",
        'setInterval(() => {}, 1000);',
      ].join('\n')
    );

    // Link the workspace the same way symlink-workspace does — the supervisor's
    // wait-for-coherence gate (WorkspaceDoctor) refuses to spawn into a clobbered workspace.
    const { packageMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
    await PackageUtil.symlinkDependencies(packageMap['@test/consumer'], packageMap);
  });

  afterEach(async () => {
    await supervisor?.stop();
    supervisor = undefined;
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('spawns the command in the package dir with SERVE_PACKAGE_IPC, pid file, and state.json', async () => {
    await startSupervisor();
    const ipc = (await fs.readFile(path.join(consumerDir, 'ipc.txt'), 'utf-8')).trim();
    expect(ipc).toBe(path.join(consumerDir, '.serve-package'));
    const supervisorPid = Number(await fs.readFile(path.join(ipc, 'pid'), 'utf-8'));
    expect(supervisorPid).toBe(process.pid);
    const state = JSON.parse(await fs.readFile(path.join(ipc, 'state.json'), 'utf-8'));
    expect(state).toMatchObject({ state: 'running', packageName: '@test/consumer' });
  });

  it('daemonize launches a DETACHED process logging to .serve-package/serve.log, rotating the previous log', async () => {
    const { pid, logPath } = await ServePackageSupervisor.daemonize({
      packageName: '@test/consumer',
      argv: ['-e', "console.log('daemon-alive'); setInterval(() => {}, 1000);"],
      workspacePath,
    });
    try {
      expect(logPath).toBe(path.join(consumerDir, '.serve-package', 'serve.log'));
      expect(() => process.kill(pid, 0)).not.toThrow();
      // Detachment is the point: the daemon leads its own process group (pgid === its pid),
      // so the launching shell/session dying cannot reap it.
      const pgid = execSync(`ps -o pgid= -p ${pid}`).toString().trim();
      expect(Number(pgid)).toBe(pid);
      await waitFor(
        async () => (await fs.readFile(logPath, 'utf-8').catch(() => '')).includes('daemon-alive'),
        5000,
        'daemon output in serve.log'
      );
      const second = await ServePackageSupervisor.daemonize({
        packageName: '@test/consumer',
        argv: ['-e', 'setInterval(() => {}, 1000);'],
        workspacePath,
      });
      try {
        expect(await fs.readFile(`${logPath}.prev`, 'utf-8')).toContain('daemon-alive');
      } finally {
        process.kill(second.pid);
      }
    } finally {
      process.kill(pid);
    }
  });

  it('writes state.json atomically: a burst of transitions lands the last state, complete, with no temp remnant', async () => {
    await startSupervisor();
    const internals = supervisor as unknown as {
      setState: (state: string) => void;
      stateWriteChain: Promise<void>;
    };
    // Rapid-fire transitions like a real restart storm; the serialized temp+rename chain
    // must land exactly the final snapshot (a kill mid-write previously truncated the file).
    for (let i = 0; i < 25; i++) {
      internals.setState(i % 2 === 0 ? 'restarting' : 'running');
    }
    internals.setState('running');
    await internals.stateWriteChain;
    const ipc = path.join(consumerDir, '.serve-package');
    const state = JSON.parse(await fs.readFile(path.join(ipc, 'state.json'), 'utf-8'));
    expect(state).toMatchObject({ state: 'running', packageName: '@test/consumer' });
    await expect(fs.stat(path.join(ipc, 'state.json.tmp'))).rejects.toThrow();
  });

  it('restarts the child when an upstream closure dist changes (quiet period respected)', async () => {
    const firstPid = await startSupervisor();
    await touchLibDist();
    await waitFor(async () => (await childPid()) !== firstPid, 5000, 'restart after dist change');
    // The old process is really gone.
    expect(() => process.kill(firstPid, 0)).toThrow();
  });

  it('defers a stale restart while a hold lease is active, then restarts when it expires', async () => {
    const firstPid = await startSupervisor();
    await writeHold('test-holder', 1200);
    await touchLibDist();
    // Well past poll+quiet, still held: no restart.
    await sleep(800);
    expect(await childPid()).toBe(firstPid);
    // Lease expiry releases the restart.
    await waitFor(async () => (await childPid()) !== firstPid, 5000, 'restart after hold expiry');
  });

  it('requestRestart files a request a live supervisor absorbs — restart without any dist change', async () => {
    const firstPid = await startSupervisor();
    const accepted = await ServePackageSupervisor.requestRestart(
      consumerDir,
      'workspace-package(@test/consumer) npm i'
    );
    expect(accepted).toBe(true);
    await waitFor(async () => (await childPid()) !== firstPid, 5000, 'restart after request');
    // The request lease was consumed, not left to re-trigger forever.
    await expect(fs.readFile(path.join(consumerDir, '.serve-package', 'restart-request'), 'utf-8')).rejects.toThrow();
  });

  it('requestRestart respects an active hold (unlike SIGUSR2) and returns false with no live supervisor', async () => {
    // No supervisor: nothing to ask.
    expect(await ServePackageSupervisor.requestRestart(consumerDir, 'nobody-home')).toBe(false);
    const firstPid = await startSupervisor();
    await writeHold('mid-chat-turn', 1200);
    expect(await ServePackageSupervisor.requestRestart(consumerDir, 'workspace-package npm update')).toBe(true);
    // Well past poll+quiet, still held: the request never bulldozes the hold.
    await sleep(800);
    expect(await childPid()).toBe(firstPid);
    // Lease expiry releases the requested restart.
    await waitFor(async () => (await childPid()) !== firstPid, 5000, 'requested restart after hold expiry');
  });

  it('restart() forces through an active hold, and the spawn clears stale leases', async () => {
    const firstPid = await startSupervisor();
    await writeHold('long-holder', 60_000);
    await touchLibDist();
    await sleep(800);
    expect(await childPid()).toBe(firstPid); // held
    await supervisor!.restart('test-force');
    await waitFor(async () => (await childPid()) !== firstPid, 5000, 'forced restart');
    // The long-lived lease was cleared by the respawn: new staleness restarts unaided.
    const secondPid = (await childPid())!;
    await touchLibDist();
    await waitFor(async () => (await childPid()) !== secondPid, 5000, 'restart after hold cleared');
  });

  it('mirrors a self-exiting child through onChildExit and stops supervising', async () => {
    await fs.writeFile(
      path.join(consumerDir, 'server.js'),
      ["const fs = require('fs');", "fs.writeFileSync('child.pid', String(process.pid));", 'process.exit(3);'].join(
        '\n'
      )
    );
    const exits: number[] = [];
    supervisor = new ServePackageSupervisor({
      packageName: '@test/consumer',
      command: ['node', 'server.js'],
      workspacePath,
      pollMs: 100,
      quietMs: 200,
      onChildExit: (code) => exits.push(code),
    });
    await supervisor.start();
    await waitFor(async () => exits.length > 0, 5000, 'onChildExit');
    expect(exits).toEqual([3]);
    // pid file removed by stop()
    await waitFor(
      async () =>
        !(await fs
          .access(path.join(consumerDir, '.serve-package', 'pid'))
          .then(() => true)
          .catch(() => false)),
      2000,
      'pid file removal'
    );
  });

  it("records the truth on self-exit: state.json says {state: 'exited', exitCode} with no childPid (2026-08-06 wedge #6)", async () => {
    await fs.writeFile(
      path.join(consumerDir, 'server.js'),
      ["const fs = require('fs');", "fs.writeFileSync('child.pid', String(process.pid));", 'process.exit(3);'].join(
        '\n'
      )
    );
    const exits: number[] = [];
    supervisor = new ServePackageSupervisor({
      packageName: '@test/consumer',
      command: ['node', 'server.js'],
      workspacePath,
      pollMs: 100,
      quietMs: 200,
      onChildExit: (code) => exits.push(code),
    });
    await supervisor.start();
    await waitFor(async () => exits.length > 0, 5000, 'onChildExit');
    // The overnight incident left state.json claiming 'running' with a dead childPid because
    // the final state write raced process.exit. onChildExit firing is the contract that the
    // truth has already LANDED on disk — read it right now, no settling allowed.
    const state = JSON.parse(await fs.readFile(path.join(consumerDir, '.serve-package', 'state.json'), 'utf-8'));
    expect(state).toMatchObject({ state: 'exited', exitCode: 3 });
    expect(state.childPid).toBeUndefined();
  });

  it('a restart-spawned child that dies at boot is retried through the coherence gate, not mirrored (2026-07-29 11:30 class)', async () => {
    // The child exits 1 while boot-fail.marker exists — standing in for a verify gate that
    // fails because a sibling build landed between the supervisor's coherence check and the
    // child's own verify. The retry must keep the supervisor alive and boot the next child
    // once the marker clears; a FIRST-boot failure still mirrors (plain-run semantics).
    // SELF-CLEARING marker: the failing boot consumes it, so exactly ONE spawn dies and the
    // bounded retry's next spawn succeeds — deterministic, no sleep-based marker juggling.
    const marker = path.join(consumerDir, 'boot-fail.marker');
    await fs.writeFile(
      path.join(consumerDir, 'server.js'),
      [
        "const fs = require('fs');",
        "if (fs.existsSync('boot-fail.marker')) { fs.unlinkSync('boot-fail.marker'); process.exit(1); }",
        "fs.writeFileSync('child.pid', String(process.pid));",
        'setInterval(() => {}, 1000);',
      ].join('\n')
    );
    const exits: number[] = [];
    supervisor = new ServePackageSupervisor({
      packageName: '@test/consumer',
      command: ['node', 'server.js'],
      workspacePath,
      pollMs: 100,
      quietMs: 200,
      graceMs: 1500,
      bootFailWindowMs: 3000,
      onChildExit: (code) => exits.push(code),
    });
    await supervisor.start();
    await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
    const firstPid = (await childPid())!;
    // Arm the marker and trigger a staleness restart: the restart's spawn dies at boot,
    // the retry's spawn boots clean.
    await fs.writeFile(marker, '');
    await touchLibDist();
    await waitFor(async () => (await childPid()) !== firstPid, 10000, 'retried child booted');
    expect(exits).toEqual([]); // the supervisor never mirrored an exit — it stayed alive through the retry
    const markerGone = await fs
      .access(marker)
      .then(() => false)
      .catch(() => true);
    expect(markerGone).toBe(true); // the failing boot really ran
  });

  it('an automatic stale restart never kills the child while the workspace is incoherent (keeps serving, restarts on coherence)', async () => {
    const firstPid = await startSupervisor();
    // Clobber the consumer's workspace symlink: @test/lib becomes a real directory — the
    // incoherence class agents leave behind (a bare npm install replacing the link). Pre-fix,
    // the supervisor killed the child FIRST and only then waited for coherence, so a rebuild
    // window (or a wedged workspace) meant a dead server for its whole duration.
    const linkPath = path.join(consumerDir, 'node_modules', '@test', 'lib');
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.mkdir(linkPath, { recursive: true });
    await fs.copyFile(path.join(libDir, 'package.json'), path.join(linkPath, 'package.json'));
    await touchLibDist();
    // Well past poll+quiet: stale and unheld, but incoherent — the child must STAY ALIVE.
    await sleep(800);
    expect(() => process.kill(firstPid, 0)).not.toThrow();
    expect(await childPid()).toBe(firstPid);
    // Heal the workspace: the deferred restart lands and the old child dies.
    await fs.rm(linkPath, { recursive: true, force: true });
    const { packageMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
    await PackageUtil.symlinkDependencies(packageMap['@test/consumer'], packageMap);
    await waitFor(async () => (await childPid()) !== firstPid, 10000, 'restart after coherence restored');
    expect(() => process.kill(firstPid, 0)).toThrow();
  });

  it('node_modules identity churn restarts through the gated path, even when the churn settles back to the boot-time state', async () => {
    // The blind-spot class (POST_RELEASE_QUEUE item 22): a bare npm i files no restart-request
    // and touches no dist — the child's watcher compiles through the node_modules hole with
    // boot-time loader config and the broken bundle STICKS, because the post-op re-symlink
    // restores identical mtimes AND the identical symlink set. Detection must therefore latch
    // on any observed change, not compare endpoints.
    supervisor = new ServePackageSupervisor({
      packageName: '@test/consumer',
      command: ['node', 'server.js'],
      workspacePath,
      pollMs: 100,
      quietMs: 200,
      graceMs: 1500,
      identityPollMs: 150,
    });
    await supervisor.start();
    await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
    const firstPid = (await childPid())!;
    const readState = async () =>
      JSON.parse(await fs.readFile(path.join(consumerDir, '.serve-package', 'state.json'), 'utf-8'));
    // The bare-npm-i shape: the workspace symlink becomes a registry-copy real directory.
    const linkPath = path.join(consumerDir, 'node_modules', '@test', 'lib');
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.mkdir(linkPath, { recursive: true });
    await fs.copyFile(path.join(libDir, 'package.json'), path.join(linkPath, 'package.json'));
    await waitFor(
      async () => ((await readState()).stalePackages ?? []).includes('node_modules package identity'),
      5000,
      'identity churn latched as staleness'
    );
    // Same gate as a dist change: the workspace is incoherent (clobbered symlink), so the
    // running child must stay alive — no kill into the hole.
    expect(await childPid()).toBe(firstPid);
    expect(() => process.kill(firstPid, 0)).not.toThrow();
    // Settle the churn back to the EXACT boot-time state (the re-symlink after the op).
    await fs.rm(linkPath, { recursive: true, force: true });
    const { packageMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
    await PackageUtil.symlinkDependencies(packageMap['@test/consumer'], packageMap);
    // The latched staleness lands the restart even though the final fingerprint equals the
    // baseline — the whole point of latching.
    await waitFor(async () => (await childPid()) !== firstPid, 10000, 'restart after churn settled');
    expect(() => process.kill(firstPid, 0)).toThrow();
  }, 20000);

  /**
   * The 2026-08-04 wedge class: a restart killed its child, the spawn never happened, and the
   * supervisor sat childless for 15+ minutes still advertising `state: running` with a dead pid
   * — unrecoverable, because the stalled chain never cleared the `restarting` latch, so every
   * later trigger no-opped on the re-entrancy guard. The invariant under test is: NEVER alive,
   * believing it has a child, with none.
   */
  describe('child liveness invariant', () => {
    type SupervisorInternals = {
      spawnChild: (viaRestart?: boolean) => Promise<void>;
      waitForCoherence: () => Promise<void>;
      child?: { pid?: number; removeAllListeners: (event: string) => unknown };
    };
    const readState = async () =>
      JSON.parse(await fs.readFile(path.join(consumerDir, '.serve-package', 'state.json'), 'utf-8'));

    it('a restart whose spawn throws reports honestly, then respawns (our failure, not an external kill)', async () => {
      const exits: number[] = [];
      const firstPid = await startSupervisor((code) => exits.push(code));
      const internals = supervisor as unknown as SupervisorInternals;
      const realSpawn = internals.spawnChild.bind(supervisor);
      // Fail exactly once: a transient spawn failure (EAGAIN/EMFILE) must not end supervision.
      internals.spawnChild = async (viaRestart?: boolean) => {
        internals.spawnChild = realSpawn;
        throw new Error('spawn exploded');
      };
      // Pre-fix this rejected into the caller's un-caught `void supervisor.restart(...)`.
      await expect(supervisor!.restart('test-spawn-failure')).resolves.toBeUndefined();
      // The one artifact an operator inspects must never claim a running child that is dead.
      const failedState = await readState();
      expect(failedState.state).toBe('failed');
      // …and the supervisor must get a child serving again rather than going quiet or exiting.
      await waitFor(
        async () => {
          const pid = await childPid();
          return pid !== undefined && pid !== firstPid;
        },
        10000,
        'respawn after the failed restart'
      );
      const state = await readState();
      expect(state.state).toBe('running');
      expect(() => process.kill(state.childPid, 0)).not.toThrow();
      expect(exits).toEqual([]); // supervision never ended for a transient spawn failure
    }, 20000);

    it('recovers when a restart stalls between the kill and the spawn (never childless forever)', async () => {
      // Stand in for the observed stall: the chain parks after killing the child and never
      // reaches the spawn. Pre-fix this owned the lane permanently — no child, no recovery.
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        graceMs: 1500,
        restartStallMs: 700,
      });
      await supervisor.start();
      await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
      const firstPid = (await childPid())!;
      const internals = supervisor as unknown as SupervisorInternals;
      internals.waitForCoherence = () => new Promise<void>(() => undefined); // never resolves
      void supervisor!.restart('test-stalled-restart');
      await waitFor(
        async () => {
          try {
            process.kill(firstPid, 0);
            return false;
          } catch {
            return true;
          }
        },
        5000,
        'child killed by the stalling restart'
      );
      // The watchdog must abandon the stalled attempt and get a child serving again.
      await waitFor(
        async () => {
          const pid = await childPid();
          return pid !== undefined && pid !== firstPid;
        },
        10000,
        'fresh child spawned after the stall'
      );
      const state = await readState();
      expect(state.state).toBe('running');
      expect(() => process.kill(state.childPid, 0)).not.toThrow(); // the advertised pid is REAL
    }, 20000);

    it('mirrors plain-run semantics when a child vanishes without its exit event (no resurrect)', async () => {
      const exits: number[] = [];
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        graceMs: 1500,
        onChildExit: (code) => exits.push(code),
      });
      await supervisor.start();
      await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
      const firstPid = (await childPid())!;
      // Simulate the documented npm-wrapper class: the child dies but its 'exit' never fires.
      const internals = supervisor as unknown as SupervisorInternals;
      internals.child!.removeAllListeners('exit');
      process.kill(firstPid, 'SIGKILL');
      await waitFor(async () => exits.length > 0, 5000, 'onChildExit from the liveness watchdog');
      expect(exits).toEqual([1]);
      // No resurrect: an externally killed child must not come back.
      expect(await childPid()).toBe(firstPid);
    });
  });

  /**
   * The 2026-08-04 evening wedge class: the supervisor's poll cadence died while WAITING-HOLDS
   * — the process stayed alive and I/O kept working, but no tick ever ran again, so expired
   * leases were never reaped, a filed restart-request was never consumed, and the pending stale
   * restart never landed (observed live: 7 hours of silence while holders kept writing leases).
   * The invariant under test: the lane's liveness must not hang off any single timer handle,
   * and no await in the poll chain may be unbounded.
   */
  describe('poll cadence liveness', () => {
    const readState = async () =>
      JSON.parse(await fs.readFile(path.join(consumerDir, '.serve-package', 'state.json'), 'utf-8'));

    it('lease activity revives a dead tick source: waiting-holds re-evaluates, reaps expired leases, restarts (2026-08-04 evening wedge class)', async () => {
      const firstPid = await startSupervisor();
      await writeHold('active-holder', 60_000);
      await touchLibDist();
      await waitFor(async () => (await readState()).state === 'waiting-holds', 5000, 'holds gate reached');
      // Simulate the observed failure: the process-wide JS timer subsystem stopped scheduling,
      // which for the supervisor means its one tick source silently dies mid waiting-holds.
      const internals = supervisor as unknown as { pollTimer?: NodeJS.Timeout; tickTimer?: NodeJS.Timeout };
      if (internals.pollTimer) {
        clearInterval(internals.pollTimer);
      }
      if (internals.tickTimer) {
        clearTimeout(internals.tickTimer);
      }
      // The holder crashes: its lease is gone from this world, nothing renews it.
      await fs.rm(path.join(holdsDir(), 'active-holder.json'), { force: true });
      // Let the dead cadence become detectable (well past the tick stall threshold: 5 × poll)…
      await sleep(700);
      // …then the only remaining external signal arrives: another holder writes a short lease
      // (in the live wedge, lease writes kept landing every few seconds the whole time).
      await writeHold('late-holder', 250);
      // The lane must come back: once the late lease expires it is reaped and the pending
      // stale restart lands — with NO further external events (the revived cadence carries it).
      await waitFor(
        async () => {
          const pid = await childPid();
          return pid !== undefined && pid !== firstPid;
        },
        8000,
        'restart after tick-source death'
      );
    }, 20000);

    it('a hung workspace diagnosis cannot end automatic restarts: the poll coherence gate is deadlined and retried', async () => {
      // First diagnosis after the holds clear HANGS forever (a wedged fs scan). Pre-fix the
      // poll awaited it unbounded and latched its in-flight guard permanently: every later
      // tick early-returned on the guard and no automatic restart could ever happen again.
      const realDiagnose = WorkspaceDoctor.prototype.diagnose;
      let hangingCalls = 1;
      WorkspaceDoctor.prototype.diagnose = function (this: WorkspaceDoctor, forPackages?: string[]) {
        if (hangingCalls > 0) {
          hangingCalls -= 1;
          return new Promise<never>(() => undefined);
        }
        return realDiagnose.call(this, forPackages);
      };
      try {
        supervisor = new ServePackageSupervisor({
          packageName: '@test/consumer',
          command: ['node', 'server.js'],
          workspacePath,
          pollMs: 100,
          quietMs: 200,
          graceMs: 1500,
          coherenceDeadlineMs: 300,
        });
        await supervisor.start();
        await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
        const firstPid = (await childPid())!;
        await touchLibDist();
        await waitFor(
          async () => {
            const pid = await childPid();
            return pid !== undefined && pid !== firstPid;
          },
          8000,
          'restart after the hung diagnosis was abandoned'
        );
      } finally {
        WorkspaceDoctor.prototype.diagnose = realDiagnose;
      }
    }, 20000);
  });

  /**
   * Deliberate-restart contract (the 2026-08-06/07 overnight-outage class): a child that exits
   * with RESTART_REQUEST_EXIT_CODE is ASKING for a supervised respawn — a liveness monitor
   * inside it gave up on a dependency (db, cache) and wants a fresh process once it heals.
   * Pre-contract, that deliberate exit was mirrored like any crash and the server stayed down
   * all night. The mirror path itself must also be ATOMIC: the observed zombie shape was a
   * supervisor that logged the mirror, parked in async cleanup, and lingered holding the pid
   * file with state.json claiming `running` — which then made the next relaunch silently fail
   * on the single-instance guard.
   */
  describe('restart-requested exits (deliberate-restart contract)', () => {
    const readBoots = async (): Promise<number[]> => {
      try {
        return (await fs.readFile(path.join(consumerDir, 'boots.log'), 'utf-8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(Number);
      } catch {
        return [];
      }
    };
    const readState = async () =>
      JSON.parse(await fs.readFile(path.join(consumerDir, '.serve-package', 'state.json'), 'utf-8'));
    const pidFileExists = () => fsSync.existsSync(path.join(consumerDir, '.serve-package', 'pid'));

    it('a child exiting with RESTART_REQUEST_EXIT_CODE is respawned after backoff, not mirrored', async () => {
      expect(ServePackageSupervisor.RESTART_REQUEST_EXIT_CODE).toBe(86); // the cross-package contract value
      // First boot consumes the marker and exits restart-requested (the liveness-monitor
      // shape); the respawned child boots clean and serves.
      await fs.writeFile(path.join(consumerDir, 'restart-request.marker'), '');
      await fs.writeFile(
        path.join(consumerDir, 'server.js'),
        [
          "const fs = require('fs');",
          "fs.appendFileSync('boots.log', Date.now() + '\\n');",
          "if (fs.existsSync('restart-request.marker')) { fs.unlinkSync('restart-request.marker'); process.exit(86); }",
          "fs.writeFileSync('child.pid', String(process.pid));",
          'setInterval(() => {}, 1000);',
        ].join('\n')
      );
      const exits: number[] = [];
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        graceMs: 1500,
        respawnBackoffMs: 300,
        onChildExit: (code) => exits.push(code),
      });
      await supervisor.start();
      await waitFor(async () => (await childPid()) !== undefined, 10000, 'respawned child booted');
      expect(exits).toEqual([]); // never mirrored — supervision stayed up
      const boots = await readBoots();
      expect(boots).toHaveLength(2);
      expect(boots[1] - boots[0]).toBeGreaterThanOrEqual(300); // bounded backoff before the respawn
      expect((await readState()).state).toBe('running');
    }, 20000);

    it('a hot loop of restart-requested exits is capped, then mirrored honestly (no infinite spin)', async () => {
      await fs.writeFile(
        path.join(consumerDir, 'server.js'),
        ["const fs = require('fs');", "fs.appendFileSync('boots.log', Date.now() + '\\n');", 'process.exit(86);'].join(
          '\n'
        )
      );
      const exits: number[] = [];
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        graceMs: 1500,
        respawnBackoffMs: 50,
        maxConsecutiveRespawns: 2,
        onChildExit: (code) => exits.push(code),
      });
      await supervisor.start();
      await waitFor(async () => exits.length > 0, 15000, 'capped hot loop mirrored');
      expect(exits).toEqual([86]);
      expect(await readBoots()).toHaveLength(3); // the initial boot + exactly maxConsecutiveRespawns respawns
      // Supervision ended honestly: nothing left behind that could wedge a relaunch.
      expect(pidFileExists()).toBe(false);
      expect((await readState()).state).toBe('exited');
    }, 20000);

    it('the mirror path is ATOMIC: pid file gone and state.json finalized by the time the exit is mirrored, even with async cleanup wedged (zombie shape unrepresentable)', async () => {
      await fs.writeFile(
        path.join(consumerDir, 'server.js'),
        ["const fs = require('fs');", "fs.writeFileSync('child.pid', String(process.pid));", 'process.exit(3);'].join(
          '\n'
        )
      );
      const observed: { code: number; pidFileGone: boolean; state: string }[] = [];
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        onChildExit: (code) => {
          // Synchronous observation at mirror time: the zombie shape (pid file + a state.json
          // claiming `running` outliving the decision to exit) must be impossible.
          observed.push({
            code,
            pidFileGone: !pidFileExists(),
            state: JSON.parse(fsSync.readFileSync(path.join(consumerDir, '.serve-package', 'state.json'), 'utf-8'))
              .state,
          });
        },
      });
      // The observed zombie: the supervisor LOGGED the mirror but its async cleanup parked
      // forever (dead timer subsystem / wedged event loop) — it never exited, kept the pid
      // file, and state.json stale-claimed `running`. The mirror must not depend on ANY async
      // machinery completing, so a parked stop() must not be able to prevent it.
      const internals = supervisor as unknown as { stop: () => Promise<void> };
      const realStop = internals.stop.bind(supervisor);
      internals.stop = () => new Promise<void>(() => undefined);
      try {
        await supervisor.start();
        await waitFor(async () => observed.length > 0, 10000, 'mirrored exit');
      } finally {
        internals.stop = realStop; // afterEach cleanup uses the real stop either way
      }
      expect(observed).toEqual([{ code: 3, pidFileGone: true, state: 'exited' }]);
    }, 15000);
  });

  it("daemon posture: a dead child parks as 'exited' (no mirror) and a SIGUSR2 restart respawns a fresh child (2026-08-06 wedge #5)", async () => {
    // First boot crashes (consuming the marker); with a respawn budget of 0 the supervisor
    // must park as 'exited' — alive and signal-responsive — instead of mirroring the exit.
    const marker = path.join(consumerDir, 'boot-fail.marker');
    await fs.writeFile(marker, '');
    await fs.writeFile(
      path.join(consumerDir, 'server.js'),
      [
        "const fs = require('fs');",
        "if (fs.existsSync('boot-fail.marker')) { fs.unlinkSync('boot-fail.marker'); process.exit(1); }",
        "fs.writeFileSync('child.pid', String(process.pid));",
        'setInterval(() => {}, 1000);',
      ].join('\n')
    );
    const exits: number[] = [];
    supervisor = new ServePackageSupervisor({
      packageName: '@test/consumer',
      command: ['node', 'server.js'],
      workspacePath,
      pollMs: 100,
      quietMs: 200,
      graceMs: 1500,
      daemon: true,
      crashRespawnLimit: 0,
      onChildExit: (code) => exits.push(code),
    });
    await supervisor.start();
    const statePath = path.join(consumerDir, '.serve-package', 'state.json');
    const readState = async () => JSON.parse(await fs.readFile(statePath, 'utf-8').catch(() => '{}'));
    await waitFor(async () => (await readState()).state === 'exited', 5000, "parked as 'exited'");
    expect(await readState()).toMatchObject({ state: 'exited', exitCode: 1 });
    expect(exits).toEqual([]); // the supervisor outlived the child — no plain-run mirror
    // What the CLI's SIGUSR2 handler invokes: a restart with NO live child must still spawn.
    await supervisor.restart('SIGUSR2');
    await waitFor(async () => (await childPid()) !== undefined, 5000, 'respawn after SIGUSR2');
    await waitFor(async () => (await readState()).state === 'running', 2000, "state back to 'running'");
    expect((await readState()).exitCode).toBeUndefined(); // the old exit is history, not ambient truth
  });

  it("daemon posture: crash respawns are budgeted — at the ceiling the supervisor parks as 'exited' instead of crash-looping", async () => {
    // The child always crashes, recording each boot. Budget 2 → exactly 1 initial boot +
    // 2 respawns, then parked. bootFailWindowMs=1 keeps the boot-retry branch (a different
    // mechanism for restart-spawned children) out of this test's way.
    await fs.writeFile(
      path.join(consumerDir, 'server.js'),
      ["const fs = require('fs');", "fs.appendFileSync('boots.log', 'boot\\n');", 'process.exit(5);'].join('\n')
    );
    const boots = async () =>
      (await fs.readFile(path.join(consumerDir, 'boots.log'), 'utf-8').catch(() => '')).split('\n').filter(Boolean)
        .length;
    const exits: number[] = [];
    supervisor = new ServePackageSupervisor({
      packageName: '@test/consumer',
      command: ['node', 'server.js'],
      workspacePath,
      pollMs: 100,
      quietMs: 200,
      graceMs: 1500,
      bootFailWindowMs: 1,
      daemon: true,
      crashRespawnLimit: 2,
      crashRespawnWindowMs: 60_000,
      onChildExit: (code) => exits.push(code),
    });
    await supervisor.start();
    const statePath = path.join(consumerDir, '.serve-package', 'state.json');
    const readState = async () => JSON.parse(await fs.readFile(statePath, 'utf-8').catch(() => '{}'));
    await waitFor(async () => (await readState()).state === 'exited', 10000, 'parked at the respawn ceiling');
    expect(await readState()).toMatchObject({ state: 'exited', exitCode: 5 });
    expect(await boots()).toBe(3); // 1 initial + 2 budgeted respawns
    // The ceiling holds: no further respawns dribble out after parking.
    await sleep(700);
    expect(await boots()).toBe(3);
    expect(exits).toEqual([]); // parked, not mirrored — SIGUSR2/SIGTERM still live
  });

  /**
   * The 2026-08-09 early-boot zombie class (observed twice after machine sleep): a child that
   * fails during early boot must resolve to exactly ONE of two outcomes — a FULL mirror-exit
   * (pid file removed, state.json terminal) or a legitimate respawn. The observed third shape
   * was a supervisor SURVIVING childless in a nonterminal state — a live zombie holding the
   * pid file (blocking fresh launches on the single-instance guard) while state.json claimed
   * a child that did not exist.
   */
  describe('early-boot child failure resolves atomically (no live zombie)', () => {
    const readState = async () =>
      JSON.parse(await fs.readFile(path.join(consumerDir, '.serve-package', 'state.json'), 'utf-8'));
    const pidFileExists = () => fsSync.existsSync(path.join(consumerDir, '.serve-package', 'pid'));

    it('a child that exits immediately at first boot mirrors fully: pid file removed, state.json terminal', async () => {
      await fs.writeFile(path.join(consumerDir, 'server.js'), 'process.exit(1);');
      const exits: number[] = [];
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        onChildExit: (code) => exits.push(code),
      });
      await supervisor.start();
      await waitFor(async () => exits.length > 0, 5000, 'mirrored exit');
      expect(exits).toEqual([1]);
      expect(pidFileExists()).toBe(false);
      expect((await readState()).state).toBe('exited');
    });

    it('a restart into PERSISTENT incoherence with a child that fails at boot still ENDS: bounded coherence wait, bounded boot retries, full mirror — never a childless park holding the pid file', async () => {
      const exits: number[] = [];
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        graceMs: 1500,
        bootFailWindowMs: 3000,
        coherenceWaitCeilingMs: 400,
        onChildExit: (code) => exits.push(code),
      });
      await supervisor.start();
      await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
      // Persistent incoherence nobody is healing (the post-sleep shape): clobber the workspace
      // symlink. No build is running, so coherence is NOT "moments away" — pre-fix the childless
      // coherence wait parked on it FOREVER, heartbeating progress so the stall watchdog never
      // tripped: alive, childless, nonterminal, pid file held.
      const linkPath = path.join(consumerDir, 'node_modules', '@test', 'lib');
      await fs.rm(linkPath, { recursive: true, force: true });
      await fs.mkdir(linkPath, { recursive: true });
      await fs.copyFile(path.join(libDir, 'package.json'), path.join(linkPath, 'package.json'));
      // Every later boot fails immediately — the boot-doctor-findings / crash-before-listening class.
      await fs.writeFile(path.join(consumerDir, 'server.js'), 'process.exit(1);');
      // Forced restart (rs/SIGUSR2 path, which bypasses the poll's coherence-gated kill).
      void supervisor.restart('test: forced restart into persistent incoherence');
      await waitFor(async () => exits.length > 0, 12000, 'supervision ended honestly');
      expect(exits).toEqual([1]);
      expect(pidFileExists()).toBe(false);
      expect((await readState()).state).toBe('exited');
    }, 20000);

    it('the boot-retry budget stays exhausted across coherence waits LONGER than the boot window (the real-scale shape): bounded spawns then full mirror, never an infinite spawn-fail loop', async () => {
      // Real defaults: coherenceWaitCeilingMs (10min) >> bootFailWindowMs (90s). The settle
      // timer that resets the retry budget after a survived boot window must NOT fire for a
      // child that is already DEAD — otherwise every inter-spawn coherence wait longer than
      // the boot window resets the budget and the "bounded" retry loops forever (observed
      // live 2026-08-10 in the e2e harness: 'attempt 1/2' every ceiling, indefinitely).
      const exits: number[] = [];
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        graceMs: 1500,
        bootFailWindowMs: 250, // SHORTER than the effective coherence wait, like production
        coherenceWaitCeilingMs: 600, // effective wait ~2s (the loop's sleep granularity)
        onChildExit: (code) => exits.push(code),
      });
      await supervisor.start();
      await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
      const linkPath = path.join(consumerDir, 'node_modules', '@test', 'lib');
      await fs.rm(linkPath, { recursive: true, force: true });
      await fs.mkdir(linkPath, { recursive: true });
      await fs.copyFile(path.join(libDir, 'package.json'), path.join(linkPath, 'package.json'));
      // Every later boot fails immediately, and each failing boot is COUNTED.
      await fs.writeFile(
        path.join(consumerDir, 'server.js'),
        ["const fs = require('fs');", "fs.appendFileSync('boots.log', Date.now() + '\\n');", 'process.exit(1);'].join(
          '\n'
        )
      );
      void supervisor.restart('test: forced restart into persistent incoherence, long waits');
      await waitFor(async () => exits.length > 0, 15000, 'supervision ended (bounded retries, no infinite loop)');
      expect(exits).toEqual([1]);
      const failedBoots = (await fs.readFile(path.join(consumerDir, 'boots.log'), 'utf-8')).trim().split('\n');
      expect(failedBoots).toHaveLength(3); // initial attempt + exactly 2 budgeted retries
      expect(pidFileExists()).toBe(false);
      expect((await readState()).state).toBe('exited');
    }, 25000);

    it('a dead child whose exit event was lost and whose pid still reads alive (pid reuse / lingering kernel entry) is mirrored — never a perpetual `running` claim with no child', async () => {
      const exits: number[] = [];
      const firstPid = await startSupervisor((code) => exits.push(code));
      const internals = supervisor as unknown as { child: { removeAllListeners: (event: string) => unknown } };
      const supervisorClass = ServePackageSupervisor as unknown as { processAlive: (pid: number) => boolean };
      const realProcessAlive = supervisorClass.processAlive;
      try {
        // The exit event is lost AND the process table lies: kill(pid, 0) keeps succeeding
        // after death (pid reused by an unrelated process, or the kernel entry lingering).
        // Pre-fix the liveness watchdog trusted kill() alone and sat `running`-with-no-child
        // forever — the literal observed zombie shape.
        internals.child.removeAllListeners('exit');
        supervisorClass.processAlive = () => true;
        process.kill(firstPid, 'SIGKILL');
        await waitFor(async () => exits.length > 0, 5000, 'mirrored via the process handle reap state');
        expect(exits).toEqual([1]);
        expect(pidFileExists()).toBe(false);
        expect((await readState()).state).toBe('exited');
      } finally {
        supervisorClass.processAlive = realProcessAlive;
      }
    });
  });

  /**
   * The S1 parked-coherence-wait class: a forced restart into a workspace nobody is healing
   * parks CHILDLESS in waitForCoherence, re-diagnosing every 2s up to the ceiling. Two ratified
   * defects: (1) the documented escape hatch (rs/SIGUSR2 → restart()) silently no-opped on the
   * re-entrancy guard for the whole park — a "dead" supervisor for hours; (2) state.json froze
   * on the trigger-time snapshot, so operators could not see the LIVE blocker list.
   */
  describe('parked coherence wait: escape hatch + live state.json mirror', () => {
    const readState = async () =>
      JSON.parse(await fs.readFile(path.join(consumerDir, '.serve-package', 'state.json'), 'utf-8'));

    // The persistent-incoherence shape (no build running, nothing healing it): the workspace
    // symlink becomes a registry-copy real directory.
    const clobberLibSymlink = async () => {
      const linkPath = path.join(consumerDir, 'node_modules', '@test', 'lib');
      await fs.rm(linkPath, { recursive: true, force: true });
      await fs.mkdir(linkPath, { recursive: true });
      await fs.copyFile(path.join(libDir, 'package.json'), path.join(linkPath, 'package.json'));
    };

    const healWorkspace = async () => {
      const linkPath = path.join(consumerDir, 'node_modules', '@test', 'lib');
      await fs.rm(linkPath, { recursive: true, force: true });
      const { packageMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
      await PackageUtil.symlinkDependencies(packageMap['@test/consumer'], packageMap);
    };

    it('rs/SIGUSR2 during the childless park spawns anyway — the escape hatch is never a silent no-op', async () => {
      const firstPid = await startSupervisor();
      await clobberLibSymlink();
      // Forced restart parks childless: the kill succeeds, then the wait loops on the finding.
      void supervisor!.restart('test: park in the coherence wait');
      // The live mirror appearing proves a diagnose pass has completed INSIDE the wait — the
      // chain is parked, not merely killing.
      await waitFor(
        async () => {
          const state = await readState();
          return state.state === 'restarting' && state.coherenceFindings !== undefined;
        },
        10000,
        'parked in the coherence wait'
      );
      expect(() => process.kill(firstPid, 0)).toThrow(); // childless: the kill really happened
      // The operator's escape (what the CLI's SIGUSR2 handler invokes). Pre-fix: a silent
      // return on the re-entrancy guard — the park continued and nothing ever spawned.
      await supervisor!.restart('SIGUSR2');
      await waitFor(
        async () => {
          const pid = await childPid();
          return pid !== undefined && pid !== firstPid;
        },
        10000,
        'child spawned despite outstanding findings'
      );
      const state = await readState();
      expect(state.state).toBe('running');
      expect(() => process.kill(state.childPid, 0)).not.toThrow(); // the advertised pid is REAL
      expect(state.coherenceFindings).toBeUndefined(); // the spawn reset cleared the mirror
      expect(state.coherenceCheckedAt).toBeUndefined();
    }, 25000);

    it('state.json mirrors the LIVE blocker list during the park: findings + an advancing coherenceCheckedAt, cleared on coherence', async () => {
      const firstPid = await startSupervisor();
      await clobberLibSymlink();
      void supervisor!.restart('test: park in the coherence wait');
      // Pre-fix: state.json froze on the trigger snapshot — these fields never appeared.
      await waitFor(async () => (await readState()).coherenceFindings !== undefined, 10000, 'live findings mirrored');
      const first = await readState();
      expect(first.state).toBe('restarting');
      // The doctor's own WorkspaceFinding vocabulary — not a renamed mirror shape.
      expect(first.coherenceFindings).toEqual([{ packageName: '@test/consumer', kind: 'clobbered-symlink' }]);
      expect(typeof first.coherenceCheckedAt).toBe('number');
      // LIVE, not written-once: the next diagnose pass (2s cadence) advances the stamp.
      await waitFor(
        async () => ((await readState()).coherenceCheckedAt ?? 0) > first.coherenceCheckedAt,
        10000,
        'coherenceCheckedAt advanced on the next pass'
      );
      expect((await readState()).coherenceFindings).toEqual(first.coherenceFindings);
      // Heal: the wait exits with zero findings, the chain spawns, the mirror is cleared.
      await healWorkspace();
      await waitFor(
        async () => {
          const pid = await childPid();
          return pid !== undefined && pid !== firstPid;
        },
        10000,
        'spawn after coherence restored'
      );
      const final = await readState();
      expect(final.state).toBe('running');
      expect(final.coherenceFindings).toBeUndefined();
      expect(final.coherenceCheckedAt).toBeUndefined();
    }, 25000);

    it("the pre-kill gate ('waiting-coherence', child alive) mirrors live findings every pass too", async () => {
      const firstPid = await startSupervisor();
      await clobberLibSymlink();
      await touchLibDist();
      // The automatic path: stale + quiet + unheld, but incoherent — the poll parks in
      // 'waiting-coherence' with the child STILL SERVING, re-diagnosing every tick.
      await waitFor(
        async () => {
          const state = await readState();
          return state.state === 'waiting-coherence' && state.coherenceFindings !== undefined;
        },
        10000,
        'waiting-coherence with live findings mirrored'
      );
      const first = await readState();
      expect(first.coherenceFindings).toEqual([{ packageName: '@test/consumer', kind: 'clobbered-symlink' }]);
      expect(await childPid()).toBe(firstPid); // the child stayed alive through the gate
      await waitFor(
        async () => ((await readState()).coherenceCheckedAt ?? 0) > first.coherenceCheckedAt,
        10000,
        'coherenceCheckedAt advanced on a later poll pass'
      );
      // Heal: the deferred restart lands and the mirror is cleared with it.
      await healWorkspace();
      await waitFor(async () => (await childPid()) !== firstPid, 10000, 'restart after coherence restored');
      const final = await readState();
      expect(final.state).toBe('running');
      expect(final.coherenceFindings).toBeUndefined();
    }, 25000);

    it('a superseded restart chain goes fully inert: no stale-findings rewrites of state.json after the supersede, and the next parked chain still escapes', async () => {
      // The zombie-chain class: chain 1 parks in the REAL coherence wait; a queued
      // restart-request supersedes it (recoverChild bumps the generation and spawns). Pre-fix
      // nothing in the wait checked the generation, so chain 1 kept looping — stamping stale
      // findings + setState('running') into state.json every ~2s pass right after the healthy
      // spawn, and (at its eventual exit) clearing the escape flag out from under a newer chain.
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        graceMs: 1500,
        restartSupersedeMs: 700,
      });
      await supervisor.start();
      await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
      const firstPid = (await childPid())!;
      await clobberLibSymlink();
      // Chain 1 parks childless (the kill succeeds, then the wait loops on the finding).
      void supervisor.restart('test: park chain 1');
      await waitFor(
        async () => {
          const state = await readState();
          return state.state === 'restarting' && state.coherenceFindings !== undefined;
        },
        10000,
        'chain 1 parked in the coherence wait'
      );
      // Queued request + lane owned past restartSupersedeMs → recoverChild supersedes chain 1
      // and spawns despite the (advisory-in-recovery) incoherence. Chain 1 is now a zombie.
      expect(await ServePackageSupervisor.requestRestart(consumerDir, 'post-npm-op')).toBe(true);
      await waitFor(
        async () => {
          const pid = await childPid();
          return pid !== undefined && pid !== firstPid;
        },
        10000,
        'supersede spawned a fresh child'
      );
      const secondPid = (await childPid())!;
      await waitFor(async () => (await readState()).state === 'running', 2000, 'state.json settled on running');
      // Watch state.json across multiple would-be zombie passes (~2s cadence): the mirror must
      // stay pinned to the new chain's truth — running, no blockers.
      const cleanUntil = Date.now() + 3000;
      while (Date.now() < cleanUntil) {
        const state = await readState();
        expect(state.state).toBe('running');
        expect(state.coherenceFindings).toBeUndefined();
        await sleep(50);
      }
      // The escape hatch belongs to the CURRENT chain: park again (workspace still clobbered)
      // and fire rs — the newer chain must spawn despite findings.
      void supervisor.restart('test: park chain 2');
      await waitFor(
        async () => {
          const state = await readState();
          return state.state === 'restarting' && state.coherenceFindings !== undefined;
        },
        10000,
        'chain 2 parked in the coherence wait'
      );
      await supervisor.restart('SIGUSR2');
      await waitFor(
        async () => {
          const pid = await childPid();
          return pid !== undefined && pid !== secondPid;
        },
        10000,
        'chain 2 escaped and spawned despite findings'
      );
      expect((await readState()).state).toBe('running');
    }, 30000);

    it('rs during the KILL window (before the park begins) arms the escape: the chain spawns despite findings, never a consumed no-op', async () => {
      // A SIGTERM-ignoring child stretches the kill phase to graceMs — the multi-second window
      // where pre-fix an rs/SIGUSR2 was answered with "ignoring" (the chain was not yet inside
      // the wait), and the chain then parked with no escape armed: the operator's lever did
      // nothing. Post-fix restart() arms unconditionally while a chain is in flight.
      await fs.writeFile(
        path.join(consumerDir, 'server.js'),
        [
          "const fs = require('fs');",
          "fs.writeFileSync('child.pid', String(process.pid));",
          "process.on('SIGTERM', () => {});",
          'setInterval(() => {}, 1000);',
        ].join('\n')
      );
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        graceMs: 1500,
      });
      await supervisor.start();
      await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
      const firstPid = (await childPid())!;
      await clobberLibSymlink(); // without the escape, the chain parks after the kill
      void supervisor.restart('test: restart with a slow kill');
      // Lands deterministically inside the SIGTERM→SIGKILL window: the chain is parked in
      // killChild's grace await, nowhere near the coherence wait yet.
      await supervisor.restart('rs');
      await waitFor(
        async () => {
          const pid = await childPid();
          return pid !== undefined && pid !== firstPid;
        },
        8000,
        'spawned despite findings — escape armed during the kill window'
      );
      expect((await readState()).state).toBe('running');
    }, 20000);

    it('the escape does not wait on a diagnose: with a HANGING doctor the spawn lands within one deadline cycle (loop-top check pinned)', async () => {
      // Pins the escape check's placement at the iteration TOP, before the diagnose await: a
      // wedged scan must never keep the hatch from working. Every diagnose here hangs forever;
      // only the per-scan deadline unparks the loop, so an escape checked anywhere on the
      // findings-resolved path would never fire.
      const realDiagnose = WorkspaceDoctor.prototype.diagnose;
      WorkspaceDoctor.prototype.diagnose = function () {
        return new Promise<never>(() => undefined);
      };
      try {
        supervisor = new ServePackageSupervisor({
          packageName: '@test/consumer',
          command: ['node', 'server.js'],
          workspacePath,
          pollMs: 100,
          quietMs: 200,
          graceMs: 1500,
          coherenceDeadlineMs: 400,
        });
        await supervisor.start();
        await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
        const firstPid = (await childPid())!;
        void supervisor.restart('test: park on hanging diagnoses');
        await waitFor(
          async () => {
            try {
              process.kill(firstPid, 0);
              return false;
            } catch {
              return true;
            }
          },
          5000,
          'child killed; chain heading into the wait'
        );
        await sleep(600); // > coherenceDeadlineMs: the chain is mid-loop, cycling hung scans
        const armedAt = Date.now();
        await supervisor.restart('rs');
        await waitFor(
          async () => {
            const pid = await childPid();
            return pid !== undefined && pid !== firstPid;
          },
          4000,
          'spawned while every diagnose still hangs'
        );
        // Bounded by ONE deadline cycle plus spawn overhead — never by a scan resolving
        // (none ever do).
        expect(Date.now() - armedAt).toBeLessThan(3000);
      } finally {
        WorkspaceDoctor.prototype.diagnose = realDiagnose;
      }
    }, 20000);
  });

  /**
   * The 2026-08-09 starvation class: the request-activity hold is refreshed by ANY HTTP request
   * — including background poll timers from merely-open tabs (~20s cadence, zero human
   * interaction) — so a queued restart-request waiting for FULL hold expiry starved from 13:32
   * past 18:00 while the child silently served stale dists. Queued requests must fire during a
   * natural idle gap (the required gap escalating shorter as the request ages), must fire at a
   * hard ceiling regardless, and must supersede a wedged in-flight restart — a queued request
   * always eventually wins or screams. Genuine interactive bursts still defer.
   *
   * 2026-08-11 recurrence: the guard covered ONLY queued requests, and the exact starvation
   * came back as PLAIN dist staleness (the earlier request had been consumed by a spawn; the
   * next rebuild's staleness kept full hold-expiry semantics against a lease refreshed every
   * ~21s). ANY pending restart — queued request or plain staleness — now rides the same
   * idle-gap + ceiling gate: holds defer, they must never starve.
   */
  describe('pending-restart starvation (idle-gap escalation, hard ceiling, wedged-latch supersede)', () => {
    const readState = async () =>
      JSON.parse(await fs.readFile(path.join(consumerDir, '.serve-package', 'state.json'), 'utf-8'));

    const startWithOptions = async (extra: Partial<ServePackageOptions>) => {
      supervisor = new ServePackageSupervisor({
        packageName: '@test/consumer',
        command: ['node', 'server.js'],
        workspacePath,
        pollMs: 100,
        quietMs: 200,
        graceMs: 1500,
        ...extra,
      });
      await supervisor.start();
      await waitFor(async () => (await childPid()) !== undefined, 5000, 'first child boot');
      return (await childPid())!;
    };

    /**
     * Background-tab poll traffic, scaled down: rewrites the request-activity lease on a fixed
     * cadence with a TTL longer than the cadence, so the hold NEVER expires — the exact
     * starvation shape (real system: ~20s poll cadence vs a 30s quiet-window TTL).
     */
    const startActivitySource = (cadenceMs: number, ttlMs: number) => {
      const leasePath = path.join(holdsDir(), 'request-activity.json');
      const write = () => {
        fsSync.mkdirSync(holdsDir(), { recursive: true });
        const tmpPath = `${leasePath}.tmp-test`;
        fsSync.writeFileSync(tmpPath, JSON.stringify({ holder: 'request-activity', expiresAt: Date.now() + ttlMs }));
        fsSync.renameSync(tmpPath, leasePath);
      };
      write();
      const interval = setInterval(write, cadenceMs);
      return () => clearInterval(interval);
    };

    it('poll-cadence hold refreshes cannot starve a queued request: it fires in an escalated idle gap, before the ceiling', async () => {
      const firstPid = await startWithOptions({
        restartRequestIdleGapMs: 600,
        restartRequestStarvationCeilingMs: 5000,
      });
      const stopActivity = startActivitySource(450, 1500);
      try {
        const queuedAt = Date.now();
        expect(await ServePackageSupervisor.requestRestart(consumerDir, 'workspace-package npm i')).toBe(true);
        // Pre-fix: the ~450ms-cadence refreshes keep the lease perpetually unexpired and the
        // restart never fires. Post-fix: the required gap shrinks as the request ages until a
        // natural inter-refresh gap (~450ms) qualifies — well before the 5s ceiling.
        await waitFor(async () => (await childPid()) !== firstPid, 4500, 'queued request fired before the ceiling');
        expect(Date.now() - queuedAt).toBeLessThan(5000);
      } finally {
        stopActivity();
      }
    }, 20000);

    it('gapless hold activity: the queued request still fires once past the hard ceiling', async () => {
      const firstPid = await startWithOptions({
        restartRequestIdleGapMs: 5000,
        restartRequestStarvationCeilingMs: 1200,
      });
      const stopActivity = startActivitySource(60, 1000);
      try {
        const queuedAt = Date.now();
        expect(await ServePackageSupervisor.requestRestart(consumerDir, 'starved-op')).toBe(true);
        await waitFor(async () => (await childPid()) !== firstPid, 6000, 'request fired at the ceiling');
        // It waited (deferral is correct) but the ceiling put a hard stop on the starvation.
        expect(Date.now() - queuedAt).toBeGreaterThanOrEqual(1000);
      } finally {
        stopActivity();
      }
    }, 20000);

    it('PLAIN dist staleness behind gapless hold refreshes fires at the starvation ceiling (2026-08-11 field class)', async () => {
      // No restart-request anywhere: a sibling rebuild lands while a lease is being refreshed
      // faster than it can expire. Pre-fix this deferred FOREVER (full hold-expiry semantics
      // with a lease that never expires); post-fix the staleness clock drives the same ceiling.
      const firstPid = await startWithOptions({
        restartRequestIdleGapMs: 5000, // a 60ms cadence never leaves this gap — only the ceiling can fire
        restartRequestStarvationCeilingMs: 1500,
      });
      const stopActivity = startActivitySource(60, 1000);
      try {
        const staleAt = Date.now();
        await touchLibDist();
        await waitFor(async () => (await childPid()) !== firstPid, 8000, 'stale restart fired at the ceiling');
        // It waited out the ceiling (deferral is correct) instead of firing instantly.
        expect(Date.now() - staleAt).toBeGreaterThanOrEqual(1200);
      } finally {
        stopActivity();
      }
    }, 20000);

    it('PLAIN dist staleness fires in a natural idle gap of hold refreshes, long before lease expiry', async () => {
      const firstPid = await startWithOptions({
        restartRequestIdleGapMs: 500,
        restartRequestStarvationCeilingMs: 60_000,
      });
      const leaseTtlMs = 10_000;
      const stopActivity = startActivitySource(100, leaseTtlMs);
      try {
        await touchLibDist();
        // While refreshes leave no qualifying gap, staleness defers — deferral is correct.
        await sleep(1500);
        expect(await childPid()).toBe(firstPid);
      } finally {
        stopActivity();
      }
      const activityStoppedAt = Date.now();
      await waitFor(async () => (await childPid()) !== firstPid, 3000, 'stale restart in the first natural idle gap');
      // Fired via the idle gap, NOT lease expiry — the lease still had many seconds of TTL left.
      expect(Date.now() - activityStoppedAt).toBeLessThan(leaseTtlMs - 5000);
    }, 20000);

    it('a genuine interactive burst still defers; the request fires in the FIRST natural idle gap, long before lease expiry', async () => {
      const firstPid = await startWithOptions({
        restartRequestIdleGapMs: 500,
        restartRequestStarvationCeilingMs: 60_000,
      });
      const leaseTtlMs = 10_000;
      const stopActivity = startActivitySource(100, leaseTtlMs);
      try {
        expect(await ServePackageSupervisor.requestRestart(consumerDir, 'mid-burst-op')).toBe(true);
        // A burst within the idle-gap window defers — deferral is correct; only starvation is the bug.
        await sleep(1500);
        expect(await childPid()).toBe(firstPid);
      } finally {
        stopActivity();
      }
      const activityStoppedAt = Date.now();
      await waitFor(async () => (await childPid()) !== firstPid, 3000, 'restart in the first natural idle gap');
      // Fired via the idle gap, NOT lease expiry — the lease still had many seconds of TTL left.
      expect(Date.now() - activityStoppedAt).toBeLessThan(leaseTtlMs - 5000);
    }, 20000);

    it("a satisfied request's starvation clock dies with it: the next plain staleness defers on a FRESH escalation window", async () => {
      // The gate's escalation clock keys on restartRequestedAt/staleSince, and the spawn that
      // satisfies a request must CLEAR both. If the dead request's timestamp lingered, it would
      // already sit past the ceiling and the next plain dist-staleness restart would fire
      // straight through actively-refreshed holds — one npm op ago would bulldoze the next
      // chat turn. Fresh staleness must earn its own idle gap or ceiling.
      const firstPid = await startWithOptions({
        restartRequestIdleGapMs: 300,
        restartRequestStarvationCeilingMs: 2000,
      });
      // Phase 1: an unheld restart-request is satisfied by a spawn.
      expect(await ServePackageSupervisor.requestRestart(consumerDir, 'workspace-package npm i')).toBe(true);
      await waitFor(
        async () => {
          const pid = await childPid();
          return pid !== undefined && pid !== firstPid;
        },
        5000,
        'requested restart satisfied'
      );
      const secondPid = (await childPid())!;
      // Phase 2: plain staleness behind a hold refreshed every 60ms (no 300ms gap ever opens
      // naturally). A lingering phase-1 request clock (~1.2s old by now) would have escalated
      // the required gap under the refresh cadence already and fire within the first ticks
      // after quiet; a FRESH staleness clock still demands ~150ms+ gaps through the first
      // second, so "still deferred at +1s" is the discriminator. WHERE in its window it
      // eventually fires (a jitter gap qualifying as the required gap shrinks, or the hard
      // ceiling) is legitimate timing variance — only "not instantly" and "eventually" are
      // the contract.
      const stopActivity = startActivitySource(60, 5000);
      try {
        await touchLibDist();
        await sleep(1000); // past poll+quiet and past where a lingering clock would have fired
        expect(await childPid()).toBe(secondPid); // deferred: the dead request's clock is gone
        await waitFor(
          async () => (await childPid()) !== secondPid,
          6000,
          'stale restart within its own escalation window'
        );
      } finally {
        stopActivity();
      }
    }, 20000);

    it('a wedged in-flight restart plus a new request resolves: the request supersedes the stuck attempt (never rots unread)', async () => {
      const firstPid = await startWithOptions({ restartSupersedeMs: 700 });
      const internals = supervisor as unknown as {
        waitForCoherence: () => Promise<void>;
        touchRestartProgress: () => void;
      };
      // The wedge class the stall watchdog CANNOT see: the chain keeps heartbeating progress
      // (exactly like the coherence wait's announce loop does) but never reaches its spawn.
      const touch = internals.touchRestartProgress.bind(supervisor);
      const heartbeat = setInterval(touch, 200);
      internals.waitForCoherence = () => new Promise<void>(() => undefined);
      try {
        void supervisor!.restart('test: wedged restart');
        await waitFor(
          async () => {
            try {
              process.kill(firstPid, 0);
              return false;
            } catch {
              return true;
            }
          },
          5000,
          'child killed by the wedged restart'
        );
        expect(await ServePackageSupervisor.requestRestart(consumerDir, 'post-npm-op')).toBe(true);
        // Pre-fix: the poll early-returned on the restarting latch BEFORE reading the request
        // file, so the request rotted unread while the wedged chain owned the lane forever.
        await waitFor(
          async () => {
            const pid = await childPid();
            return pid !== undefined && pid !== firstPid;
          },
          8000,
          'queued request superseded the wedged attempt'
        );
        expect((await readState()).state).toBe('running');
        // The request was consumed, not left to re-trigger forever.
        await expect(
          fs.readFile(path.join(consumerDir, '.serve-package', 'restart-request'), 'utf-8')
        ).rejects.toThrow();
      } finally {
        clearInterval(heartbeat);
      }
    }, 20000);
  });

  it('refuses to start while another live supervisor owns the package dir', async () => {
    await startSupervisor();
    const second = new ServePackageSupervisor({
      packageName: '@test/consumer',
      command: ['node', 'server.js'],
      workspacePath,
      pollMs: 100,
      quietMs: 200,
    });
    await expect(second.start()).rejects.toThrow(/already supervises/);
  });

  it('stop() completes in bounded time against a SIGTERM-ignoring child (SIGKILL escalation)', async () => {
    // The 2026-07-29 wedge class: shutdown must never await child exit unbounded. This child
    // traps SIGTERM and lives on; stop() must escalate to SIGKILL and finish within
    // grace + escalation bounds.
    await fs.writeFile(
      path.join(consumerDir, 'server.js'),
      [
        "const fs = require('fs');",
        "fs.writeFileSync('child.pid', String(process.pid));",
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
      ].join('\n')
    );
    const firstPid = await startSupervisor();
    const started = Date.now();
    await supervisor!.stop();
    supervisor = undefined;
    expect(Date.now() - started).toBeLessThan(6000); // grace 1500 + kill escalation + margin
    await waitFor(
      async () => {
        try {
          process.kill(firstPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      3000,
      'stubborn child terminated'
    );
  });

  it('stop() terminates the child', async () => {
    const firstPid = await startSupervisor();
    await supervisor!.stop();
    supervisor = undefined;
    await waitFor(
      async () => {
        try {
          process.kill(firstPid, 0);
          return false;
        } catch {
          return true;
        }
      },
      3000,
      'child terminated'
    );
  });
});
