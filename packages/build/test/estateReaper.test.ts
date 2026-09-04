import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { EstateRegistry } from '../src/EstateRegistry';
import { EstateReaper } from '../src/EstateReaper';
import { SpannerAdminClient } from '../src/EstateDatabaseSweep';

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

// Real git fixtures (init, commit, a bare remote, push) plus the reaper's own git walk (status,
// stash, log, patch-id over the remote) take seconds on a loaded Mac — jest's 5 s default reds
// them spuriously at a 1-min load of ~15 (measured 2026-09-05), and a departure verifier runs
// under exactly that load. The suite's budget is generous; nothing here waits on a real timeout.
jest.setTimeout(60_000);

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
      ['port', 'spanner-lane-x'], // the idle probe: published ports checked for live client conns
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

  test('an IDLE emulator container reaps despite docker-proxy LISTEN on its published port', async () => {
    // docker-proxy LISTENs for the container's whole life — a real socket stands in for it here.
    const proxy = net.createServer();
    const port = await new Promise<number>((resolve) => {
      proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as net.AddressInfo).port));
    });
    try {
      const dockerCalls: string[][] = [];
      const { record, estateDir } = await registerStale({ ports: [port], containers: ['spanner-idle-lane'] });

      const result = await new EstateReaper({
        registry,
        apply: true,
        containerPortsProbe: async () => [port],
        establishedConnsProbe: async () => 0, // no clients — idle
        dockerRun: async (args) => {
          dockerCalls.push(args);
          return { code: 0, stdout: '', stderr: '' };
        },
      }).sweep();

      expect(result.reports[0].verdict).toBe('reaped');
      expect(dockerCalls).toEqual([
        ['stop', 'spanner-idle-lane'],
        ['rm', 'spanner-idle-lane'],
      ]);
      expect(await exists(estateDir)).toBe(false);
      expect(await registry.get(record.id)).toBeUndefined();
    } finally {
      proxy.close();
    }
  });

  test('a container with ESTABLISHED client connections is IN USE — spared and surfaced', async () => {
    const { record, estateDir } = await registerStale({ containers: ['spanner-busy-lane'] });

    const result = await new EstateReaper({
      registry,
      apply: true,
      containerPortsProbe: async () => [9367],
      establishedConnsProbe: async (port) => (port === 9367 ? 2 : 0),
      dockerRun: async () => ({ code: 0, stdout: '', stderr: '' }),
    }).sweep();

    expect(result.reports[0].verdict).toBe('spared');
    expect(result.reports[0].refusals.join('\n')).toMatch(/spanner-busy-lane has 2 live client connections/);
    expect(await exists(estateDir)).toBe(true);
    expect(await registry.get(record.id)).toBeDefined();
  });

  // ── The DATABASE resource class (DEV_ESTATES.md §3.3) ─────────────────────
  const FENCE = { project: 'n3xa-app', instance: 'n3xa-dev', prefix: 'est-' };
  const KEY = Buffer.from('{"type":"service_account"}').toString('base64');
  /** A fake Spanner admin client over `names`; records drops as OUTCOMES. */
  const fakeSpanner = (names: string[], ageDays = 30) => {
    const dropped: string[] = [];
    const client: SpannerAdminClient = {
      instance: (instanceName: string) => ({
        // A dropped database is gone from the next listing, as on the real instance.
        getDatabases: async () => [
          names
            .filter((name) => !dropped.includes(name))
            .map((name) => ({
              formattedName_: `projects/n3xa-app/instances/${instanceName}/databases/${name}`,
              metadata: {
                createTime: { seconds: Math.floor((Date.now() - ageDays * 24 * 3600_000) / 1000), nanos: 0 },
              },
            })),
        ],
        database: (name: string) => ({
          delete: async () => {
            dropped.push(name);
          },
        }),
      }),
      close: () => undefined,
    };
    return { dropped, client };
  };

  test('a dead estate DROPS the database it names with the row (after dirs, before unregister); orphans past the horizon go too', async () => {
    const spanner = fakeSpanner(['est-lane-db', 'est-stray', 'brent-dev-2']);
    const { record, estateDir } = await registerStale({ databases: ['n3xa-app/n3xa-dev/est-lane-db'] });
    const pinnedRow = await registry.register(
      { owner: 'lane-pinned', pinned: true, databases: ['n3xa-app/n3xa-dev/est-pinned'] },
      { enforceValve: false }
    );

    const result = await new EstateReaper({
      registry,
      apply: true,
      databases: { fence: FENCE, env: { GCP_SA_KEY: KEY }, spannerFactory: () => spanner.client },
    }).sweep();

    const report = result.reports.find((r) => r.estate.id === record.id)!;
    expect(report.verdict).toBe('reaped');
    expect(report.acts).toContain('drop database n3xa-app/n3xa-dev/est-lane-db');
    expect(await exists(estateDir)).toBe(false);
    expect(await registry.get(record.id)).toBeUndefined();
    // The orphan sweep ran after the estate pass: the stray (no row, 30d) dropped; the founder's
    // database outside the prefix untouched; the pinned row's database protected by its row.
    expect(spanner.dropped).toEqual(['est-lane-db', 'est-stray']);
    expect(result.databases!.acts).toEqual([
      'drop orphan database n3xa-app/n3xa-dev/est-stray (30.0d old, no registered estate)',
    ]);
    expect(JSON.stringify(result.databases)).not.toContain('brent-dev-2');
    expect(await registry.get(pinnedRow.id)).toBeDefined();
    const receipts = await fs.readFile(path.join(registry.logsDir(), 'reap.log'), 'utf-8');
    expect(receipts).toContain('"estate":"(orphan-databases)"');
    expect(receipts).toContain('est-stray');
  });

  test('a database on a dead row with NO fence configured is a refusal: the row stays, nothing drops', async () => {
    const spanner = fakeSpanner(['est-lane-db']);
    const { record } = await registerStale({ databases: ['n3xa-app/n3xa-dev/est-lane-db'] });

    const result = await new EstateReaper({
      registry,
      apply: true,
      databases: { env: { GCP_SA_KEY: KEY }, spannerFactory: () => spanner.client }, // no fence
    }).sweep();

    expect(result.reports[0].verdict).toBe('failed');
    expect(result.reports[0].refusals.join('\n')).toMatch(/no database fence configured/);
    expect(spanner.dropped).toEqual([]);
    expect(await registry.get(record.id)).toBeDefined();
    expect(result.databases).toBeUndefined(); // no orphan sweep without a fence
  });

  test('a PARTIAL estate (unpushed work) keeps its database with its refused dirs — data goes only when the whole estate does', async () => {
    const spanner = fakeSpanner(['est-lane-db']);
    const { record, estateDir } = await registerStale({ databases: ['n3xa-app/n3xa-dev/est-lane-db'] });
    const repoDir = await initPushedRepo(path.join(estateDir, 'repo'));
    await fs.writeFile(path.join(repoDir, 'unpushed.ts'), 'export const wip = 1;\n');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'unpushed work']);

    const result = await new EstateReaper({
      registry,
      apply: true,
      databases: { fence: FENCE, env: { GCP_SA_KEY: KEY }, spannerFactory: () => spanner.client },
    }).sweep();

    expect(result.reports[0].verdict).toBe('partial');
    expect(spanner.dropped).toEqual([]);
    const retained = await registry.get(record.id);
    expect(retained!.databases).toEqual(['n3xa-app/n3xa-dev/est-lane-db']);
    expect(retained!.note).toMatch(/1 database\(s\) with them/);
    // Still named by a row → the orphan sweep keeps it, whatever its age.
    expect(result.databases!.kept).toEqual(['n3xa-app/n3xa-dev/est-lane-db: named by a registered estate']);
  });

  test("an OWNER exit sweep drops the owner's database but never runs the orphan sweep", async () => {
    const spanner = fakeSpanner(['est-mine', 'est-stray']);
    const { record } = await registerStale({ owner: 'lane-mine', databases: ['n3xa-app/n3xa-dev/est-mine'] });

    const result = await new EstateReaper({
      registry,
      apply: true,
      owner: 'lane-mine',
      databases: { fence: FENCE, env: { GCP_SA_KEY: KEY }, spannerFactory: () => spanner.client },
    }).sweep();

    expect(result.reports[0].verdict).toBe('reaped');
    expect(spanner.dropped).toEqual(['est-mine']);
    expect(result.databases).toBeUndefined();
    expect(await registry.get(record.id)).toBeUndefined();
  });

  test("a dead row's database that ANOTHER registered (live) estate names is refused — the row stays, nothing drops", async () => {
    const spanner = fakeSpanner(['est-shared']);
    const liveDir = path.join(fixtureRoot, 'live-estate');
    await fs.mkdir(liveDir, { recursive: true });
    const live = await registry.register(
      { owner: 'lane-live', dirs: [liveDir], databases: ['n3xa-app/n3xa-dev/est-shared'] },
      { enforceValve: false }
    );
    const { record: dead } = await registerStale({ owner: 'lane-dead', databases: ['n3xa-app/n3xa-dev/est-shared'] });

    const result = await new EstateReaper({
      registry,
      apply: true,
      databases: { fence: FENCE, env: { GCP_SA_KEY: KEY }, spannerFactory: () => spanner.client },
    }).sweep();

    const deadReport = result.reports.find((r) => r.estate.id === dead.id)!;
    expect(deadReport.verdict).toBe('failed');
    expect(deadReport.refusals.join('\n')).toMatch(
      /database n3xa-app\/n3xa-dev\/est-shared: also named by registered estate '.*' \(owner lane-live\) — not dropped/
    );
    expect(spanner.dropped).toEqual([]); // the live estate's database survived
    expect(await registry.get(dead.id)).toBeDefined(); // the refusal stays visible on the row
    expect(await registry.get(live.id)).toBeDefined();
    expect(result.databases!.kept).toEqual(['n3xa-app/n3xa-dev/est-shared: named by a registered estate']);
  });

  test('a credential DENIED the list never wedges the sweep: that row is retained with the refusal, later estates still reap, receipts land, the orphan sweep says why it skipped', async () => {
    const denied: SpannerAdminClient = {
      instance: () => ({
        getDatabases: async () => {
          throw new Error("7 PERMISSION_DENIED: Operation denied by [IAM permission 'spanner.databases.list']");
        },
        database: () => ({
          delete: async () => {
            throw new Error('never reached');
          },
        }),
      }),
      close: () => undefined,
    };
    const withDb = await registerStale({ owner: 'lane-db', databases: ['n3xa-app/n3xa-dev/est-lane-db'] });
    const plain = await registerStale({ owner: 'lane-plain' });

    const result = await new EstateReaper({
      registry,
      apply: true,
      databases: { fence: FENCE, env: { GCP_SA_KEY: KEY }, spannerFactory: () => denied },
    }).sweep();

    const dbReport = result.reports.find((r) => r.estate.id === withDb.record.id)!;
    expect(dbReport.verdict).toBe('failed');
    expect(dbReport.refusals.join('\n')).toMatch(
      /could not list n3xa-app\/n3xa-dev \(.*spanner\.databases\.list.*\) — not dropped/
    );
    expect(await registry.get(withDb.record.id)).toBeDefined();
    const plainReport = result.reports.find((r) => r.estate.id === plain.record.id)!;
    expect(plainReport.verdict).toBe('reaped');
    expect(await exists(plain.estateDir)).toBe(false);
    expect(await registry.get(plain.record.id)).toBeUndefined();
    expect(result.databases!.skipped).toMatch(/could not list .* — orphan sweep skipped/);
    const receipts = await fs.readFile(path.join(registry.logsDir(), 'reap.log'), 'utf-8');
    expect(receipts).toContain(withDb.record.id);
    expect(receipts).toContain(plain.record.id);
    expect(receipts).toContain('"estate":"(orphan-databases)"');
  });

  test('an estate whose sweep THROWS is reported failed and the sweep continues to the next estate', async () => {
    const boom = await registerStale({ owner: 'lane-boom', pids: [process.pid] }); // a pid so the probe runs
    const fine = await registerStale({ owner: 'lane-fine' });

    const result = await new EstateReaper({
      registry,
      apply: true,
      pidProbe: async (_pid, dirs) => {
        if (dirs.includes(boom.estateDir)) {
          throw new Error('lsof exploded');
        }
        return { state: 'dead' };
      },
    }).sweep();

    expect(result.reports).toHaveLength(2);
    const boomReport = result.reports.find((r) => r.estate.id === boom.record.id)!;
    expect(boomReport.verdict).toBe('failed');
    expect(boomReport.reason).toMatch(/lsof exploded/);
    expect(await exists(boom.estateDir)).toBe(true); // nothing acted on the estate that threw
    expect(await registry.get(boom.record.id)).toBeDefined();
    const fineReport = result.reports.find((r) => r.estate.id === fine.record.id)!;
    expect(fineReport.verdict).toBe('reaped');
    expect(await exists(fine.estateDir)).toBe(false);
    const receipts = await fs.readFile(path.join(registry.logsDir(), 'reap.log'), 'utf-8');
    expect(receipts).toContain(boom.record.id);
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
