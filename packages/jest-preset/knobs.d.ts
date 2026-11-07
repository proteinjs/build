/** The worker/memory convergence knobs and the declaration's one reader (knobs.js states each; DECISIONS 1121 P3/P4). */

/** The worker count: `env.JEST_WORKERS` when set, else the package default when given, else the physical cores — the local advisory a ceiling. */
export function workers(packageDefault?: number | string, env?: Record<string, string | undefined>): number | string;

/** `JEST_WORKER_IDLE_MEMORY_LIMIT` when set, else the package default. */
export function workerIdleMemoryLimit(packageDefault?: string): string | undefined;

/** Two of the database driver's per-operation deadlines, as the per-test clock of a package whose tests drive a backend. */
export function testTimeoutForBackend(opDeadlineMs: number): number;

/** The node-options declaration: the flags jest's workers start under, with the reason beside them. */
export interface NodeOptionsDeclaration {
  flags: string[];
  reason: string;
}

/** A package's `jestPreset` declaration, read whole: the in-band reason (or null) and the node options (or null). */
export interface Declaration {
  /** The package's name (package.json), or the dir when it has none. */
  name: string;
  /** The in-band declaration's reason, or null when the package runs with workers. */
  inBand: string | null;
  nodeOptions: NodeOptionsDeclaration | null;
}

/** THE ONE READER of package.json `jestPreset` at `packageDir` — refused by name when malformed; none declared reads as nulls. */
export function declaration(packageDir: string): Declaration;

/** The declared node flags for `packageDir`'s jest workers — what an in-process run must start node under — or null when none. */
export function nodeOptions(packageDir: string): NodeOptionsDeclaration | null;
