import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';

/**
 * An ESTATE is the unit lanes launch and forget (RESOURCE_GOVERNANCE §B.1): a dev server, an
 * emulator set, a scratch checkout — everything a launcher owns and must eventually reap.
 * One JSON file per estate under `~/.n3xa/estates/` (crash-safe, greppable, no daemon).
 */
export type EstateRecord = {
  /** Unique, filesystem-safe id (the registry sanitizes it into the filename). */
  id: string;
  /** Who launched/owns this estate — a lane or session label (e.g. `serve-package:@n3xa/app-server`). */
  owner: string;
  /** TCP ports the estate serves on. A port still answering pins the estate against reaping. */
  ports: number[];
  /**
   * Absolute directories OWNED by the estate (scratch, worktrees, logs) — reaped with it.
   * Never a primary checkout: the reaper's git safety checks refuse dirt/unpushed work, but
   * ownership is the registrant's declaration and should only name dirs that die with the estate.
   */
  dirs: string[];
  /** Docker container names owned by the estate (per-lane emulators die with their estate). */
  containers: string[];
  /** Pids owned by the estate. A live pid (cwd-verified) pins the estate against reaping. */
  pids: number[];
  startedAt: number;
  /** Freshness signal: estates heartbeat while alive; stale > TTL is dead-by-contract. */
  heartbeatAt: number;
  /** Never auto-reaped (the durable pin — the estate analog of `.worktree-keep`). */
  pinned?: boolean;
  note?: string;
};

/** Fields a registrant provides; the registry fills the rest. */
export type EstateRegistration = {
  id?: string;
  owner: string;
  ports?: number[];
  dirs?: string[];
  containers?: string[];
  pids?: number[];
  pinned?: boolean;
  note?: string;
};

export type RegisterOptions = {
  /**
   * Consult the pressure valve's refusal flag (default true): under HARD pressure the registry
   * refuses NEW estates with the real numbers, routing new lane launches into cleanup instead of
   * onto the wall (§B.3). Ambient registrants that are already running (ServePackageSupervisor)
   * pass false — refusing REGISTRATION would not stop the process, only blind the machinery to it,
   * and an unregistered estate is strictly worse (outside the automatic-act boundary).
   */
  enforceValve?: boolean;
};

/** Thrown by register() when the pressure valve's hard refusal flag is up. Carries the real numbers. */
export class EstateRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EstateRefusedError';
    // ES5 target: restore the prototype chain so instanceof works across the compile.
    Object.setPrototypeOf(this, EstateRefusedError.prototype);
  }
}

/**
 * The machine-readable pressure state the valve (`estate-watchdog`, see PressureValve) writes and
 * the registry/coordinator read. `level: 'hard'` IS the refusal flag.
 */
export type PressureLevel = 'ok' | 'soft' | 'hard';
export type PressureState = {
  capturedAt: number;
  level: PressureLevel;
  disk: { totalGb: number; freeGb: number; level: PressureLevel };
  memory: { totalGb: number; availableGb: number; usedPct: number; level: PressureLevel };
  load1?: number;
  /** Trailing memory usedPct samples (newest last) — 'sustained' judgments need history across single-shot runs. */
  memorySamples?: { at: number; usedPct: number }[];
  /** Human line explaining the level, with the real numbers (surfaces verbatim in refusals). */
  summary?: string;
};

/**
 * Local estate registry (RESOURCE_GOVERNANCE §B.1): the canonical record of what is running on
 * this machine and who owns it — the local analog of the sandbox fleet lens. Registration is
 * ambient where possible (ServePackageSupervisor registers its estate on launch and heartbeats on
 * its liveness cadence); launch scripts call the `estate` CLI; manual registration exists for
 * glue. Unregistered things are, by definition, outside the automatic-act boundary (§B.5): the
 * reaper only ever touches estates this registry knows.
 *
 * Layout under the estate home (default `~/.n3xa`, override N3XA_ESTATE_HOME for tests):
 *   estates/<id>.json      one record per estate (atomic write-then-rename)
 *   pressure.json          the valve's refusal flag + facts (written by PressureValve)
 *   advisories/            machine-output throttle signals (e.g. jest-workers)
 *   logs/                  reap + repair receipts
 */
export class EstateRegistry {
  constructor(private homeDir: string = EstateRegistry.home()) {}

  /** The estate home (default `~/.n3xa`; N3XA_ESTATE_HOME overrides — the test seam). */
  static home(): string {
    return process.env.N3XA_ESTATE_HOME || path.join(os.homedir(), '.n3xa');
  }

  /**
   * Register (or re-register: same id overwrites) an estate. With `enforceValve` (the default,
   * what the `estate` CLI does) a HARD pressure flag refuses the registration loudly with the
   * real numbers — reap or park before launching.
   */
  async register(registration: EstateRegistration, options: RegisterOptions = {}): Promise<EstateRecord> {
    const enforceValve = options.enforceValve ?? true;
    if (enforceValve) {
      const pressure = await this.readPressure();
      if (pressure?.level === 'hard') {
        throw new EstateRefusedError(
          `estate registration refused under hard resource pressure: ${
            pressure.summary ??
            `disk ${pressure.disk.freeGb.toFixed(1)} GiB free, memory ${pressure.memory.usedPct.toFixed(0)}% used`
          } — reap or park before launching (reap-estates; see ${path.join(this.homeDir, 'pressure.json')})`
        );
      }
    }
    const record = this.buildRecord(registration);
    await fs.mkdir(this.estatesDir(), { recursive: true });
    this.writeRecordSync(record);
    return record;
  }

  /** Refresh the freshness signal (and optionally merge changed ownership facts, e.g. a new child pid). */
  async heartbeat(
    id: string,
    patch?: Partial<Pick<EstateRecord, 'ports' | 'dirs' | 'containers' | 'pids' | 'note'>>
  ): Promise<EstateRecord | undefined> {
    const record = await this.get(id);
    if (!record) {
      return undefined;
    }
    const updated: EstateRecord = { ...record, ...patch, heartbeatAt: Date.now() };
    this.writeRecordSync(updated);
    return updated;
  }

  async get(id: string): Promise<EstateRecord | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.recordPath(id), 'utf-8')) as EstateRecord;
    } catch {
      return undefined;
    }
  }

  /** Every readable estate record. Corrupt files are reported as `unreadable`, never touched. */
  async list(): Promise<{ estates: EstateRecord[]; unreadable: string[] }> {
    const estates: EstateRecord[] = [];
    const unreadable: string[] = [];
    const entries = await fs.readdir(this.estatesDir()).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const recordPath = path.join(this.estatesDir(), entry);
      try {
        const record = JSON.parse(await fs.readFile(recordPath, 'utf-8')) as EstateRecord;
        if (!record.id || !record.owner) {
          throw new Error('missing id/owner');
        }
        estates.push(record);
      } catch {
        unreadable.push(recordPath);
      }
    }
    estates.sort((a, b) => a.startedAt - b.startedAt);
    return { estates, unreadable };
  }

  /** Exit reaps the estate (cleanup-as-contract): deliberate exits deregister. */
  async unregister(id: string): Promise<boolean> {
    try {
      await fs.rm(this.recordPath(id));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synchronous unregister for atomic exit paths (ServePackageSupervisor.endSupervision is
   * synchronous end-to-end by design — see its wedge history; estate cleanup must not reintroduce
   * async machinery there).
   */
  unregisterSync(id: string): boolean {
    try {
      fsSync.rmSync(this.recordPath(id));
      return true;
    } catch {
      return false;
    }
  }

  async setPinned(id: string, pinned: boolean): Promise<EstateRecord | undefined> {
    const record = await this.get(id);
    if (!record) {
      return undefined;
    }
    const updated: EstateRecord = { ...record, pinned: pinned || undefined };
    this.writeRecordSync(updated);
    return updated;
  }

  /** The valve's latest state (undefined when the watchdog has never run or the file is unreadable). */
  async readPressure(): Promise<PressureState | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.pressurePath(), 'utf-8')) as PressureState;
    } catch {
      return undefined;
    }
  }

  /** Atomic write of the valve's state (PressureValve is the writer; lives here so layout has one owner). */
  writePressureSync(state: PressureState): void {
    fsSync.mkdirSync(this.homeDir, { recursive: true });
    const tmpPath = `${this.pressurePath()}.tmp-${process.pid}`;
    fsSync.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fsSync.renameSync(tmpPath, this.pressurePath());
  }

  estatesDir(): string {
    return path.join(this.homeDir, 'estates');
  }

  pressurePath(): string {
    return path.join(this.homeDir, 'pressure.json');
  }

  advisoriesDir(): string {
    return path.join(this.homeDir, 'advisories');
  }

  logsDir(): string {
    return path.join(this.homeDir, 'logs');
  }

  homePath(): string {
    return this.homeDir;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildRecord(registration: EstateRegistration): EstateRecord {
    const now = Date.now();
    const id = EstateRegistry.sanitizeId(registration.id || `${registration.owner}-${now}`);
    if (!registration.owner) {
      throw new Error('estate registration requires an owner (lane/session label)');
    }
    const dirs = (registration.dirs ?? []).map((dir) => path.resolve(dir));
    for (const dir of dirs) {
      // Basic ownership sanity: an estate may only claim dirs that can die with it. The reaper
      // adds the real git safety checks; this guard just makes catastrophic registrations
      // unrepresentable.
      if (dir === path.parse(dir).root || dir === os.homedir()) {
        throw new Error(`estate dir may not be the filesystem root or the home directory: ${dir}`);
      }
    }
    return {
      id,
      owner: registration.owner,
      ports: registration.ports ?? [],
      dirs,
      containers: registration.containers ?? [],
      pids: registration.pids ?? [],
      startedAt: now,
      heartbeatAt: now,
      pinned: registration.pinned || undefined,
      note: registration.note,
    };
  }

  /** Filesystem-safe id: anything outside [A-Za-z0-9._-] folds to '-'. */
  static sanitizeId(id: string): string {
    return id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  private recordPath(id: string): string {
    return path.join(this.estatesDir(), `${EstateRegistry.sanitizeId(id)}.json`);
  }

  /** Atomic write-then-rename, synchronous — same idiom as the supervisor's state.json (it must not lie). */
  private writeRecordSync(record: EstateRecord): void {
    fsSync.mkdirSync(this.estatesDir(), { recursive: true });
    const recordPath = this.recordPath(record.id);
    const tmpPath = `${recordPath}.tmp-${process.pid}`;
    fsSync.writeFileSync(tmpPath, JSON.stringify(record, null, 2));
    fsSync.renameSync(tmpPath, recordPath);
  }
}
