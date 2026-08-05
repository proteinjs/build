import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import { PackageUtil } from '@proteinjs/util-node';
import { ServePackageSupervisor } from '../src/ServePackageSupervisor';
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
