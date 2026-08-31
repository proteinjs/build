import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { EstateRegistry } from '../src/EstateRegistry';
import { EstateReaper } from '../src/EstateReaper';
import { PressureValve } from '../src/PressureValve';

/**
 * The local pressure valve (RESOURCE_GOVERNANCE §B.3): soft sweeps + notes, hard flips the
 * refusal flag, memory pressure turns the -w=1 advisory the jest preset reads — and the valve
 * NEVER kills anything (D-3's local half). Facts are seam-injected; acts are asserted as
 * outcomes (files on disk, registry refusals, sweep receipts).
 */

const GB = 1;

describe('PressureValve', () => {
  let home: string;
  let registry: EstateRegistry;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pressure-valve-test-'));
    registry = new EstateRegistry(home);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const valve = (
    freeGb: number,
    memUsedPct: number,
    overrides: Partial<ConstructorParameters<typeof PressureValve>[0]> = {}
  ) =>
    new PressureValve({
      registry,
      diskFacts: async () => ({ totalGb: 460 * GB, freeGb }),
      memoryFacts: async () => ({ totalGb: 100, availableGb: 100 - memUsedPct }),
      ...overrides,
    });

  const advisoryPath = () => path.join(registry.advisoriesDir(), 'jest-workers');
  const exists = async (p: string) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  };

  test('all-clear: level ok, no refusal, no advisory, no note', async () => {
    const evaluation = await valve(200, 40).evaluate();

    expect(evaluation.pressure.level).toBe('ok');
    expect(evaluation.sweep).toBeUndefined();
    expect(await exists(advisoryPath())).toBe(false);
    expect(await exists(path.join(home, 'PRESSURE.md'))).toBe(false);
    await expect(registry.register({ owner: 'lane-x' })).resolves.toBeDefined(); // no refusal
  });

  test('disk SOFT: dead-by-contract sweep runs (through the reaper, safety rules intact) + pressure note written', async () => {
    // A dead estate (stale heartbeat) that the triggered sweep should reap.
    const estateDir = path.join(home, 'dead-estate');
    await fs.mkdir(estateDir, { recursive: true });
    const record = await registry.register({ owner: 'lane-dead', dirs: [estateDir] }, { enforceValve: false });
    await fs.writeFile(
      path.join(registry.estatesDir(), `${record.id}.json`),
      JSON.stringify({ ...record, heartbeatAt: Date.now() - 40 * 3600_000 })
    );

    const evaluation = await valve(30, 40).evaluate();

    expect(evaluation.pressure.level).toBe('soft');
    expect(evaluation.sweep!.reports[0].verdict).toBe('reaped');
    expect(await exists(estateDir)).toBe(false);
    const note = await fs.readFile(path.join(home, 'PRESSURE.md'), 'utf-8');
    expect(note).toMatch(/SOFT/);
    expect(note).toMatch(/30\.0 GiB free/);
    // Soft does NOT refuse new estates.
    await expect(registry.register({ owner: 'lane-x' })).resolves.toBeDefined();
  });

  test('disk HARD: refusal flag flips — estate register starts refusing with the real numbers', async () => {
    const evaluation = await valve(11, 40).evaluate();

    expect(evaluation.pressure.level).toBe('hard');
    await expect(registry.register({ owner: 'lane-new' })).rejects.toThrow(/11\.0 GiB free/);
    const note = await fs.readFile(path.join(home, 'PRESSURE.md'), 'utf-8');
    expect(note).toMatch(/HARD/);
    expect(note).toMatch(/No processes were killed/);
  });

  test('the valve never kills: a live-pid estate survives a HARD sweep (refusal surfaced)', async () => {
    const estateDir = path.join(home, 'live-estate');
    await fs.mkdir(estateDir, { recursive: true });
    const record = await registry.register(
      { owner: 'lane-live', dirs: [estateDir], pids: [process.pid] },
      { enforceValve: false }
    );
    await fs.writeFile(
      path.join(registry.estatesDir(), `${record.id}.json`),
      JSON.stringify({ ...record, heartbeatAt: Date.now() - 40 * 3600_000 })
    );

    const evaluation = await valve(11, 40, {
      reaper: new EstateReaper({
        registry,
        apply: true,
        pidProbe: async () => ({ state: 'alive-ours', cwd: estateDir }),
      }),
    }).evaluate();

    expect(evaluation.sweep!.reports[0].verdict).toBe('spared');
    expect(evaluation.sweep!.reports[0].refusals.join('\n')).toMatch(/never an automatic kill/);
    expect(await exists(estateDir)).toBe(true);
  });

  test('memory pressure drops the -w=1 advisory; clearing pressure clears it', async () => {
    await valve(200, 85).evaluate();
    expect((await fs.readFile(advisoryPath(), 'utf-8')).trim()).toBe('1');

    const cleared = await valve(200, 40).evaluate();
    expect(await exists(advisoryPath())).toBe(false);
    expect(cleared.acts.join('\n')).toMatch(/advisory cleared/);
  });

  test('memory HARD requires SUSTAINED samples: one spike is soft, the second consecutive one is hard', async () => {
    const first = await valve(200, 95).evaluate();
    expect(first.pressure.memory.level).toBe('soft'); // spike — not yet sustained
    expect(first.pressure.level).toBe('soft');

    const second = await valve(200, 95).evaluate();
    expect(second.pressure.memory.level).toBe('hard'); // sustained across two samples
    expect(second.pressure.level).toBe('hard');
    await expect(registry.register({ owner: 'lane-new' })).rejects.toThrow(/memory HARD/);
  });

  test('valves are config: ~/.n3xa/valves.json overrides the defaults', async () => {
    await fs.writeFile(path.join(home, 'valves.json'), JSON.stringify({ diskSoftFreeGb: 300 }));

    const evaluation = await valve(200, 40).evaluate();

    expect(evaluation.pressure.level).toBe('soft'); // 200 < the configured 300 soft line
  });

  test('probe mode (apply: false) evaluates without writing anything', async () => {
    const evaluation = await valve(11, 95, { apply: false, sweepOnPressure: false }).evaluate();

    expect(evaluation.pressure.level).toBe('hard');
    expect(await registry.readPressure()).toBeUndefined();
    expect(await exists(advisoryPath())).toBe(false);
    expect(await exists(path.join(home, 'PRESSURE.md'))).toBe(false);
  });
});
