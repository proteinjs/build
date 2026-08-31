import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { EstateRegistry } from './EstateRegistry';

export type DockerProbe = { healthy: boolean; detail: string };

export type DockerRepairStep = {
  step: string;
  ok: boolean;
  detail?: string;
};

export type DockerRepairResult = {
  probe: DockerProbe;
  /** Whether repair acts actually ran (false = probe-only / gated plan). */
  acted: boolean;
  steps: DockerRepairStep[];
  /** The receipt log file (written whenever acts ran). */
  receiptPath?: string;
};

export type DockerGuardianOptions = {
  registry?: EstateRegistry;
  /**
   * The shared standing-service set this machine expects running (redis cluster nodes, mariadb,
   * spanner-emulator). Config, not code: `<estate home>/docker-standing-set.json` (a JSON string
   * array) is the durable form; this option overrides it for a run.
   */
  standingSet?: string[];
  /** Probe timeout before the daemon is declared wedged (default 10s). */
  probeTimeoutMs?: number;
  /** How long to wait for the engine after relaunch (default 5 min). */
  engineWaitMs?: number;
  // ── Test seams ────────────────────────────────────────────────────────────
  run?: (
    command: string,
    args: string[],
    timeoutMs?: number
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Docker guardianship (RESOURCE_GOVERNANCE §B.4): the wedge-kill-relaunch repair as ONE scripted,
 * logged, deterministic act — still OWNER-GATED per the machine-services single-owner rule (the
 * script exists so the act is one reviewed command, not an improvisation; D-3's split: the PROBE
 * runs automatically, the REPAIR stays the owner's). Every step prints and lands in a receipt log.
 *
 * Also owns the D-6 standing-container policy: `applyRestartPolicies()` sets
 * `--restart unless-stopped` on the shared standing set via `docker update` (no recreate needed),
 * so daemon bounces stop stranding services `Exited` for each lane to rediscover.
 */
export class DockerGuardian {
  private logger = new Logger({ name: 'DockerGuardian' });
  private registry: EstateRegistry;

  constructor(private options: DockerGuardianOptions = {}) {
    this.registry = options.registry ?? new EstateRegistry();
  }

  /** Is the daemon answering? A CLI that cannot answer `docker version` inside the timeout is wedged. */
  async probe(): Promise<DockerProbe> {
    try {
      const result = await this.run('docker', ['version', '--format', '{{.Server.Version}}'], this.probeTimeoutMs());
      if (result.code === 0 && result.stdout.trim().length > 0) {
        return { healthy: true, detail: `daemon answering (server ${result.stdout.trim()})` };
      }
      return {
        healthy: false,
        detail: `docker version exited ${result.code}: ${(result.stderr || result.stdout).trim()}`,
      };
    } catch (error) {
      return { healthy: false, detail: `docker CLI did not answer: ${error instanceof Error ? error.message : error}` };
    }
  }

  /**
   * The repair act. Without `confirm` this NEVER acts: it probes, prints the plan, and reports —
   * the gate is mechanical, not just procedural. With `confirm` (the owner's go): quit Docker
   * Desktop cleanly (escalating to an exact-name kill only if the quit times out), relaunch, wait
   * for the engine, then verify the standing set (starting exited members). Healthy daemons skip
   * straight to standing-set verification.
   */
  async repair(confirm: boolean): Promise<DockerRepairResult> {
    const probe = await this.probe();
    const result: DockerRepairResult = { probe, acted: false, steps: [] };

    if (probe.healthy) {
      result.acted = true; // standing-set verification is part of guardianship, not the gated wedge repair
      await this.verifyStandingSet(result);
      this.writeReceipt(result);
      return result;
    }
    if (!confirm) {
      result.steps.push({
        step: "GATED: daemon is wedged; repair plan = quit Docker Desktop → relaunch → wait for engine → verify standing set. Run again with --yes after the owner's go.",
        ok: true,
      });
      return result;
    }

    result.acted = true;
    await this.step(result, 'quit Docker Desktop (osascript)', async () => {
      await this.run('osascript', ['-e', 'quit app "Docker"'], 15_000).catch(() => undefined);
      const gone = await this.waitFor(async () => !(await this.dockerAppRunning()), 60_000);
      if (!gone) {
        // Escalation, exact process names only (never a name-pattern pkill).
        await this.run('pkill', ['-x', 'Docker Desktop'], 10_000).catch(() => undefined);
        await this.run('pkill', ['-x', 'Docker'], 10_000).catch(() => undefined);
        const killed = await this.waitFor(async () => !(await this.dockerAppRunning()), 20_000);
        if (!killed) {
          throw new Error('Docker Desktop still running after quit + exact-name kill');
        }
        return 'quit timed out; escalated to exact-name kill';
      }
      return 'clean quit';
    });
    await this.step(result, 'relaunch Docker Desktop (open -a Docker)', async () => {
      const opened = await this.run('open', ['-a', 'Docker'], 30_000);
      if (opened.code !== 0) {
        throw new Error(opened.stderr.trim() || `open exited ${opened.code}`);
      }
      return undefined;
    });
    await this.step(result, `wait for engine (up to ${Math.round(this.engineWaitMs() / 60_000)}m)`, async () => {
      const up = await this.waitFor(async () => (await this.probe()).healthy, this.engineWaitMs());
      if (!up) {
        throw new Error('engine did not come up inside the wait ceiling');
      }
      return undefined;
    });
    await this.verifyStandingSet(result);
    this.writeReceipt(result);
    return result;
  }

  /**
   * D-6: `--restart unless-stopped` on the shared standing set via `docker update` — services
   * self-heal across daemon bounces instead of stranding `Exited`. One receipt line per container.
   */
  async applyRestartPolicies(): Promise<DockerRepairResult> {
    const probe = await this.probe();
    const result: DockerRepairResult = { probe, acted: false, steps: [] };
    if (!probe.healthy) {
      result.steps.push({
        step: 'apply restart policies',
        ok: false,
        detail: `daemon not answering (${probe.detail})`,
      });
      return result;
    }
    result.acted = true;
    const standingSet = await this.standingSet();
    if (standingSet.length === 0) {
      result.steps.push({
        step: 'apply restart policies',
        ok: false,
        detail: `standing set is empty — declare it in ${this.standingSetPath()} (JSON string array of container names)`,
      });
      return result;
    }
    for (const container of standingSet) {
      await this.step(result, `docker update --restart unless-stopped ${container}`, async () => {
        const updated = await this.run('docker', ['update', '--restart', 'unless-stopped', container], 30_000);
        if (updated.code !== 0) {
          throw new Error(updated.stderr.trim() || `exited ${updated.code}`);
        }
        return undefined;
      });
    }
    this.writeReceipt(result);
    return result;
  }

  /** The standing set: option override, else the config file, else empty (machine names are config, not code). */
  async standingSet(): Promise<string[]> {
    if (this.options.standingSet) {
      return this.options.standingSet;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.standingSetPath(), 'utf-8'));
      return Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string') : [];
    } catch {
      return [];
    }
  }

  async saveStandingSet(containers: string[]): Promise<void> {
    await fs.mkdir(this.registry.homePath(), { recursive: true });
    await fs.writeFile(this.standingSetPath(), JSON.stringify(containers, null, 2) + '\n');
  }

  standingSetPath(): string {
    return path.join(this.registry.homePath(), 'docker-standing-set.json');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Each standing member must be Running; exited members are started (policies doing their job). */
  private async verifyStandingSet(result: DockerRepairResult): Promise<void> {
    const standingSet = await this.standingSet();
    if (standingSet.length === 0) {
      result.steps.push({
        step: 'verify standing set',
        ok: true,
        detail: `no standing set declared (${this.standingSetPath()})`,
      });
      return;
    }
    for (const container of standingSet) {
      await this.step(result, `verify ${container} running`, async () => {
        const state = await this.run('docker', ['inspect', '-f', '{{.State.Running}}', container], 30_000);
        if (state.code !== 0) {
          throw new Error(`not found (${state.stderr.trim() || state.code})`);
        }
        if (state.stdout.trim() === 'true') {
          return 'running';
        }
        const started = await this.run('docker', ['start', container], 60_000);
        if (started.code !== 0) {
          throw new Error(`stopped, and docker start failed: ${started.stderr.trim() || started.code}`);
        }
        return 'was stopped — started';
      });
    }
  }

  private async step(result: DockerRepairResult, step: string, act: () => Promise<string | undefined>): Promise<void> {
    try {
      const detail = await act();
      result.steps.push({ step, ok: true, detail });
      this.logger.info({ message: `> ${step}${detail ? ` — ${detail}` : ''}` });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result.steps.push({ step, ok: false, detail });
      this.logger.error({ message: `> ${step} FAILED — ${detail}` });
    }
  }

  private async dockerAppRunning(): Promise<boolean> {
    const result = await this.run('pgrep', ['-x', 'Docker Desktop'], 10_000).catch(() => undefined);
    if (result?.code === 0) {
      return true;
    }
    const legacy = await this.run('pgrep', ['-x', 'Docker'], 10_000).catch(() => undefined);
    return legacy?.code === 0;
  }

  private async waitFor(check: () => Promise<boolean>, ceilingMs: number): Promise<boolean> {
    const startedAt = Date.now();
    for (;;) {
      if (await check()) {
        return true;
      }
      if (Date.now() - startedAt >= ceilingMs) {
        return false;
      }
      await this.sleep(2000);
    }
  }

  private writeReceipt(result: DockerRepairResult): void {
    try {
      fsSync.mkdirSync(this.registry.logsDir(), { recursive: true });
      const receiptPath = path.join(
        this.registry.logsDir(),
        `docker-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
      );
      const lines = [
        `probe: ${result.probe.healthy ? 'healthy' : 'WEDGED'} — ${result.probe.detail}`,
        ...result.steps.map((s) => `${s.ok ? 'ok  ' : 'FAIL'} ${s.step}${s.detail ? ` — ${s.detail}` : ''}`),
      ];
      fsSync.writeFileSync(receiptPath, lines.join('\n') + '\n');
      result.receiptPath = receiptPath;
    } catch (error) {
      this.logger.warn({ message: `receipt write failed: ${error instanceof Error ? error.message : error}` });
    }
  }

  private async run(
    command: string,
    args: string[],
    timeoutMs?: number
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.options.run) {
      return this.options.run(command, args, timeoutMs);
    }
    return this.withTimeout(
      cmd(command, args, undefined, { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }),
      timeoutMs ?? 30_000,
      `${command} ${args.join(' ')}`
    );
  }

  /** A wedged daemon hangs the CLI — every raw call gets a deadline. */
  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    });
    try {
      return await Promise.race([promise, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (this.options.sleep) {
      return this.options.sleep(ms);
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private probeTimeoutMs(): number {
    return this.options.probeTimeoutMs ?? 10_000;
  }

  private engineWaitMs(): number {
    return this.options.engineWaitMs ?? 5 * 60_000;
  }
}
