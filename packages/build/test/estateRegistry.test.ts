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
    expect(estates[0]).toMatchObject({ owner: 'lane-a', ports: [3041], containers: ['spanner-lane-a'] });

    const before = estates[0].heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await registry.heartbeat(record.id, { pids: [12345, 678] });
    expect(updated!.heartbeatAt).toBeGreaterThan(before);
    expect(updated!.pids).toEqual([12345, 678]);

    expect(await registry.unregister(record.id)).toBe(true);
    expect((await registry.list()).estates).toHaveLength(0);
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
