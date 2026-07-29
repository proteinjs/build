import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { PackageUtil } from '@proteinjs/util-node';
import { ServePackageSupervisor } from '../src/ServePackageSupervisor';

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
