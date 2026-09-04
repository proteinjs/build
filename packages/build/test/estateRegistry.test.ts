import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { EstateRefusedError, EstateRegistry, PressureState } from '../src/EstateRegistry';

describe('EstateRegistry', () => {
  let home: string;
  let registry: EstateRegistry;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'estate-registry-test-'));
    registry = new EstateRegistry(home);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const hardPressure = (): PressureState => ({
    capturedAt: Date.now(),
    level: 'hard',
    disk: { totalGb: 460, freeGb: 6.5, level: 'hard' },
    memory: { totalGb: 32, availableGb: 10, usedPct: 69, level: 'ok' },
    summary: 'disk HARD: 6.5 GiB free of 460 (soft <40, hard <15)',
  });

  test('register + list + heartbeat + unregister round-trip', async () => {
    const record = await registry.register({
      owner: 'lane-a',
      ports: [3041],
      dirs: [path.join(home, 'scratch')],
      containers: ['spanner-lane-a'],
      pids: [12345],
    });
    expect(record.id).toContain('lane-a');
    expect(record.heartbeatAt).toBeGreaterThan(0);

    const { estates } = await registry.list();
    expect(estates).toHaveLength(1);
    expect(estates[0]).toMatchObject({ owner: 'lane-a', ports: [3041], containers: ['spanner-lane-a'], databases: [] });

    const before = estates[0].heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await registry.heartbeat(record.id, { pids: [12345, 678] });
    expect(updated!.heartbeatAt).toBeGreaterThan(before);
    expect(updated!.pids).toEqual([12345, 678]);

    expect(await registry.unregister(record.id)).toBe(true);
    expect((await registry.list()).estates).toHaveLength(0);
  });

  test('databases ride the record (register, list, heartbeat patch) and a pre-field row reads as none', async () => {
    const record = await registry.register(
      { owner: 'lane-db', databases: ['n3xa-app/n3xa-dev/est-lane-db'] },
      { enforceValve: false }
    );
    expect(record.databases).toEqual(['n3xa-app/n3xa-dev/est-lane-db']);
    expect((await registry.list()).estates[0].databases).toEqual(['n3xa-app/n3xa-dev/est-lane-db']);
    const patched = await registry.heartbeat(record.id, {
      databases: ['n3xa-app/n3xa-dev/est-lane-db', 'n3xa-app/n3xa-dev/est-lane-db-vm'],
    });
    expect(patched!.databases).toHaveLength(2);
    // A row written before the field existed: the reaper treats a missing field as none.
    await fs.writeFile(
      path.join(registry.estatesDir(), 'legacy.json'),
      JSON.stringify({
        id: 'legacy',
        owner: 'old',
        ports: [],
        dirs: [],
        containers: [],
        pids: [],
        startedAt: 1,
        heartbeatAt: 1,
      })
    );
    const legacy = (await registry.list()).estates.find((e) => e.id === 'legacy')!;
    expect(legacy.databases).toBeUndefined();
  });

  test('under HARD pressure the valve-enforced register path REFUSES, with the real numbers', async () => {
    registry.writePressureSync(hardPressure());

    await expect(registry.register({ owner: 'lane-new' })).rejects.toThrow(EstateRefusedError);
    await expect(registry.register({ owner: 'lane-new' })).rejects.toThrow(/6\.5 GiB free/);
    expect((await registry.list()).estates).toHaveLength(0);
  });

  test('ambient registrants (enforceValve: false) still register under HARD pressure — visibility first', async () => {
    registry.writePressureSync(hardPressure());

    const record = await registry.register({ owner: 'serve-package:@n3xa/app-server' }, { enforceValve: false });
    expect((await registry.list()).estates).toEqual([expect.objectContaining({ id: record.id })]);
  });

  test('soft pressure does not refuse registrations', async () => {
    registry.writePressureSync({ ...hardPressure(), level: 'soft' });

    await expect(registry.register({ owner: 'lane-soft' })).resolves.toBeDefined();
  });

  test('catastrophic dir claims are unrepresentable (root/home are never estate dirs)', async () => {
    await expect(registry.register({ owner: 'lane-bad', dirs: [os.homedir()] })).rejects.toThrow(/home directory/);
    await expect(registry.register({ owner: 'lane-bad', dirs: ['/'] })).rejects.toThrow(/filesystem root/);
  });

  test('same id re-registers (no accumulation); corrupt files list as unreadable, never touched', async () => {
    await registry.register({ id: 'stable-id', owner: 'lane-a' });
    await registry.register({ id: 'stable-id', owner: 'lane-a-relaunched' });
    const corruptPath = path.join(registry.estatesDir(), 'corrupt.json');
    await fs.writeFile(corruptPath, '{not json');

    const { estates, unreadable } = await registry.list();
    expect(estates).toHaveLength(1);
    expect(estates[0].owner).toBe('lane-a-relaunched');
    expect(unreadable).toEqual([corruptPath]);
    await expect(fs.access(corruptPath)).resolves.toBeUndefined();
  });
});
