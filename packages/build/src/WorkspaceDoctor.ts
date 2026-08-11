import * as path from 'path';
import * as fs from 'fs/promises';
import { LocalPackage, PackageUtil, WorkspaceMetadata, cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { materializeDependencies } from './materializeDependencies';

export type WorkspaceFindingKind = 'clobbered-symlink' | 'missing-install' | 'stale-dist';

export type WorkspaceFinding = {
  packageName: string;
  kind: WorkspaceFindingKind;
  detail: string;
  /** The one manual command that resolves this finding (what `fix` runs). */
  remediation: string;
};

/**
 * Read-only workspace coherence diagnosis, with an explicit repair mode.
 *
 * Three finding kinds, each a distinct real-world failure class:
 *  - `clobbered-symlink` — a workspace dependency's node_modules entry is not a symlink into the
 *    workspace (a bare `npm install/ci/update/...` "corrected" the link to a registry copy; the
 *    consumer then runs stale code while builds look green).
 *  - `missing-install` — a declared external dependency has no node_modules entry (typically a
 *    freshly PULLED package.json dependency addition that was never installed).
 *  - `stale-dist` — a package's source is newer than its dist (edited but not rebuilt; consumers
 *    and the app dev server read dist).
 *
 * Diagnosis never mutates. `fix` applies the smallest deterministic remediation per finding, in
 * dependency order: install → re-symlink → build.
 */
export class WorkspaceDoctor {
  private logger = new Logger({ name: 'WorkspaceDoctor' });

  constructor(private workspacePath: string) {}

  /**
   * The workspace root for a doctor run: the OUTERMOST ancestor of `startDir` (inclusive) that
   * contains a package.json. Nested packages (e.g. app/packages/server inside the metarepo)
   * resolve to the metarepo root, so `verify-workspace` can be chained into any package's
   * scripts and still see the whole workspace.
   */
  static async findWorkspaceRoot(startDir: string): Promise<string> {
    let dir = path.resolve(startDir);
    let outermost: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await fs.access(path.join(dir, 'package.json'));
        outermost = dir;
      } catch {
        // not a package dir — keep walking up
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return outermost ?? path.resolve(startDir);
  }

  /**
   * Diagnose the workspace (or the transitive closures of `forPackages`).
   * Returns findings in workspace dependency order; empty means coherent.
   */
  async diagnose(forPackages?: string[]): Promise<WorkspaceFinding[]> {
    const metadata = await PackageUtil.getWorkspaceMetadata(this.workspacePath);
    const packageNames = await this.scopedPackageNames(metadata, forPackages);
    const findings: WorkspaceFinding[] = [];
    for (const packageName of packageNames) {
      const localPackage = metadata.packageMap[packageName];
      findings.push(...(await this.diagnoseSymlinks(localPackage, metadata)));
      findings.push(...(await this.diagnoseInstalls(localPackage, metadata)));
      findings.push(...(await this.diagnoseDist(localPackage)));
    }
    return findings;
  }

  /**
   * Apply the deterministic remediation for each finding, in workspace dependency order:
   * missing installs first (then re-link the package), then re-link clobbered packages, then
   * rebuild stale dists. Returns the re-diagnosis afterwards (empty = fully repaired).
   */
  async fix(findings: WorkspaceFinding[], forPackages?: string[]): Promise<WorkspaceFinding[]> {
    const metadata = await PackageUtil.getWorkspaceMetadata(this.workspacePath);
    const byPackage = new Map<string, WorkspaceFinding[]>();
    for (const finding of findings) {
      byPackage.set(finding.packageName, [...(byPackage.get(finding.packageName) ?? []), finding]);
    }
    for (const packageName of metadata.sortedPackageNames) {
      const packageFindings = byPackage.get(packageName);
      if (!packageFindings) {
        continue;
      }
      const localPackage = metadata.packageMap[packageName];
      const packageDir = path.dirname(localPackage.filePath);
      const kinds = new Set(packageFindings.map((f) => f.kind));
      if (kinds.has('missing-install')) {
        this.logger.info({ message: `[${packageName}] npm i (missing installs)` });
        await materializeDependencies(packageDir, { logPrefix: `[${packageName}] ` });
        await PackageUtil.symlinkDependencies(localPackage, metadata.packageMap);
      } else if (kinds.has('clobbered-symlink')) {
        this.logger.info({ message: `[${packageName}] re-symlinking workspace dependencies` });
        await PackageUtil.symlinkDependencies(localPackage, metadata.packageMap);
      }
      if (kinds.has('stale-dist')) {
        this.logger.info({ message: `[${packageName}] npm run build (stale dist)` });
        await cmd('npm', ['run', 'build'], { cwd: packageDir }, { logPrefix: `[${packageName}] ` });
      }
    }
    return this.diagnose(forPackages);
  }

  /** Scope: the named packages plus their transitive workspace closures; default = everything. */
  private async scopedPackageNames(metadata: WorkspaceMetadata, forPackages?: string[]): Promise<string[]> {
    const all = metadata.sortedPackageNames.filter((name) => name !== 'root');
    if (!forPackages || forPackages.length === 0) {
      return all;
    }
    const scope = new Set<string>();
    for (const packageName of forPackages) {
      const localPackage = metadata.packageMap[packageName];
      if (!localPackage) {
        throw new Error(`Package (${packageName}) does not exist in workspace: ${this.workspacePath}`);
      }
      scope.add(packageName);
      for (const dep of await PackageUtil.getTransitiveWorkspaceDependencies(localPackage, metadata.packageMap)) {
        scope.add(dep);
      }
    }
    // Preserve dependency order.
    return all.filter((name) => scope.has(name));
  }

  /**
   * Every transitive workspace dep must RESOLVE (by Node's ancestor-walk, so hoisted installs in
   * nested monorepos count) to its workspace dir via a symlink.
   */
  private async diagnoseSymlinks(localPackage: LocalPackage, metadata: WorkspaceMetadata): Promise<WorkspaceFinding[]> {
    const findings: WorkspaceFinding[] = [];
    const packageDir = path.dirname(localPackage.filePath);
    const workspaceDeps = await PackageUtil.getTransitiveWorkspaceDependencies(localPackage, metadata.packageMap);
    for (const depName of workspaceDeps) {
      const entryPath = await WorkspaceDoctor.resolveNodeModulesEntry(this.workspacePath, packageDir, depName);
      const expectedDir = path.dirname(metadata.packageMap[depName].filePath);
      const remediation = `npm run symlink-workspace (or: npx verify-workspace --fix)`;
      if (!entryPath) {
        findings.push({
          packageName: localPackage.name,
          kind: 'clobbered-symlink',
          detail: `${depName} missing from node_modules (expected symlink -> ${expectedDir})`,
          remediation,
        });
        continue;
      }
      const stat = await fs.lstat(entryPath);
      if (!stat.isSymbolicLink()) {
        findings.push({
          packageName: localPackage.name,
          kind: 'clobbered-symlink',
          detail: `${depName} at ${entryPath} is a real directory, not a workspace symlink (a bare npm install likely replaced it with a registry copy)`,
          remediation,
        });
        continue;
      }
      // realpath BOTH sides: any segment of the workspace path may itself be a symlink
      // (e.g. macOS /var -> /private/var), which must not read as a clobber.
      const realPath = await fs.realpath(entryPath).catch(() => undefined);
      const expectedReal = await fs.realpath(expectedDir).catch(() => expectedDir);
      if (!realPath || path.resolve(realPath) !== path.resolve(expectedReal)) {
        findings.push({
          packageName: localPackage.name,
          kind: 'clobbered-symlink',
          detail: `${depName} symlink resolves to ${realPath ?? '<broken>'} (expected ${expectedReal})`,
          remediation,
        });
      }
    }
    return findings;
  }

  /**
   * Node's resolution reality: a dependency may live in the package's own node_modules OR any
   * ancestor's (nested monorepos hoist installs to their workspace root). Returns the first
   * existing entry walking up from `packageDir` to the workspace root, or undefined.
   *
   * Static and public: NodeModulesIdentityWatcher samples the same entries this doctor
   * diagnoses — churn detection and coherence diagnosis must resolve identically.
   */
  static async resolveNodeModulesEntry(
    workspacePath: string,
    packageDir: string,
    depName: string
  ): Promise<string | undefined> {
    const workspaceReal = await fs.realpath(workspacePath).catch(() => path.resolve(workspacePath));
    let dir = path.resolve(packageDir);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const entryPath = path.join(dir, 'node_modules', ...depName.split('/'));
      try {
        await fs.lstat(entryPath);
        return entryPath;
      } catch {
        // keep walking up
      }
      const dirReal = await fs.realpath(dir).catch(() => dir);
      if (path.resolve(dirReal) === workspaceReal) {
        return undefined;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
  }

  /** Every declared EXTERNAL dependency must have a node_modules entry. */
  private async diagnoseInstalls(localPackage: LocalPackage, metadata: WorkspaceMetadata): Promise<WorkspaceFinding[]> {
    const findings: WorkspaceFinding[] = [];
    const packageDir = path.dirname(localPackage.filePath);
    const declared = {
      ...(localPackage.packageJson.dependencies ?? {}),
      ...(localPackage.packageJson.devDependencies ?? {}),
    } as Record<string, string>;
    for (const depName of Object.keys(declared)) {
      if (metadata.packageMap[depName]) {
        continue; // workspace dep — the symlink pass owns it
      }
      // Ancestor-walk resolution: nested monorepos hoist installs to their own root.
      const entryPath = await WorkspaceDoctor.resolveNodeModulesEntry(this.workspacePath, packageDir, depName);
      if (!entryPath) {
        findings.push({
          packageName: localPackage.name,
          kind: 'missing-install',
          detail: `${depName} (${declared[depName]}) declared but not installed — typically a pulled dependency addition`,
          remediation: `npm run workspace-package ${localPackage.name} npm i`,
        });
      }
    }
    return findings;
  }

  /** A buildable package's dist must be at least as new as its sources. */
  private async diagnoseDist(localPackage: LocalPackage): Promise<WorkspaceFinding[]> {
    if (!localPackage.packageJson.scripts?.build) {
      return [];
    }
    const packageDir = path.dirname(localPackage.filePath);
    // Source-side inputs only — generated/ and dist/ are build products. test/ IS an input:
    // several packages compile test utilities into dist/test for downstream consumption
    // (e.g. thought-common's TestEnvironment). package.json is deliberately NOT scanned: its
    // build-relevant changes (dependency additions) surface as missing-install, while its
    // dominant mtime source is CI version bumps arriving with every pull — scanning it would
    // flag the whole workspace stale after each release train.
    const sourceNewest = Math.max(
      await this.newestMtime(path.join(packageDir, 'src')),
      await this.newestMtime(path.join(packageDir, 'test')),
      await this.newestMtime(path.join(packageDir, 'index.ts'))
    );
    if (sourceNewest === 0) {
      return []; // no sources — nothing to compare
    }
    const distNewest = await this.newestMtime(path.join(packageDir, 'dist'));
    if (distNewest >= sourceNewest) {
      return [];
    }
    return [
      {
        packageName: localPackage.name,
        kind: 'stale-dist',
        detail:
          distNewest === 0
            ? 'no dist (never built)'
            : `src is newer than dist by ${Math.round((sourceNewest - distNewest) / 1000)}s`,
        remediation: `npm run workspace-package ${localPackage.name} npm run build`,
      },
    ];
  }

  /** Newest mtime (ms) under a file or directory tree; 0 when absent. */
  private async newestMtime(targetPath: string): Promise<number> {
    let stat;
    try {
      stat = await fs.lstat(targetPath);
    } catch {
      return 0;
    }
    if (!stat.isDirectory()) {
      return stat.mtimeMs;
    }
    let newest = 0;
    const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const childNewest = await this.newestMtime(path.join(targetPath, entry.name));
      if (childNewest > newest) {
        newest = childNewest;
      }
    }
    return newest;
  }
}
