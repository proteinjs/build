import { Logger } from '@proteinjs/logger';

/**
 * The fence every database act must sit inside: one Spanner instance (`project/instance`) and one
 * name prefix. A reference outside it is refused by name, never trusted to the credential's scope
 * (the credential that boots a dev server may be project-wide databaseAdmin — DEV_ESTATES.md §2).
 */
export type DatabaseFence = { project: string; instance: string; prefix: string };

/** A database reference as estates record it: `<project>/<instance>/<database>`. */
export type DatabaseRef = { project: string; instance: string; name: string };

export type DatabaseSweepOptions = {
  /** Without a fence the database class is inert: rows naming databases are refused, orphans are not swept. */
  fence?: DatabaseFence;
  /** How long a fenced database with no registered estate may stand before the orphan sweep drops it (default 7 days). */
  orphanAfterMs?: number;
  /**
   * The Spanner admin client for a project — the seam. The default resolves `@google-cloud/spanner`
   * from `resolvePaths` (the estates' own app installs; the reaper never carries a client copy) and
   * authenticates with `GCP_SA_KEY` (base64 service-account JSON, decoded in-process, never logged);
   * undefined when either is missing — the class then reports itself skipped instead of acting.
   */
  spannerFactory?: (project: string) => SpannerAdminClient | undefined;
  /** Directories to resolve the client from (each estate's dirs; `<dir>/app/packages/server` is tried too). */
  resolvePaths?: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (message: string) => void;
};

/** The slice of `@google-cloud/spanner`'s client the sweep uses (typed structurally so tests fake it). */
export type SpannerAdminClient = {
  instance(name: string): SpannerAdminInstance;
  close(): void;
};
export type SpannerAdminInstance = {
  getDatabases(): Promise<[{ formattedName_?: string; id?: string; metadata?: { createTime?: unknown } }[]]>;
  database(name: string, options?: { min?: number }): { delete(): Promise<unknown> };
};

export type DatabaseSweepReport = {
  /** What was done (apply) or would be done (dry-run), one line per database. */
  acts: string[];
  /** Per-database refusals — listed, never overridden. */
  refusals: string[];
  /** Fenced databases the orphan sweep judged and kept, with the reason (the counterfactual line). */
  kept: string[];
  /** Set when the class could not act at all (no fence, no client, no credential) — the printed skip line. */
  skipped?: string;
};

/**
 * The reaper's DATABASE resource class (plans/DEV_ESTATES.md §3.3): a database is one more thing
 * an estate owns and the reaper drops with the row — fenced by instance + name prefix in code,
 * whatever the credential could do.
 *
 *  - Row-scoped: a reaped estate's `databases` are dropped after its dirs/containers, before the
 *    registration goes; a reference outside the fence is a refusal (the row stays, visible).
 *  - Orphan sweep: every fenced database that NO registered estate names and that is older than
 *    `orphanAfterMs` is dropped; younger ones and ones of unknown age are kept with the reason
 *    written down. Never a name outside the prefix, never a database any row names (pinned rows
 *    included — a pin protects the database too).
 *  - Without a fence, a client, or a credential the class does nothing and SAYS so.
 */
export class EstateDatabaseSweep {
  private logger = new Logger({ name: 'EstateDatabaseSweep' });

  constructor(private options: DatabaseSweepOptions = {}) {}

  /** Drop the databases a reaped estate names (apply) or list the drops (dry-run). */
  async dropForEstate(databases: string[], apply: boolean): Promise<DatabaseSweepReport> {
    const report: DatabaseSweepReport = { acts: [], refusals: [], kept: [] };
    if (databases.length === 0) {
      return report;
    }
    const fence = this.options.fence;
    if (!fence) {
      report.refusals.push(
        `databases ${databases.join(', ')}: no database fence configured (reap-estates --db-fence=<project>/<instance>/<prefix>) — not dropped`
      );
      return report;
    }
    const inside: DatabaseRef[] = [];
    for (const raw of databases) {
      const ref = EstateDatabaseSweep.parseRef(raw);
      const refusal = ref ? this.fenceRefusal(ref, fence) : `${raw}: not a <project>/<instance>/<database> reference`;
      if (refusal) {
        report.refusals.push(refusal);
      } else if (ref) {
        inside.push(ref);
      }
    }
    if (inside.length === 0) {
      return report;
    }
    const client = this.client(fence.project);
    if (!client) {
      report.refusals.push(
        `databases ${inside.map(EstateDatabaseSweep.formatRef).join(', ')}: ${this.unavailableReason()} — not dropped`
      );
      return report;
    }
    try {
      const existing = new Set((await this.listDatabases(client.instance)).map((database) => database.name));
      for (const ref of inside) {
        const label = EstateDatabaseSweep.formatRef(ref);
        if (!existing.has(ref.name)) {
          report.acts.push(`database ${label} already absent`);
          continue;
        }
        report.acts.push(`drop database ${label}`);
        if (apply) {
          try {
            await client.instance.database(ref.name, { min: 0 }).delete();
          } catch (error) {
            report.refusals.push(`database ${label}: drop failed (${EstateDatabaseSweep.message(error)})`);
          }
        }
      }
    } finally {
      client.spanner.close();
    }
    return report;
  }

  /**
   * The orphan sweep: fenced databases no registered estate names, older than the horizon, are
   * dropped; everything else inside the fence is kept with its reason. `registered` = every
   * database reference on every row that still exists after the estate pass.
   */
  async sweepOrphans(registered: Set<string>, apply: boolean): Promise<DatabaseSweepReport> {
    const report: DatabaseSweepReport = { acts: [], refusals: [], kept: [] };
    const fence = this.options.fence;
    if (!fence) {
      report.skipped = 'no database fence configured — orphan sweep skipped';
      return report;
    }
    const client = this.client(fence.project);
    if (!client) {
      report.skipped = `${this.unavailableReason()} — orphan sweep skipped`;
      return report;
    }
    const horizonMs = this.options.orphanAfterMs ?? EstateDatabaseSweep.DEFAULT_ORPHAN_AFTER_MS;
    const now = (this.options.now ?? Date.now)();
    try {
      for (const database of await this.listDatabases(client.instance)) {
        if (!database.name.startsWith(fence.prefix)) {
          continue; // outside the family — never judged, never named
        }
        const ref = EstateDatabaseSweep.formatRef({
          project: fence.project,
          instance: fence.instance,
          name: database.name,
        });
        if (registered.has(ref)) {
          report.kept.push(`${ref}: named by a registered estate`);
          continue;
        }
        if (database.createdAtMs === undefined) {
          report.kept.push(`${ref}: no registered estate, age unknown — kept (never dropped unaged)`);
          continue;
        }
        const ageMs = now - database.createdAtMs;
        if (ageMs < horizonMs) {
          report.kept.push(
            `${ref}: no registered estate, ${EstateDatabaseSweep.formatAge(ageMs)} old < ${EstateDatabaseSweep.formatAge(horizonMs)} — would drop at the horizon (estate adopt --id … to keep it)`
          );
          continue;
        }
        report.acts.push(
          `drop orphan database ${ref} (${EstateDatabaseSweep.formatAge(ageMs)} old, no registered estate)`
        );
        if (apply) {
          try {
            await client.instance.database(database.name, { min: 0 }).delete();
          } catch (error) {
            report.refusals.push(`database ${ref}: drop failed (${EstateDatabaseSweep.message(error)})`);
          }
        }
      }
    } finally {
      client.spanner.close();
    }
    return report;
  }

  /** `project/instance/name` → a reference, or undefined when the shape is wrong. */
  static parseRef(raw: string): DatabaseRef | undefined {
    const parts = raw.split('/');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      return undefined;
    }
    return { project: parts[0], instance: parts[1], name: parts[2] };
  }

  static formatRef(ref: DatabaseRef): string {
    return `${ref.project}/${ref.instance}/${ref.name}`;
  }

  /** `--db-fence=<project>/<instance>/<prefix>` → a fence, or an error naming the shape. */
  static parseFence(raw: string): DatabaseFence {
    const parts = raw.split('/');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new Error(`--db-fence must be <project>/<instance>/<prefix>, got: ${raw}`);
    }
    return { project: parts[0], instance: parts[1], prefix: parts[2] };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private fenceRefusal(ref: DatabaseRef, fence: DatabaseFence): string | undefined {
    const label = EstateDatabaseSweep.formatRef(ref);
    if (ref.project !== fence.project || ref.instance !== fence.instance) {
      return `database ${label}: outside the fenced instance ${fence.project}/${fence.instance} — refusing`;
    }
    if (!ref.name.startsWith(fence.prefix)) {
      return `database ${label}: name outside the fenced prefix ${fence.prefix}* — refusing`;
    }
    return undefined;
  }

  private client(project: string): { spanner: SpannerAdminClient; instance: SpannerAdminInstance } | undefined {
    const fence = this.options.fence;
    if (!fence) {
      return undefined;
    }
    const factory = this.options.spannerFactory ?? ((projectId: string) => this.defaultClient(projectId));
    let spanner: SpannerAdminClient | undefined;
    try {
      spanner = factory(project);
    } catch (error) {
      this.logger.warn({
        message: `database sweep: client construction failed: ${EstateDatabaseSweep.message(error)}`,
      });
      return undefined;
    }
    if (!spanner) {
      return undefined;
    }
    return { spanner, instance: spanner.instance(fence.instance) };
  }

  /**
   * The default client: `@google-cloud/spanner` resolved from the estates' own installs, the
   * credential decoded from `GCP_SA_KEY` in-process (the app's own DbDriverFactory shape). Nothing
   * about the credential is ever logged — not the email, not the key id.
   */
  private defaultClient(project: string): SpannerAdminClient | undefined {
    const env = this.options.env ?? process.env;
    const encoded = env.GCP_SA_KEY;
    if (!encoded) {
      return undefined;
    }
    const paths = [process.cwd()];
    for (const dir of this.options.resolvePaths ?? []) {
      paths.push(dir, `${dir}/app/packages/server`, `${dir}/packages/server`);
    }
    let modulePath: string;
    try {
      modulePath = require.resolve('@google-cloud/spanner', { paths });
    } catch {
      return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Spanner } = require(modulePath);
    const credentials = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    return new Spanner({ projectId: project, credentials }) as SpannerAdminClient;
  }

  private unavailableReason(): string {
    const env = this.options.env ?? process.env;
    if (!env.GCP_SA_KEY) {
      return 'no GCP_SA_KEY in the environment (run through a shell that sources ~/.zshrc)';
    }
    return 'no @google-cloud/spanner client resolvable from the estates (no app install to borrow it from)';
  }

  private async listDatabases(instance: SpannerAdminInstance): Promise<{ name: string; createdAtMs?: number }[]> {
    const [databases] = await instance.getDatabases();
    return databases.map((database) => ({
      name: (database.formattedName_ ?? database.id ?? '').split('/').pop() ?? '',
      createdAtMs: EstateDatabaseSweep.timestampMs(database.metadata?.createTime),
    }));
  }

  /** A protobuf Timestamp (`seconds` as number | string | Long, `nanos`) as epoch ms, or undefined. */
  private static timestampMs(timestamp: unknown): number | undefined {
    if (!timestamp || typeof timestamp !== 'object') {
      return undefined;
    }
    const raw = timestamp as { seconds?: unknown; nanos?: number };
    if (raw.seconds === undefined || raw.seconds === null) {
      return undefined;
    }
    const secondsValue = raw.seconds as { toNumber?: () => number };
    const seconds =
      typeof secondsValue === 'object' && typeof secondsValue.toNumber === 'function'
        ? secondsValue.toNumber()
        : Number(raw.seconds);
    if (!Number.isFinite(seconds)) {
      return undefined;
    }
    return seconds * 1000 + Math.floor((raw.nanos || 0) / 1e6);
  }

  private static message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  static formatAge(ms: number): string {
    if (ms >= 24 * 3600_000) {
      return `${(ms / (24 * 3600_000)).toFixed(1)}d`;
    }
    if (ms >= 3600_000) {
      return `${(ms / 3600_000).toFixed(1)}h`;
    }
    return `${Math.round(ms / 60_000)}m`;
  }

  static readonly DEFAULT_ORPHAN_AFTER_MS = 7 * 24 * 3600_000;
}
