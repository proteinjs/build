import * as path from 'path';
import * as fs from 'fs/promises';
import { cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { EstateRegistry } from './EstateRegistry';
import { EstateReaper } from './EstateReaper';

export type LogGovernorReport = {
  /** One line per act (rotations and held-log surfacings) — mirrored into the valve's acts. */
  acts: string[];
  /** Logs rotated to `.prev` (no live writer held them). */
  rotated: { logPath: string; bytes: number }[];
  /**
   * Over-cap logs HELD by a live writer — surfaced with the pid, never blind-truncated: a shell
   * `>` redirect writes at a remembered offset, so external truncation corrupts into sparse
   * garbage. The cure is restarting the server (release the fd), which the surfacing names.
   */
  held: { logPath: string; bytes: number; pids: number[] }[];
};

export type LogGovernorOptions = {
  registry?: EstateRegistry;
  /** Cap in bytes above which a governed log rotates (default 1 GiB; valves.json `logCapGb`). */
  capBytes?: number;
  /** Extra absolute log paths to govern (valves.json `watchLogs`) — the manual-redirect class. */
  watchLogs?: string[];
  /** Actually rotate. Default true (the watchdog exists to act); false = report only. */
  apply?: boolean;
  // ── Test seams ────────────────────────────────────────────────────────────
  /** Pids holding the file open for WRITE (default: lsof -Fa). Empty = unheld. */
  writerProbe?: (logPath: string) => Promise<number[]>;
};

/**
 * The dev-log governor (RESOURCE_GOVERNANCE §B.3 rider): dev-server logs are append-only
 * firehoses (a error loop once grew `dev-server.log` to 21GB and took the disk — 2026-08-31),
 * so the watchdog governs every log it can SEE against a declared cap:
 *
 *  - Governed set: `dev-server.log` and `serve.log` (and `.serve-package/serve.log`) under every
 *    REGISTERED estate's dirs, plus the explicit `watchLogs` paths from valves.json — the
 *    manual `nohup … > dev-server.log` launch class that registration cannot see.
 *  - Over cap + no live writer: rotated to `<log>.prev` (replacing the previous generation —
 *    the serve-package daemon's own convention; one generation of history, bounded).
 *  - Over cap + live writer: SURFACED with the holding pid — never blind-truncated (a `>`
 *    redirect's remembered offset turns external truncation into sparse corruption) and never
 *    a kill (D-3). The act line names the cure: restart the server so the fd is released.
 */
export class LogGovernor {
  private logger = new Logger({ name: 'LogGovernor' });
  private registry: EstateRegistry;

  constructor(private options: LogGovernorOptions = {}) {
    this.registry = options.registry ?? new EstateRegistry();
  }

  async govern(): Promise<LogGovernorReport> {
    const report: LogGovernorReport = { acts: [], rotated: [], held: [] };
    const apply = this.options.apply ?? true;
    const capBytes = this.options.capBytes ?? LogGovernor.DEFAULT_CAP_BYTES;
    for (const logPath of await this.candidates()) {
      let size: number;
      try {
        size = (await fs.stat(logPath)).size;
      } catch {
        continue; // no such log — nothing to govern
      }
      if (size <= capBytes) {
        continue;
      }
      const writers = await this.writerPids(logPath);
      if (writers.length > 0) {
        report.held.push({ logPath, bytes: size, pids: writers });
        report.acts.push(
          `log over cap HELD by live writer: ${logPath} (${EstateReaper.formatBytes(size)}, pid ${writers.join(', ')}) — restart that server to release the fd; never blind-truncated`
        );
        continue;
      }
      report.rotated.push({ logPath, bytes: size });
      report.acts.push(`rotated ${logPath} (${EstateReaper.formatBytes(size)} > cap) → ${path.basename(logPath)}.prev`);
      if (apply) {
        await fs.rm(`${logPath}.prev`, { force: true });
        await fs.rename(logPath, `${logPath}.prev`).catch((error) => {
          this.logger.warn({
            message: `rotate failed for ${logPath}: ${error instanceof Error ? error.message : error}`,
          });
        });
      }
    }
    return report;
  }

  /** The governed set: known log names under registered estates' dirs + explicit watchLogs. */
  private async candidates(): Promise<string[]> {
    const candidates = new Set<string>(this.options.watchLogs ?? []);
    const { estates } = await this.registry.list();
    for (const estate of estates) {
      for (const dir of estate.dirs) {
        for (const name of LogGovernor.GOVERNED_LOG_NAMES) {
          candidates.add(path.join(dir, name));
        }
      }
    }
    return Array.from(candidates);
  }

  /** Pids with the file open for WRITE (lsof access mode w/u). Empty when unheld or lsof fails. */
  private async writerPids(logPath: string): Promise<number[]> {
    if (this.options.writerProbe) {
      return this.options.writerProbe(logPath);
    }
    try {
      const result = await cmd('lsof', ['-Fpa', '--', logPath], undefined, {
        omitLogs: { stdout: { omit: true }, stderr: { omit: true } },
      });
      if (result.code !== 0) {
        return []; // lsof exits 1 for "no holders" — unheld
      }
      const pids: number[] = [];
      let currentPid: number | undefined;
      for (const line of result.stdout.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = Number(line.slice(1));
        } else if (line.startsWith('a') && /[wu]/.test(line.slice(1)) && currentPid !== undefined) {
          if (!pids.includes(currentPid)) {
            pids.push(currentPid);
          }
        }
      }
      return pids;
    } catch {
      return [];
    }
  }

  static readonly DEFAULT_CAP_BYTES = 1024 * 1024 * 1024;
  static readonly GOVERNED_LOG_NAMES = ['dev-server.log', 'serve.log', path.join('.serve-package', 'serve.log')];
}
