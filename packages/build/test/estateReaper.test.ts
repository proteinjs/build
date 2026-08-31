import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { EstateRegistry } from '../src/EstateRegistry';
import { EstateReaper } from '../src/EstateReaper';

/**
 * The reaper's safety rules MUST bite (RESOURCE_GOVERNANCE §B.2): an estate with unpushed git
 * work survives, a live-port estate survives, a live cwd-verified pid survives (surfaced, never
 * killed), and a dead-by-contract estate reaps — asserted as OUTCOMES (dirs on disk, registry
 * files, receipts), with real git fixtures and real sockets/processes where liveness is claimed.
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

const STALE = 40 * 3600_000; // past the 36h dead-by-contract TTL

describe('EstateReaper', () => {
  let fixtureRoot: string;
  let home: string;
  let registry: EstateRegistry;

  beforeEach(async () => {
    fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'estate-reaper-test-')));
    home = path.join(fixtureRoot, '.n3xa');
    registry = new EstateRegistry(home);
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  /** A registered estate whose heartbeat is already stale (dead-by-contract unless something pins it). */
  const registerStale = async (overrides: Partial<Parameters<EstateRegistry['register']>[0]> = {}) => {
    const estateDir = path.join(fixtureRoot, `estate-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(estateDir, { recursive: true });
    await fs.writeFile(path.join(estateDir, 'scratch.bin'), Buffer.alloc(32 * 1024, 1));
    const record = await registry.register(
      { owner: 'lane-test', dirs: [estateDir], ...overrides },
      { enforceValve: false }
    );
    // Age the heartbeat directly (the registry stamps now; the fixture needs the past).
    const recordPath = path.join(registry.estatesDir(), `${record.id}.json`);
    const aged = { ...record, startedAt: Date.now() - STALE, heartbeatAt: Date.now() - STALE };
    await fs.writeFile(recordPath, JSON.stringify(aged));
    return { record: aged, estateDir, recordPath };
  };

  /** A clean repo whose single commit exists on its "remote" (a local bare clone as origin). */
  const initPushedRepo = async (dir: string) => {
    await fs.mkdir(dir, { recursive: true });
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@test.io']);
    git(dir, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(dir, 'src.ts'), 'export const x = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'init']);
    const remoteDir = path.join(fixtureRoot, `remote-${path.basename(path.dirname(dir))}-${path.basename(dir)}.git`);
    git(fixtureRoot, ['init', '--bare', '-b', 'main', remoteDir]);
    git(dir, ['remote', 'add', 'origin', remoteDir]);
    git(dir, ['push', 'origin', 'main']);
    return dir;
  };

  test('a dead estate reaps: dirs deleted, containers stopped+removed, registration pruned, receipt logged', async () => {
    const dockerCalls: string[][] = [];
    const { record, estateDir } = await registerStale({ containers: ['spanner-lane-x'] });

    const result = await new EstateReaper({
      registry,
      apply: true,
      dockerRun: async (args) => {
        dockerCalls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    }).sweep();

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].verdict).toBe('reaped');
    expect(await exists(estateDir)).toBe(false);
    expect(await registry.get(record.id)).toBeUndefined();
    expect(dockerCalls).toEqual([
      ['stop', 'spanner-lane-x'],
      ['rm', 'spanner-lane-x'],
    ]);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    const receipts = await fs.readFile(path.join(registry.logsDir(), 'reap.log'), 'utf-8');
    expect(receipts).toContain(record.id);
    expect(receipts).toContain('"verdict":"reaped"');
  });

  test('an estate with UNPUSHED git work survives (refusal listed, nothing deleted)', async () => {
    const { record, estateDir } = await registerStale();
    const repoDir = await initPushedRepo(path.join(estateDir, 'repo'));
    await fs.writeFile(path.join(repoDir, 'unpushed.ts'), 'export const wip = 1;\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'unpushed work']);

    const result = await new EstateReaper({ registry, apply: true }).sweep();

    expect(result.reports[0].verdict).toBe('partial');
    expect(result.reports[0].refusals.join('\n')).toMatch(/unpushed commit/);
    expect(await exists(repoDir)).toBe(true);
    // The record is RETAINED, trimmed to the refusal — the refusal stays visible.
    const retained = await registry.get(record.id);
    expect(retained).toBeDefined();
    expect(retained!.dirs).toEqual([estateDir]);
  });

  test('re-landed work (same patch-id upstream, e.g. a rebase dup) does NOT pin a dead estate', async () => {
    const { record, estateDir } = await registerStale();
    const repoDir = await initPushedRepo(path.join(estateDir, 'repo'));
    // A local commit whose CONTENT is upstream under a different sha: commit, push, then
    // rewrite the local commit (amend date) so ancestry no longer matches but patch-id does.
    await fs.writeFile(path.join(repoDir, 'landed.ts'), 'export const landed = 1;\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'landed work']);
    git(repoDir, ['push', 'origin', 'main']);
    git(repoDir, ['commit', '--amend', '--no-edit', '--date', '2020-01-01T00:00:00Z']);

    const result = await new EstateReaper({ registry, apply: true }).sweep();

    expect(result.reports[0].verdict).toBe('reaped');
    expect(await exists(estateDir)).toBe(false);
    expect(await registry.get(record.id)).toBeUndefined();
  });

  test('uncommitted non-lock dirt survives; lockfile-only dirt does not pin (stale-lock rule)', async () => {
    const dirty = await registerStale();
    const dirtyRepo = await initPushedRepo(path.join(dirty.estateDir, 'repo'));
    await fs.writeFile(path.join(dirtyRepo, 'wip.ts'), 'export const wip = true;\n');

    const lockOnly = await registerStale();
    const lockRepo = await initPushedRepo(path.join(lockOnly.estateDir, 'repo'));
    await fs.writeFile(path.join(lockRepo, 'package-lock.json'), '{"regenerated": true}\n');

    const result = await new EstateReaper({ registry, apply: true }).sweep();

    const dirtyReport = result.reports.find((r) => r.estate.id === dirty.record.id)!;
    expect(dirtyReport.verdict).toBe('partial');
    expect(dirtyReport.refusals.join('\n')).toMatch(/uncommitted dirt/);
    expect(await exists(dirtyRepo)).toBe(true);

    const lockReport = result.reports.find((r) => r.estate.id === lockOnly.record.id)!;
    expect(lockReport.verdict).toBe('reaped');
    expect(await exists(lockOnly.estateDir)).toBe(false);
  });

  test('a LIVE-PORT estate survives, even with a stale heartbeat (a serving instance is never swept)', async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    try {
      const { record, estateDir } = await registerStale({ ports: [port] });

      const result = await new EstateReaper({ registry, apply: true }).sweep();

      expect(result.reports[0].verdict).toBe('spared');
      expect(result.reports[0].refusals.join('\n')).toMatch(new RegExp(`port ${port} answering`));
      expect(await exists(estateDir)).toBe(true);
      expect(await registry.get(record.id)).toBeDefined();
    } finally {
      server.close();
    }
  });

  test('a live cwd-verified pid survives on the scheduled path — surfaced, never killed (D-3)', async () => {
    const { record, estateDir } = await registerStale();
    let child: ChildProcess | undefined;
    try {
      child = spawn('node', ['-e', 'setInterval(() => {}, 1000);'], { cwd: estateDir, stdio: 'ignore' });
      await fs.writeFile(
        path.join(registry.estatesDir(), `${record.id}.json`),
        JSON.stringify({ ...record, pids: [child.pid] })
      );

      const result = await new EstateReaper({ registry, apply: true }).sweep();

      expect(result.reports[0].verdict).toBe('spared');
      expect(result.reports[0].refusals.join('\n')).toMatch(/never an automatic kill/);
      expect(await exists(estateDir)).toBe(true);
      expect(child.killed).toBe(false);
      expect(() => process.kill(child!.pid!, 0)).not.toThrow(); // still alive
    } finally {
      child?.kill('SIGKILL');
    }
  });

  test('a DEAD registered pid does not pin (pid gone from the process table = gone)', async () => {
    const dead = spawn('node', ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = dead.pid!;
    await new Promise((resolve) => dead.once('exit', resolve));
    const { record, estateDir } = await registerStale({ pids: [deadPid] });

    const result = await new EstateReaper({ registry, apply: true }).sweep();

    expect(result.reports[0].verdict).toBe('reaped');
    expect(await exists(estateDir)).toBe(false);
    expect(await registry.get(record.id)).toBeUndefined();
  });

  test('a fresh heartbeat spares the estate (dead-by-contract means STALE, nothing else)', async () => {
    const estateDir = path.join(fixtureRoot, 'fresh-estate');
    await fs.mkdir(estateDir, { recursive: true });
    const record = await registry.register({ owner: 'lane-live', dirs: [estateDir] }, { enforceValve: false });

    const result = await new EstateReaper({ registry, apply: true }).sweep();

    expect(result.reports[0].verdict).toBe('spared');
    expect(result.reports[0].reason).toMatch(/heartbeat fresh/);
    expect(await exists(estateDir)).toBe(true);
    expect(await registry.get(record.id)).toBeDefined();
  });

  test('a pinned estate is never auto-reaped', async () => {
    const { record, estateDir } = await registerStale({ pinned: true });

    const result = await new EstateReaper({ registry, apply: true }).sweep();

    expect(result.reports[0].verdict).toBe('spared');
    expect(result.reports[0].reason).toBe('pinned');
    expect(await exists(estateDir)).toBe(true);
    expect(await registry.get(record.id)).toBeDefined();
  });

  test('dry-run (the default) classifies and reports but deletes nothing', async () => {
    const { record, estateDir } = await registerStale();

    const result = await new EstateReaper({ registry }).sweep();

    expect(result.apply).toBe(false);
    expect(result.reports[0].verdict).toBe('reaped');
    expect(result.reports[0].acts.join('\n')).toContain(estateDir);
    expect(await exists(estateDir)).toBe(true);
    expect(await registry.get(record.id)).toBeDefined();
  });

  test("owner-scoped exit sweep: TTL waived, the estate's own cwd-verified pid killed, dirs deleted", async () => {
    const estateDir = path.join(fixtureRoot, 'owner-estate');
    await fs.mkdir(estateDir, { recursive: true });
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000);'], { cwd: estateDir, stdio: 'ignore' });
    const record = await registry.register(
      { owner: 'lane-exiting', dirs: [estateDir], pids: [child.pid!] },
      { enforceValve: false }
    );
    // Fresh heartbeat on purpose: the OWNER sweep must not need staleness.
    const otherDir = path.join(fixtureRoot, 'other-estate');
    await fs.mkdir(otherDir, { recursive: true });
    await registry.register({ owner: 'lane-other', dirs: [otherDir] }, { enforceValve: false });

    try {
      const result = await new EstateReaper({ registry, apply: true, owner: 'lane-exiting' }).sweep();

      expect(result.reports).toHaveLength(1); // scope: only the named owner's estates
      expect(result.reports[0].verdict).toBe('reaped');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(() => process.kill(child.pid!, 0)).toThrow(); // killed
      expect(await exists(estateDir)).toBe(false);
      expect(await registry.get(record.id)).toBeUndefined();
      expect(await exists(otherDir)).toBe(true); // out of scope, untouched
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead — the expected case
      }
    }
  });

  test('a corrupt estate file is reported unreadable and never touched', async () => {
    await fs.mkdir(registry.estatesDir(), { recursive: true });
    const corrupt = path.join(registry.estatesDir(), 'corrupt.json');
    await fs.writeFile(corrupt, '{not json');

    const result = await new EstateReaper({ registry, apply: true }).sweep();

    expect(result.unreadable).toEqual([corrupt]);
    expect(await exists(corrupt)).toBe(true);
  });
});
