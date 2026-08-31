import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { DockerGuardian } from '../src/DockerGuardian';
import { EstateRegistry } from '../src/EstateRegistry';

/**
 * Docker guardianship (RESOURCE_GOVERNANCE §B.4): the repair is ONE scripted, logged act that
 * stays OWNER-GATED — a wedged daemon without --yes gets a plan, never an act. Runner injected;
 * assertions are the commands actually issued plus the receipt on disk.
 */

type Call = { command: string; args: string[] };

describe('DockerGuardian', () => {
  let home: string;
  let registry: EstateRegistry;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-guardian-test-'));
    registry = new EstateRegistry(home);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const ok = { code: 0, stdout: '', stderr: '' };

  test('a wedged daemon WITHOUT --yes: plan printed, zero acts (the gate is mechanical)', async () => {
    const calls: Call[] = [];
    const guardian = new DockerGuardian({
      registry,
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === 'docker') {
          return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
        }
        return ok;
      },
    });

    const result = await guardian.repair(false);

    expect(result.probe.healthy).toBe(false);
    expect(result.acted).toBe(false);
    expect(result.steps[0].step).toMatch(/GATED/);
    // The ONLY command issued was the probe — no quit, no relaunch, no kills.
    expect(calls).toEqual([{ command: 'docker', args: ['version', '--format', '{{.Server.Version}}'] }]);
  });

  test('a wedged daemon WITH --yes: quit -> relaunch -> wait -> verify standing set, receipt written', async () => {
    await new DockerGuardian({ registry, run: async () => ok }).saveStandingSet(['spanner-emulator', 'mariadb']);
    const calls: Call[] = [];
    let dockerHealthy = false;
    let dockerAppAlive = true;
    const guardian = new DockerGuardian({
      registry,
      sleep: async () => undefined,
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === 'docker' && args[0] === 'version') {
          return dockerHealthy
            ? { code: 0, stdout: '24.0.0\n', stderr: '' }
            : { code: 1, stdout: '', stderr: 'daemon down' };
        }
        if (command === 'osascript') {
          dockerAppAlive = false;
          return ok;
        }
        if (command === 'pgrep') {
          return dockerAppAlive ? ok : { code: 1, stdout: '', stderr: '' };
        }
        if (command === 'open') {
          dockerHealthy = true;
          return ok;
        }
        if (command === 'docker' && args[0] === 'inspect') {
          const container = args[args.length - 1];
          // mariadb is running; spanner-emulator stranded Exited — the policy-verify must start it.
          return { code: 0, stdout: container === 'mariadb' ? 'true\n' : 'false\n', stderr: '' };
        }
        return ok;
      },
    });

    const result = await guardian.repair(true);

    expect(result.acted).toBe(true);
    expect(result.steps.every((step) => step.ok)).toBe(true);
    expect(calls).toContainEqual({ command: 'osascript', args: ['-e', 'quit app "Docker"'] });
    expect(calls).toContainEqual({ command: 'open', args: ['-a', 'Docker'] });
    expect(calls).toContainEqual({ command: 'docker', args: ['start', 'spanner-emulator'] });
    expect(calls.map((call) => call.command)).not.toContain('pkill'); // clean quit — no kill escalation
    const receipt = await fs.readFile(result.receiptPath!, 'utf-8');
    expect(receipt).toMatch(/WEDGED/);
    expect(receipt).toMatch(/verify spanner-emulator running.*was stopped — started/);
  });

  test('a healthy daemon skips the wedge repair and only verifies the standing set', async () => {
    await new DockerGuardian({ registry, run: async () => ok }).saveStandingSet(['mariadb']);
    const calls: Call[] = [];
    const guardian = new DockerGuardian({
      registry,
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === 'docker' && args[0] === 'version') {
          return { code: 0, stdout: '24.0.0\n', stderr: '' };
        }
        if (command === 'docker' && args[0] === 'inspect') {
          return { code: 0, stdout: 'true\n', stderr: '' };
        }
        return ok;
      },
    });

    const result = await guardian.repair(false);

    expect(result.probe.healthy).toBe(true);
    expect(calls.map((call) => call.command)).not.toContain('osascript');
    expect(result.steps).toEqual([
      expect.objectContaining({ step: 'verify mariadb running', ok: true, detail: 'running' }),
    ]);
  });

  test('applyRestartPolicies (D-6): docker update --restart unless-stopped on the standing set, one receipt line each', async () => {
    const calls: Call[] = [];
    const guardian = new DockerGuardian({
      registry,
      standingSet: ['n3xa-redis-node-0-1', 'mariadb'],
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === 'docker' && args[0] === 'version') {
          return { code: 0, stdout: '24.0.0\n', stderr: '' };
        }
        return ok;
      },
    });

    const result = await guardian.applyRestartPolicies();

    expect(result.acted).toBe(true);
    expect(calls).toContainEqual({
      command: 'docker',
      args: ['update', '--restart', 'unless-stopped', 'n3xa-redis-node-0-1'],
    });
    expect(calls).toContainEqual({ command: 'docker', args: ['update', '--restart', 'unless-stopped', 'mariadb'] });
    expect(result.steps.every((step) => step.ok)).toBe(true);
  });

  test('an empty standing set is a loud config ask, not a silent no-op', async () => {
    const guardian = new DockerGuardian({
      registry,
      run: async () => ({ code: 0, stdout: '24.0.0\n', stderr: '' }),
    });

    const result = await guardian.applyRestartPolicies();

    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].detail).toContain('docker-standing-set.json');
  });
});
