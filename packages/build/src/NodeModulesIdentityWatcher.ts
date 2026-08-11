import * as path from 'path';
import * as fs from 'fs/promises';
import { PackageUtil } from '@proteinjs/util-node';
import { WorkspaceDoctor } from './WorkspaceDoctor';

/** One node_modules entry whose PACKAGE IDENTITY is watched (see class doc). */
export type WatchedNodeModulesEntry = {
  /** Workspace package whose declared dependency this entry satisfies. */
  consumer: string;
  /** The consumer's package dir — where the entry's ancestor-walk resolution starts. */
  packageDir: string;
  /** The declared dependency the entry provides (direct dep of `consumer`). */
  depName: string;
};

/** Observed identity of one watched entry at sample time. */
export type NodeModulesEntrySample = WatchedNodeModulesEntry & {
  /** node_modules path the resolution landed on; undefined when missing (e.g. a mid-install hole). */
  entryPath?: string;
  kind: 'missing' | 'real-dir' | 'symlink';
  /** The symlink's resolved real path; undefined unless kind is 'symlink' (or the link is broken). */
  realPath?: string;
};

/**
 * Detects node_modules PACKAGE-IDENTITY churn under a served closure — the coherence class a
 * live child's own webpack watcher is blind to: npm tears node_modules down and rebuilds it
 * (or symlink-workspace retargets links) while the watcher keeps compiling with boot-time
 * loader config, baking raw-TS "Module parse failed" (or ENOENT) bundles that STICK, because
 * the post-op tree carries identical mtimes and nothing the watcher watches ever changes again.
 *
 * The signal is a fingerprint over the closure's node_modules entries — for each closure
 * package's directly-declared dependency: where the entry resolved, whether it is a symlink,
 * and the symlink's real target. Any difference between samples IS identity churn, including a
 * round trip that ends back at the baseline (npm i then re-symlink restores the original
 * fingerprint, but the child compiled through the hole — exactly the sticky-broken-bundle
 * case, so churn latches at the supervisor rather than comparing endpoints here).
 *
 * NON-GOAL: dist churn. Builds landing new dist files must keep flowing through the child's
 * webpack/HMR (and the supervisor's separate dist-mtime staleness watch) untouched — this
 * watcher reads ONLY node_modules entry identity (one lstat + one readlink-shaped realpath per
 * entry), never dist file contents or mtimes, so a ~5-10s poll stays cheap.
 */
export class NodeModulesIdentityWatcher {
  private entries: WatchedNodeModulesEntry[] = [];
  private lastSamples: NodeModulesEntrySample[] = [];
  private lastFingerprint = '';
  // A baseline taken mid-sample (a restart's respawn racing a poll) invalidates that sample:
  // committing it would compare pre-spawn identity against the fresh baseline and re-latch
  // churn the spawn already absorbed.
  private baselineGeneration = 0;

  constructor(
    private workspacePath: string,
    /** Scope roots; the watched set is their transitive workspace closures' direct deps. */
    private scopePackageNames: string[]
  ) {}

  /**
   * Re-resolve the watched entry set from workspace metadata (direct deps can change across
   * spawns — an npm i that added one is churn the OLD child saw; the new child starts clean)
   * and snapshot the identity baseline. Call on every spawn.
   */
  async baseline(): Promise<void> {
    this.baselineGeneration += 1;
    this.entries = await this.resolveWatchedEntries();
    this.lastSamples = await this.sampleEntries();
    this.lastFingerprint = NodeModulesIdentityWatcher.fingerprint(this.lastSamples);
  }

  /**
   * Sample the watched entries and compare against the previous sample. Returns labels of the
   * entries whose identity changed (empty = no churn). Advances the comparison point, so
   * ongoing churn (an npm install in flight) reports each poll's increment — the caller's
   * quiet window keeps refreshing until the churn settles.
   */
  async sampleChanged(): Promise<string[]> {
    const generation = this.baselineGeneration;
    const samples = await this.sampleEntries();
    if (generation !== this.baselineGeneration) {
      return []; // a respawn re-baselined mid-sample; this sample predates the new child
    }
    const fingerprint = NodeModulesIdentityWatcher.fingerprint(samples);
    if (fingerprint === this.lastFingerprint) {
      return [];
    }
    const changed = NodeModulesIdentityWatcher.changedEntries(this.lastSamples, samples);
    this.lastSamples = samples;
    this.lastFingerprint = fingerprint;
    return changed;
  }

  /**
   * Canonical fingerprint of a sample set: one line per entry — consumer, dep, resolved entry
   * path, kind, symlink target — sorted so sample order never matters. Two sample sets have
   * equal fingerprints iff every watched entry has identical package identity.
   */
  static fingerprint(samples: NodeModulesEntrySample[]): string {
    return samples
      .map(
        (sample) => `${NodeModulesIdentityWatcher.entryKey(sample)} ${NodeModulesIdentityWatcher.identityOf(sample)}`
      )
      .sort()
      .join('\n');
  }

  /** Labels of entries whose identity differs between two sample sets (added/removed included). */
  static changedEntries(previous: NodeModulesEntrySample[], next: NodeModulesEntrySample[]): string[] {
    const byKey = (samples: NodeModulesEntrySample[]): Record<string, NodeModulesEntrySample> => {
      const keyed: Record<string, NodeModulesEntrySample> = {};
      for (const sample of samples) {
        keyed[NodeModulesIdentityWatcher.entryKey(sample)] = sample;
      }
      return keyed;
    };
    const previousByKey = byKey(previous);
    const nextByKey = byKey(next);
    const changed: string[] = [];
    for (const key of Object.keys(nextByKey)) {
      const before = previousByKey[key];
      if (
        !before ||
        NodeModulesIdentityWatcher.identityOf(before) !== NodeModulesIdentityWatcher.identityOf(nextByKey[key])
      ) {
        changed.push(NodeModulesIdentityWatcher.label(nextByKey[key]));
      }
    }
    for (const key of Object.keys(previousByKey)) {
      if (!nextByKey[key]) {
        changed.push(NodeModulesIdentityWatcher.label(previousByKey[key]));
      }
    }
    return changed.sort();
  }

  /**
   * The watched set: for every package in the scope roots' transitive workspace closures, each
   * of its directly-declared dependencies (dependencies + devDependencies — webpack loaders
   * live in devDependencies). Workspace deps are direct deps of their consumers, so the
   * symlink set is covered per consumer without special-casing.
   */
  private async resolveWatchedEntries(): Promise<WatchedNodeModulesEntry[]> {
    const metadata = await PackageUtil.getWorkspaceMetadata(this.workspacePath);
    const consumerSet: Record<string, true> = {};
    for (const packageName of this.scopePackageNames) {
      const localPackage = metadata.packageMap[packageName];
      if (!localPackage) {
        throw new Error(`Package (${packageName}) does not exist in workspace: ${this.workspacePath}`);
      }
      consumerSet[packageName] = true;
      for (const dep of await PackageUtil.getTransitiveWorkspaceDependencies(localPackage, metadata.packageMap)) {
        consumerSet[dep] = true;
      }
    }
    const entries: WatchedNodeModulesEntry[] = [];
    for (const consumer of Object.keys(consumerSet)) {
      const localPackage = metadata.packageMap[consumer];
      const packageDir = path.dirname(localPackage.filePath);
      const declared = {
        ...(localPackage.packageJson.dependencies ?? {}),
        ...(localPackage.packageJson.devDependencies ?? {}),
      } as Record<string, string>;
      for (const depName of Object.keys(declared)) {
        entries.push({ consumer, packageDir, depName });
      }
    }
    return entries;
  }

  private async sampleEntries(): Promise<NodeModulesEntrySample[]> {
    const samples: NodeModulesEntrySample[] = [];
    for (const entry of this.entries) {
      samples.push(await this.sampleEntry(entry));
    }
    return samples;
  }

  private async sampleEntry(entry: WatchedNodeModulesEntry): Promise<NodeModulesEntrySample> {
    const entryPath = await WorkspaceDoctor.resolveNodeModulesEntry(
      this.workspacePath,
      entry.packageDir,
      entry.depName
    );
    if (!entryPath) {
      return { ...entry, kind: 'missing' };
    }
    const stat = await fs.lstat(entryPath).catch(() => undefined);
    if (!stat) {
      return { ...entry, kind: 'missing' }; // npm removed it between resolution and lstat
    }
    if (!stat.isSymbolicLink()) {
      return { ...entry, entryPath, kind: 'real-dir' };
    }
    // A broken link (realpath fails mid-churn) is its own identity: realPath stays undefined.
    const realPath = await fs.realpath(entryPath).catch(() => undefined);
    return { ...entry, entryPath, kind: 'symlink', realPath };
  }

  private static entryKey(sample: WatchedNodeModulesEntry): string {
    return `${sample.consumer} ${sample.depName}`;
  }

  private static identityOf(sample: NodeModulesEntrySample): string {
    return `${sample.entryPath ?? ''} ${sample.kind} ${sample.realPath ?? ''}`;
  }

  private static label(sample: NodeModulesEntrySample): string {
    return `${sample.depName} (in ${sample.consumer})`;
  }
}
