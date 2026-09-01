import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { EstateRegistry, PressureLevel, PressureState } from './EstateRegistry';
import { EstateReaper, ReapEstatesResult } from './EstateReaper';
import { LogGovernor, LogGovernorReport } from './LogGovernor';

/**
 * Declared local watermarks (RESOURCE_GOVERNANCE D-2 defaults). Overridable via
 * `<estate home>/valves.json` — configuration, visible and tunable, never code edits.
 */
export type ValveConfig = {
  diskSoftFreeGb: number;
  diskHardFreeGb: number;
  memSoftPct: number;
  memHardPct: number;
  /** Dev-log rotation cap (LogGovernor), in GiB. */
  logCapGb: number;
  /** Extra absolute log paths the governor watches (the manual `nohup > dev-server.log` class). */
  watchLogs: string[];
};

export const DEFAULT_VALVES: ValveConfig = {
  diskSoftFreeGb: 40,
  diskHardFreeGb: 15,
  memSoftPct: 80,
  memHardPct: 92,
  logCapGb: 1,
  watchLogs: [],
};

export type ValveEvaluation = {
  pressure: PressureState;
  /** Acts the valve took (or would take without apply), one line each. */
  acts: string[];
  /** The dead-by-contract sweep triggered at soft+ (undefined when below soft or sweeping disabled). */
  sweep?: ReapEstatesResult;
  /** The dev-log governor pass (every run — a runaway log is its own contract, not a pressure act). */
  logs?: LogGovernorReport;
};

export type PressureValveOptions = {
  registry?: EstateRegistry;
  valves?: Partial<ValveConfig>;
  /** Run the reaper's dead-by-contract sweep at soft+ (default true; --no-sweep for probes). */
  sweepOnPressure?: boolean;
  /** Actually act (sweep applies, files written). Default true — the watchdog exists to act. */
  apply?: boolean;
  // ── Test seams ────────────────────────────────────────────────────────────
  diskFacts?: () => Promise<{ totalGb: number; freeGb: number }>;
  memoryFacts?: () => Promise<{ totalGb: number; availableGb: number }>;
  reaper?: EstateReaper;
  logGovernor?: LogGovernor;
  now?: () => number;
};

/**
 * The local pressure valve (`estate-watchdog`, RESOURCE_GOVERNANCE §B.3): a single-shot
 * evaluation (launchd runs it every 15 minutes) of the declared disk/memory watermarks, acting
 * only inside the §B.5 judgment line:
 *
 *  - SOFT: run the reaper's dead-by-contract sweep and write a pressure note the coordinator's
 *    next turn surfaces (`PRESSURE.md`).
 *  - HARD: additionally flip the refusal flag (pressure.json level=hard — `estate register`
 *    consults it and refuses NEW estates with the real numbers). Existing estates are NEVER
 *    killed by the valve; locally there are no automatic kills, ever (D-3) — the OS OOM-killer
 *    stops being the first responder because nothing new lands on a saturated machine.
 *  - MEMORY pressure (soft+) drops the `-w=1` throttle as machine output: an advisory file the
 *    jest preset's `workers()` knob reads (env still wins; serial pins are unaffected). Cleared
 *    when memory pressure clears — the standing coordinator practice, as product.
 *
 * "Sustained" for memory-hard means two consecutive watchdog samples at/above the hard line —
 * history rides pressure.json's memorySamples so single-shot runs can judge it. Loud logging,
 * never silent acts.
 */
export class PressureValve {
  private logger = new Logger({ name: 'PressureValve' });
  private registry: EstateRegistry;

  constructor(private options: PressureValveOptions = {}) {
    this.registry = options.registry ?? new EstateRegistry();
  }

  async evaluate(): Promise<ValveEvaluation> {
    const apply = this.options.apply ?? true;
    const now = (this.options.now ?? Date.now)();
    const valves = await this.loadValves();
    const disk = await this.diskFacts();
    const memory = await this.memoryFacts();
    const previous = await this.registry.readPressure();

    const diskLevel: PressureLevel =
      disk.freeGb < valves.diskHardFreeGb ? 'hard' : disk.freeGb < valves.diskSoftFreeGb ? 'soft' : 'ok';
    const usedPct = memory.totalGb > 0 ? ((memory.totalGb - memory.availableGb) / memory.totalGb) * 100 : 0;
    const samples = [...(previous?.memorySamples ?? []), { at: now, usedPct }].slice(-PressureValve.MAX_SAMPLES);
    const previousSample = samples.length >= 2 ? samples[samples.length - 2] : undefined;
    // Hard memory must be SUSTAINED (two consecutive samples) — one jest spike is not a wall.
    const memHardSustained = usedPct >= valves.memHardPct && (previousSample?.usedPct ?? 0) >= valves.memHardPct;
    const memLevel: PressureLevel = memHardSustained ? 'hard' : usedPct >= valves.memSoftPct ? 'soft' : 'ok';
    const level: PressureLevel =
      diskLevel === 'hard' || memLevel === 'hard'
        ? 'hard'
        : diskLevel === 'soft' || memLevel === 'soft'
          ? 'soft'
          : 'ok';

    const summaryParts: string[] = [];
    if (diskLevel !== 'ok') {
      summaryParts.push(
        `disk ${diskLevel.toUpperCase()}: ${disk.freeGb.toFixed(1)} GiB free of ${disk.totalGb.toFixed(0)} (soft <${valves.diskSoftFreeGb}, hard <${valves.diskHardFreeGb})`
      );
    }
    if (memLevel !== 'ok') {
      summaryParts.push(
        `memory ${memLevel.toUpperCase()}: ${usedPct.toFixed(0)}% used${memHardSustained ? ' (sustained)' : ''} (soft ≥${valves.memSoftPct}%, hard ≥${valves.memHardPct}% sustained)`
      );
    }
    const pressure: PressureState = {
      capturedAt: now,
      level,
      disk: { totalGb: disk.totalGb, freeGb: disk.freeGb, level: diskLevel },
      memory: { totalGb: memory.totalGb, availableGb: memory.availableGb, usedPct, level: memLevel },
      load1: os.loadavg()[0],
      memorySamples: samples,
      summary: summaryParts.join('; ') || undefined,
    };

    const evaluation: ValveEvaluation = { pressure, acts: [] };
    if (apply) {
      this.registry.writePressureSync(pressure);
      evaluation.acts.push(
        level === 'hard'
          ? `refusal flag UP (pressure.json level=hard): estate register refuses new estates — ${pressure.summary}`
          : `pressure.json updated (level=${level})`
      );
    }

    // Memory throttle advisory (machine output for the -w=1 practice).
    if (memLevel !== 'ok') {
      evaluation.acts.push(`jest-workers advisory dropped (-w=1): memory at ${usedPct.toFixed(0)}%`);
      if (apply) {
        this.writeAdvisorySync('jest-workers', '1');
      }
    } else if (apply && this.clearAdvisorySync('jest-workers')) {
      evaluation.acts.push('jest-workers advisory cleared (memory pressure gone)');
    }

    // The dev-log governor runs EVERY evaluation: a runaway dev-server.log is its own contract
    // (the 21GB incident grew under an otherwise-green disk), not a pressure-gated act.
    const governor =
      this.options.logGovernor ??
      new LogGovernor({
        registry: this.registry,
        capBytes: valves.logCapGb * 1024 * 1024 * 1024,
        watchLogs: valves.watchLogs,
        apply,
      });
    evaluation.logs = await governor.govern();
    evaluation.acts.push(...evaluation.logs.acts);

    // Soft+ triggers the dead-by-contract sweep (the reaper's own safety rules gate every act).
    if (level !== 'ok' && (this.options.sweepOnPressure ?? true)) {
      const reaper = this.options.reaper ?? new EstateReaper({ registry: this.registry, apply });
      evaluation.sweep = await reaper.sweep();
      const reapedCount = evaluation.sweep.reports.filter(
        (r) => r.verdict === 'reaped' || r.verdict === 'partial'
      ).length;
      evaluation.acts.push(
        `dead-by-contract sweep: ${reapedCount} estate${reapedCount !== 1 ? 's' : ''} reaped, ${EstateReaper.formatBytes(evaluation.sweep.reclaimedBytes)} reclaimed`
      );
    }

    // The pressure note the coordinator's next turn surfaces. A held over-cap log forces the
    // note even at level ok — it needs a human act (restart the holding server) to resolve.
    if (apply) {
      if (level !== 'ok' || (evaluation.logs?.held.length ?? 0) > 0) {
        this.writeNoteSync(pressure, evaluation);
        evaluation.acts.push(`pressure note written (${this.notePath()})`);
      } else {
        try {
          fsSync.rmSync(this.notePath());
          evaluation.acts.push('pressure note cleared (level ok)');
        } catch {
          // no note to clear
        }
      }
    }

    const log =
      level === 'hard'
        ? this.logger.error.bind(this.logger)
        : level === 'soft'
          ? this.logger.warn.bind(this.logger)
          : this.logger.info.bind(this.logger);
    log({
      message: `> Pressure ${level.toUpperCase()}: disk ${disk.freeGb.toFixed(1)} GiB free, memory ${usedPct.toFixed(0)}% used${pressure.summary ? ` — ${pressure.summary}` : ''}${evaluation.acts.length ? `; acts: ${evaluation.acts.join(' · ')}` : ''}`,
    });
    return evaluation;
  }

  // ── Facts (seam-backed) ───────────────────────────────────────────────────

  private async diskFacts(): Promise<{ totalGb: number; freeGb: number }> {
    if (this.options.diskFacts) {
      return this.options.diskFacts();
    }
    // POSIX df on the home volume: total/available in 1K blocks (columns 2 and 4).
    const result = await cmd('df', ['-Pk', os.homedir()], undefined, this.quiet());
    const dataLine = result.stdout.trim().split('\n').pop() ?? '';
    const columns = dataLine.split(/\s+/);
    const totalKb = Number(columns[1]);
    const availKb = Number(columns[3]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(availKb)) {
      throw new Error(`could not parse df output: ${dataLine}`);
    }
    return { totalGb: totalKb / (1024 * 1024), freeGb: availKb / (1024 * 1024) };
  }

  private async memoryFacts(): Promise<{ totalGb: number; availableGb: number }> {
    if (this.options.memoryFacts) {
      return this.options.memoryFacts();
    }
    const totalGb = os.totalmem() / 2 ** 30;
    if (process.platform === 'darwin') {
      // macOS: os.freemem() reads only truly-free pages; reclaimable memory is free + inactive +
      // purgeable + speculative (vm_stat pages).
      try {
        const result = await cmd('vm_stat', [], undefined, this.quiet());
        const pageSizeMatch = result.stdout.match(/page size of (\d+) bytes/);
        const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 16384;
        const page = (label: string) => {
          const match = result.stdout.match(new RegExp(`${label}:\\s+(\\d+)`));
          return match ? Number(match[1]) : 0;
        };
        const reclaimablePages =
          page('Pages free') + page('Pages inactive') + page('Pages purgeable') + page('Pages speculative');
        if (reclaimablePages > 0) {
          return { totalGb, availableGb: (reclaimablePages * pageSize) / 2 ** 30 };
        }
      } catch {
        // fall through to os.freemem
      }
    }
    return { totalGb, availableGb: os.freemem() / 2 ** 30 };
  }

  private async loadValves(): Promise<ValveConfig> {
    let fileConfig: Partial<ValveConfig> = {};
    try {
      fileConfig = JSON.parse(await fs.readFile(path.join(this.registry.homePath(), 'valves.json'), 'utf-8'));
    } catch {
      // no config file — defaults apply
    }
    return { ...DEFAULT_VALVES, ...fileConfig, ...this.options.valves };
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  private writeAdvisorySync(name: string, value: string): void {
    fsSync.mkdirSync(this.registry.advisoriesDir(), { recursive: true });
    const advisoryPath = path.join(this.registry.advisoriesDir(), name);
    const tmpPath = `${advisoryPath}.tmp-${process.pid}`;
    fsSync.writeFileSync(tmpPath, `${value}\n`);
    fsSync.renameSync(tmpPath, advisoryPath);
  }

  private clearAdvisorySync(name: string): boolean {
    try {
      fsSync.rmSync(path.join(this.registry.advisoriesDir(), name));
      return true;
    } catch {
      return false;
    }
  }

  private notePath(): string {
    return path.join(this.registry.homePath(), 'PRESSURE.md');
  }

  private writeNoteSync(pressure: PressureState, evaluation: ValveEvaluation): void {
    const lines = [
      `# Resource pressure: ${pressure.level.toUpperCase()}`,
      '',
      `As of ${new Date(pressure.capturedAt).toISOString()} (estate-watchdog):`,
      '',
      `- ${pressure.summary}`,
      `- load1 ${pressure.load1?.toFixed(2)}`,
      ...evaluation.acts.map((act) => `- act: ${act}`),
      '',
      pressure.level === 'hard'
        ? 'Refusal flag is UP: `estate register` refuses new estates. Reap or park before launching new work (`reap-estates`, `clean-worktrees`). No processes were killed (local valve never kills — D-3).'
        : pressure.level === 'soft'
          ? 'Soft watermark: dead-by-contract sweep ran; consider `reap-estates` / `clean-worktrees --apply` before launching heavy work.'
          : 'Watermarks are green; this note stands only for the held over-cap log(s) above — restart the holding server so the governor can rotate.',
      '',
    ];
    fsSync.mkdirSync(this.registry.homePath(), { recursive: true });
    fsSync.writeFileSync(this.notePath(), lines.join('\n'));
  }

  private quiet() {
    return { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } };
  }

  private static readonly MAX_SAMPLES = 4;
}
