import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { EstateRegistry } from '../src/EstateRegistry';
import { LogGovernor } from '../src/LogGovernor';

/**
 * The dev-log governor (the 21GB dev-server.log incident, 2026-08-31): over-cap logs under
 * registered estates (and explicit watchLogs) rotate to `.prev` when unheld; a log HELD by a
 * live writer is surfaced with the pid and NEVER truncated or rotated. Outcome-asserted:
 * files on disk after the pass.
 */

const exists = async (p: string) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const CAP = 1024; // 1KB cap so fixtures stay tiny

describe('LogGovernor', () => {
  let fixtureRoot: string;
  let registry: EstateRegistry;

  beforeEach(async () => {
    fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'log-governor-test-')));
    registry = new EstateRegistry(path.join(fixtureRoot, '.n3xa'));
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  const estateWithLog = async (logName: string, bytes: number) => {
    const estateDir = path.join(fixtureRoot, `estate-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(path.dirname(path.join(estateDir, logName)), { recursive: true });
    const logPath = path.join(estateDir, logName);
    await fs.writeFile(logPath, Buffer.alloc(bytes, 120));
    await registry.register({ owner: 'lane-test', dirs: [estateDir] }, { enforceValve: false });
    return logPath;
  };

  test('an over-cap unheld dev-server.log rotates to .prev (replacing the previous generation)', async () => {
    const logPath = await estateWithLog('dev-server.log', 4 * CAP);
    await fs.writeFile(`${logPath}.prev`, 'old generation');

    const report = await new LogGovernor({ registry, capBytes: CAP, writerProbe: async () => [] }).govern();

    expect(report.rotated).toHaveLength(1);
    expect(report.rotated[0].logPath).toBe(logPath);
    expect(await exists(logPath)).toBe(false); // rotated away; the next launch starts fresh
    const prev = await fs.readFile(`${logPath}.prev`);
    expect(prev.length).toBe(4 * CAP); // the big log IS the new .prev; the old generation is gone
    expect(report.acts.join('\n')).toContain(`rotated ${logPath}`);
  });

  test('an over-cap log HELD by a live writer is surfaced with the pid — never rotated or truncated', async () => {
    const logPath = await estateWithLog('dev-server.log', 4 * CAP);

    const report = await new LogGovernor({ registry, capBytes: CAP, writerProbe: async () => [4242] }).govern();

    expect(report.rotated).toHaveLength(0);
    expect(report.held).toEqual([{ logPath, bytes: 4 * CAP, pids: [4242] }]);
    expect(report.acts.join('\n')).toMatch(/HELD by live writer.*pid 4242.*restart/);
    expect((await fs.stat(logPath)).size).toBe(4 * CAP); // untouched
  });

  test('an under-cap log is left alone', async () => {
    const logPath = await estateWithLog('serve.log', 100);

    const report = await new LogGovernor({ registry, capBytes: CAP, writerProbe: async () => [] }).govern();

    expect(report.rotated).toHaveLength(0);
    expect(report.held).toHaveLength(0);
    expect((await fs.stat(logPath)).size).toBe(100);
  });

  test('watchLogs governs the manual-redirect class (a log registration cannot see)', async () => {
    const logPath = path.join(fixtureRoot, 'manual', 'dev-server.log');
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, Buffer.alloc(3 * CAP, 120));

    const report = await new LogGovernor({
      registry,
      capBytes: CAP,
      watchLogs: [logPath],
      writerProbe: async () => [],
    }).govern();

    expect(report.rotated.map((r) => r.logPath)).toEqual([logPath]);
    expect(await exists(logPath)).toBe(false);
    expect(await exists(`${logPath}.prev`)).toBe(true);
  });

  test('report-only mode (apply false) names the rotation but leaves the file', async () => {
    const logPath = await estateWithLog('dev-server.log', 2 * CAP);

    const report = await new LogGovernor({
      registry,
      capBytes: CAP,
      apply: false,
      writerProbe: async () => [],
    }).govern();

    expect(report.rotated).toHaveLength(1);
    expect(await exists(logPath)).toBe(true); // reported, not acted
    expect(await exists(`${logPath}.prev`)).toBe(false);
  });

  test('.serve-package/serve.log under an estate dir is in the governed set', async () => {
    const logPath = await estateWithLog(path.join('.serve-package', 'serve.log'), 2 * CAP);

    const report = await new LogGovernor({ registry, capBytes: CAP, writerProbe: async () => [] }).govern();

    expect(report.rotated.map((r) => r.logPath)).toEqual([logPath]);
    expect(await exists(`${logPath}.prev`)).toBe(true);
  });
});
