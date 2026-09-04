import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { LocalPackage, LogColorWrapper, PackageUtil, WorkspaceMetadata, cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { primaryLogColor, secondaryLogColor } from './logColors';
import { hasLintConfig } from './lintWorkspace';
import { DependencyScheduler, ScheduledTask } from './DependencyScheduler';
import { LockfileSnapshot } from './LockfileSnapshot';
import { MATERIALIZE_INSTALL_ARGS } from './materializeDependencies';
import { PackageProcessError, PackageProcessRunner } from './PackageProcessRunner';
import { InstallStamp, PackageStamps } from './PackageStamps';
import { PackageTreeHash, PackageTreeHasher } from './PackageTreeHasher';

export type BuildWorkspaceArgs = {
  noInstall?: string[];
  noBuild?: string[];
  noLint?: string[];
  skip?: string[];
  lint?: boolean;
  /** ignore every stamp: install and build everything (the pre-incremental behavior) */
  force?: boolean;
};

export type WorkspaceBuildSummary = {
  /** the build set, dependency order */
  packages: string[];
  installed: string[];
  /** install skipped: lock hash + toolchain majors matched the stamp */
  installsSatisfied: string[];
  /** install skipped by --no-install */
  installsSkipped: string[];
  built: string[];
  /** build skipped: input hash + output hash matched the stamp */
  upToDate: string[];
  /** build skipped by --no-build */
  buildsSkipped: string[];
  linted: string[];
  elapsedMs: number;
};

export type WorkspaceBuilderOptions = {
  workspacePath: string;
  args?: BuildWorkspaceArgs;
  /** max package processes in flight; default `WorkspaceBuilder.defaultConcurrency()` */
  concurrency?: number;
  /** prettier --write + eslint --fix after each build that ran (CI, or --lint) */
  lintEnabled?: boolean;
  /** CI installs write lockfiles (CI commits its own fallout); local installs preserve them */
  ci?: boolean;
  runner?: PackageProcessRunner;
  logger?: Logger;
};

/**
 * Install and build a workspace incrementally and concurrently, in dependency order.
 *
 * The graph is `PackageUtil.getWorkspaceMetadata`'s (the same one symlink-workspace, the
 * doctor, and the landing trains consume). Each package is two tasks: `install` (no
 * dependencies — every install may start at once) and `build` (after its own install and after
 * the builds of every workspace package in its transitive closure). A bounded pool runs them;
 * ready builds go before ready installs so the critical path is never starved by installs.
 *
 * Nothing is redone that is already satisfied — derived from the tree, never declared:
 *  - install runs when node_modules carries no `.proteinjs-install-stamp` matching the lock's
 *    normalized hash under the current node/npm majors (`PackageTreeHasher.lockHash`);
 *    workspace symlinks are re-linked whenever the install ran or any link in the package's
 *    transitive closure is missing or not a symlink to its workspace dir (what a bare npm
 *    install in a package clobbers); a satisfied install with intact links spawns nothing;
 *  - build runs when node_modules carries no `.proteinjs-build-stamp` whose input hash (own
 *    sources + install identity + every transitive workspace dependency's sources and outputs)
 *    AND output hash (the package's own products, still intact) both match. A change in any
 *    package therefore rebuilds exactly it and its dependents.
 *  - lint runs only after a build that ran (the sources it would rewrite are the ones just
 *    compiled); an unchanged package is not re-linted.
 * `--force` ignores every stamp. The first failure stops the graph: no new task starts, every
 * live process group is killed (`PackageProcessRunner.abort`), and the error names the package.
 */
export class WorkspaceBuilder {
  static readonly CONCURRENCY_ENV = 'BUILD_WORKSPACE_CONCURRENCY';
  private static readonly SKIPPED_PACKAGES = ['root'];

  private readonly cw = new LogColorWrapper();
  private readonly logger: Logger;
  private readonly runner: PackageProcessRunner;
  private readonly args: BuildWorkspaceArgs;
  private readonly concurrency: number;
  private readonly lintEnabled: boolean;
  private readonly ci: boolean;
  private readonly workspacePath: string;
  private metadata!: WorkspaceMetadata;
  private hasher!: PackageTreeHasher;
  private toolchain!: { node: string; npm: string };
  private treeHashes = new Map<string, Promise<PackageTreeHash>>();
  private summary!: WorkspaceBuildSummary;

  constructor(options: WorkspaceBuilderOptions) {
    this.workspacePath = options.workspacePath;
    this.args = options.args ?? {};
    this.concurrency = options.concurrency ?? WorkspaceBuilder.defaultConcurrency();
    this.lintEnabled = !!options.lintEnabled;
    this.ci = !!options.ci;
    this.runner = options.runner ?? new PackageProcessRunner();
    this.logger =
      options.logger ??
      new Logger({ name: this.cw.color('workspace:', primaryLogColor) + this.cw.color('build', secondaryLogColor) });
  }

  /** `BUILD_WORKSPACE_CONCURRENCY` when set (a positive integer, else an error), otherwise the CPU count. */
  static defaultConcurrency(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env[WorkspaceBuilder.CONCURRENCY_ENV];
    if (raw === undefined || raw === '') {
      return os.availableParallelism();
    }
    const parsed = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || parsed < 1) {
      throw new Error(`${WorkspaceBuilder.CONCURRENCY_ENV} must be a positive integer, got '${raw}'`);
    }
    return parsed;
  }

  async run(): Promise<WorkspaceBuildSummary> {
    const started = Date.now();
    this.summary = {
      packages: [],
      installed: [],
      installsSatisfied: [],
      installsSkipped: [],
      built: [],
      upToDate: [],
      buildsSkipped: [],
      linted: [],
      elapsedMs: 0,
    };
    this.metadata = await PackageUtil.getWorkspaceMetadata(this.workspacePath);
    this.hasher = new PackageTreeHasher(new Set(Object.keys(this.metadata.packageMap)));
    this.toolchain = { node: process.versions.node.split('.')[0], npm: await WorkspaceBuilder.npmMajor() };
    const packageNames = this.buildSet();
    this.summary.packages = packageNames;
    const count = this.cw.color(`${packageNames.length}`, secondaryLogColor);
    this.logger.info({
      message: `> Installing, building${this.lintEnabled ? ', and linting' : ''} ${count} package${packageNames.length != 1 ? 's' : ''} in workspace (${this.workspacePath}) — concurrency ${this.concurrency}${this.args.force ? ', --force' : ''}`,
    });
    this.logger.debug({ message: `packageMap:`, obj: this.metadata.packageMap });
    this.logger.debug({ message: `buildSet:`, obj: packageNames });

    const scheduler = new DependencyScheduler({ concurrency: this.concurrency, onFailure: () => this.runner.abort() });
    try {
      await scheduler.run(await this.tasks(packageNames));
    } catch (e) {
      const label = e instanceof PackageProcessError ? e.label : undefined;
      this.logger.error({
        message: `> Workspace build FAILED${label ? ` at ${this.cw.color(label)}` : ''} (${this.workspacePath}) — ${this.progressLine()}`,
      });
      throw e;
    }
    this.summary.elapsedMs = Date.now() - started;
    this.logger.info({
      message: `> Installed, built${this.lintEnabled ? ', and linted' : ''} ${count} package${packageNames.length != 1 ? 's' : ''} in workspace (${this.workspacePath}) — ${this.progressLine()} in ${(this.summary.elapsedMs / 1000).toFixed(1)}s`,
    });
    return this.summary;
  }

  /** buildable (has a build script), not --skip'd, never a workspace root; dependency order */
  private buildSet(): string[] {
    return this.metadata.sortedPackageNames.filter(
      (packageName) =>
        !!this.metadata.packageMap[packageName].packageJson.scripts?.build &&
        !(this.args.skip && this.args.skip.includes(packageName)) &&
        !WorkspaceBuilder.SKIPPED_PACKAGES.includes(packageName)
    );
  }

  private async tasks(packageNames: string[]): Promise<ScheduledTask[]> {
    const buildSet = new Set(packageNames);
    const tasks: ScheduledTask[] = [];
    for (const packageName of packageNames) {
      const closure = await PackageUtil.getTransitiveWorkspaceDependencies(
        this.metadata.packageMap[packageName],
        this.metadata.packageMap
      );
      tasks.push({
        id: `install:${packageName}`,
        dependsOn: [],
        priority: 1,
        run: () => this.install(packageName),
      });
      tasks.push({
        id: `build:${packageName}`,
        dependsOn: [
          `install:${packageName}`,
          ...closure.filter((dependency) => buildSet.has(dependency)).map((dependency) => `build:${dependency}`),
        ],
        priority: 0,
        run: () => this.build(packageName),
      });
    }
    return tasks;
  }

  private async install(packageName: string): Promise<void> {
    const localPackage = this.metadata.packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    if (this.args.noInstall && this.args.noInstall.includes(packageName)) {
      this.summary.installsSkipped.push(packageName);
      return;
    }
    const stamps = new PackageStamps(packageDir);
    const lockHash = await this.hasher.lockHash(packageDir);
    const current: InstallStamp | undefined = lockHash ? { lockHash, ...this.toolchain } : undefined;
    const stamp = await stamps.readInstall();
    const closure = await PackageUtil.getTransitiveWorkspaceDependencies(localPackage, this.metadata.packageMap);
    if (!this.args.force && current && stamp && PackageStamps.installSatisfied(stamp, current)) {
      const linksIntact = await this.workspaceLinksIntact(packageDir, closure);
      this.logger.info({
        message: `[${this.cw.color(packageName)}] install satisfied (package-lock.json unchanged, node ${current.node} / npm ${current.npm}${linksIntact ? ', workspace symlinks intact' : ''})`,
      });
      this.summary.installsSatisfied.push(packageName);
      if (linksIntact) {
        return;
      }
    } else {
      const reason = this.args.force
        ? '--force'
        : !current
          ? 'no package-lock.json — nothing to stamp'
          : !stamp
            ? 'no install stamp'
            : stamp.lockHash !== current.lockHash
              ? 'package-lock.json changed'
              : `toolchain changed (node ${stamp.node} → ${current.node}, npm ${stamp.npm} → ${current.npm})`;
      this.logger.info({ message: `[${this.cw.color(packageName)}] npm install (${reason})` });
      const started = Date.now();
      await stamps.clearInstall();
      await this.npmInstall(packageName, packageDir);
      const installedLockHash = await this.hasher.lockHash(packageDir);
      if (installedLockHash) {
        await stamps.writeInstall({ lockHash: installedLockHash, ...this.toolchain });
      }
      this.summary.installed.push(packageName);
      this.logger.info({
        message: `Installed ${this.cw.color(packageName)} (${packageDir}) in ${WorkspaceBuilder.seconds(started)}`,
      });
    }
    await PackageUtil.symlinkDependencies(localPackage, this.metadata.packageMap);
  }

  /**
   * Every transitive workspace dependency already resolves, in this package's OWN node_modules,
   * through a symlink to its workspace dir — exactly the state `PackageUtil.symlinkDependencies`
   * leaves (the doctor's clobbered-symlink rule, inverted). Re-linking spawns `ln` per link and
   * per bin shim, which dominated the no-op run (measured: ~35 of 43 s across 64 packages); a
   * satisfied install whose links are intact skips it. A clobbered or missing link (a bare
   * `npm install` in the package) re-links as before.
   */
  private async workspaceLinksIntact(packageDir: string, closure: string[]): Promise<boolean> {
    for (const dependency of closure) {
      const entry = path.join(packageDir, 'node_modules', ...dependency.split('/'));
      let stat;
      try {
        stat = await fs.lstat(entry);
      } catch {
        return false;
      }
      if (!stat.isSymbolicLink()) {
        return false;
      }
      const target = await fs.realpath(entry).catch(() => undefined);
      const expected = await fs
        .realpath(path.dirname(this.metadata.packageMap[dependency].filePath))
        .catch(() => undefined);
      if (!target || !expected || target !== expected) {
        return false;
      }
    }
    return true;
  }

  private async npmInstall(packageName: string, packageDir: string): Promise<void> {
    const processOptions = { cwd: packageDir, label: packageName, logPrefix: this.logPrefix(packageName) };
    if (this.ci) {
      await this.runner.run('npm', MATERIALIZE_INSTALL_ARGS, processOptions);
      return;
    }
    const snapshot = await LockfileSnapshot.take(packageDir);
    try {
      await this.runner.run('npm', MATERIALIZE_INSTALL_ARGS, processOptions);
    } finally {
      await snapshot.restore();
    }
  }

  private async build(packageName: string): Promise<void> {
    const localPackage = this.metadata.packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    if (this.args.noBuild && this.args.noBuild.includes(packageName)) {
      this.summary.buildsSkipped.push(packageName);
      return;
    }
    const stamps = new PackageStamps(packageDir);
    const inputHash = await this.inputHash(localPackage);
    const before = await this.treeHash(packageName);
    const stamp = await stamps.readBuild();
    if (
      !this.args.force &&
      stamp &&
      PackageStamps.buildSatisfied(stamp, PackageTreeHasher.FORMAT, inputHash, before.outputHash)
    ) {
      this.logger.info({ message: `[${this.cw.color(packageName)}] build up to date` });
      this.summary.upToDate.push(packageName);
      return;
    }
    const reason = this.args.force
      ? '--force'
      : !stamp
        ? 'no build stamp'
        : stamp.format !== PackageTreeHasher.FORMAT
          ? 'stamp format changed'
          : stamp.inputHash !== inputHash
            ? 'sources or dependency outputs changed'
            : 'outputs changed since the last build';
    this.logger.info({ message: `[${this.cw.color(packageName)}] npm run build (${reason})` });
    const started = Date.now();
    await stamps.clearBuild();
    const processOptions = { cwd: packageDir, label: packageName, logPrefix: this.logPrefix(packageName) };
    await this.runner.run('npm', ['run', 'build'], processOptions);
    this.treeHashes.delete(packageName);
    const after = await this.treeHash(packageName);
    await stamps.writeBuild({ format: PackageTreeHasher.FORMAT, inputHash, outputHash: after.outputHash });
    this.summary.built.push(packageName);
    this.logger.info({
      message: `Built ${this.cw.color(packageName)} (${packageDir}) in ${WorkspaceBuilder.seconds(started)}`,
    });

    if (
      this.lintEnabled &&
      hasLintConfig(localPackage) &&
      !(this.args.noLint && this.args.noLint.includes(packageName))
    ) {
      const lintStarted = Date.now();
      await this.runner.run('npx', ['prettier', '.', '--write'], processOptions);
      await this.runner.run('npx', ['eslint', '.', '--fix'], processOptions);
      this.summary.linted.push(packageName);
      this.logger.info({
        message: `Linted ${this.cw.color(packageName)} (${packageDir}) in ${WorkspaceBuilder.seconds(lintStarted)}`,
      });
    }
  }

  private static seconds(since: number): string {
    return `${((Date.now() - since) / 1000).toFixed(1)}s`;
  }

  /** own sources + install identity + every transitive workspace dependency's sources and outputs */
  private async inputHash(localPackage: LocalPackage): Promise<string> {
    const packageDir = path.dirname(localPackage.filePath);
    const hash = createHash('sha256');
    hash.update(`format ${PackageTreeHasher.FORMAT}\n`);
    hash.update(`sources ${(await this.treeHash(localPackage.name)).sourceHash}\n`);
    hash.update(`lock ${(await this.hasher.lockHash(packageDir)) ?? 'none'}\n`);
    const closure = await PackageUtil.getTransitiveWorkspaceDependencies(localPackage, this.metadata.packageMap);
    for (const dependency of closure.sort()) {
      const dependencyHash = await this.treeHash(dependency);
      hash.update(`dependency ${dependency} ${dependencyHash.sourceHash} ${dependencyHash.outputHash}\n`);
    }
    return hash.digest('hex');
  }

  /**
   * Memoized per run: a package's tree is hashed once, and again only after this run rebuilt
   * it. A dependent's build task starts only after every closure member's build task finished,
   * so the memo it reads is the post-build state.
   */
  private treeHash(packageName: string): Promise<PackageTreeHash> {
    let pending = this.treeHashes.get(packageName);
    if (!pending) {
      pending = this.hasher.hash(path.dirname(this.metadata.packageMap[packageName].filePath));
      this.treeHashes.set(packageName, pending);
    }
    return pending;
  }

  private logPrefix(packageName: string): string {
    return `[${this.cw.color(packageName)}] `;
  }

  private progressLine(): string {
    const s = this.summary;
    return (
      `installed ${s.installed.length} (${s.installsSatisfied.length} satisfied, ${s.installsSkipped.length} skipped), ` +
      `built ${s.built.length} (${s.upToDate.length} up to date, ${s.buildsSkipped.length} skipped)` +
      (this.lintEnabled ? `, linted ${s.linted.length}` : '')
    );
  }

  private static async npmMajor(): Promise<string> {
    const { stdout } = await cmd(
      'npm',
      ['--version'],
      {},
      { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }
    );
    return stdout.trim().split('.')[0];
  }
}
