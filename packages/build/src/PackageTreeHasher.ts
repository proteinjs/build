import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import ignore, { Ignore } from 'ignore';
import { Logger } from '@proteinjs/logger';
import { cmd } from '@proteinjs/util-node';

export type PackageTreeHash = {
  /**
   * Everything git considers part of the package — tracked files plus untracked files its
   * ignore rules do not exclude — minus release bookkeeping (see `PackageTreeHasher`). Outside
   * a git work tree, the same set read off the file tree under the `.gitignore` rules.
   */
  sourceHash: string;
  /**
   * Everything git IGNORES under the package except node_modules: dist, generated, tsbuildinfo —
   * whatever the build wrote. Ignore rules are the repo's own declaration of "this is a product,
   * not a source", so the split needs no per-package configuration.
   */
  outputHash: string;
};

export type PackageTreeHasherOptions = {
  /**
   * The workspace root. Outside a git work tree it stands in for the repository root: the
   * `.gitignore` files from here down to the package apply, as git would apply them were the
   * workspace the repository.
   */
  workspacePath: string;
  /** where the hasher says, once, that sources come from the file tree; default: its own `Logger` */
  logger?: Logger;
};

/** one `.gitignore` and the directory whose subtree it governs */
type IgnoreScope = { dir: string; rules: Ignore };

/**
 * Content hashes for one package directory, split along the line the repo's own git ignore
 * rules already draw: what git tracks or would track is SOURCE, what git ignores is OUTPUT.
 * `build-workspace` stamps a build with the hash of its inputs (own sources + every transitive
 * workspace dependency's sources and outputs) and of its outputs, and skips the build while
 * both still match — derived from the tree, never declared per package.
 *
 * Release bookkeeping is not a build input. A train departure rewrites every published
 * package's `version`, its CHANGELOG.md, and the lockfile entries for its workspace siblings
 * (which are symlinks on disk, never installed), without changing a single compiled byte —
 * so these are normalized away: `package.json` and `package-lock.json` hash with `version`
 * removed, workspace-member dependency specs replaced by a constant, and the members' own
 * lockfile entries (plus anything nested under them) dropped; CHANGELOG.md is skipped.
 * External dependency changes — a bumped resolved version, an added package — survive
 * normalization and invalidate as they must.
 *
 * Git is the source of truth wherever there is one. A package with no `.git` in its directory
 * or any ancestor is NOT in a git work tree — a container image build context is the usual
 * case, the workspace copied without its repository — and there the sources are the on-disk
 * tree filtered by the `.gitignore` files from the workspace root down to the package, applied
 * as git applies them (the deeper file wins, an excluded directory is never re-entered,
 * `node_modules` and nested work trees are never sources). The hasher says so once. On the
 * same tree both listings yield the same source set, so the hashes agree byte for byte.
 */
export class PackageTreeHasher {
  /** Bump when the hashing rules change: every stamp written under an older format re-verifies as stale. */
  static readonly FORMAT = 1;
  private static readonly WORKSPACE_SPEC = '<workspace>';
  private static readonly PRUNED_DIR_NAMES = new Set(['node_modules', '.git']);
  private static readonly RELEASE_BOOKKEEPING_FILES = new Set(['CHANGELOG.md']);
  private static readonly DEPENDENCY_FIELDS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  /** Finder metadata: never a build product, appears whenever a directory is browsed on macOS. */
  private static readonly FINDER_LITTER = '.DS_Store';

  private readonly workspacePath: string;
  private readonly logger: Logger;
  private fileTreeAnnounced = false;

  constructor(
    private workspaceMemberNames: ReadonlySet<string>,
    options: PackageTreeHasherOptions
  ) {
    this.workspacePath = options.workspacePath;
    this.logger = options.logger ?? new Logger({ name: 'PackageTreeHasher' });
  }

  async hash(packageDir: string): Promise<PackageTreeHash> {
    const sources = await this.listSources(packageDir);
    const sourceSet = new Set(sources);
    const outputs = (await this.listFiles(packageDir)).filter((relPath) => !sourceSet.has(relPath));
    return {
      sourceHash: await this.hashFiles(packageDir, sources, true),
      outputHash: await this.hashFiles(packageDir, outputs, false),
    };
  }

  /**
   * The install identity of a package: sha256 of its normalized package-lock.json — undefined
   * when there is no lockfile (an install with no lock resolves at the registry every time and
   * has no stable identity to stamp).
   */
  async lockHash(packageDir: string): Promise<string | undefined> {
    const raw = await fs.readFile(path.join(packageDir, 'package-lock.json'), 'utf-8').catch(() => undefined);
    if (raw === undefined) {
      return undefined;
    }
    return PackageTreeHasher.sha256(this.normalizeJson(raw, (lock) => this.normalizeLockfile(lock)));
  }

  /** `package.json` without release bookkeeping: no `version`; workspace-member specs constant. */
  normalizePackageJson(packageJson: any): any {
    const normalized = { ...packageJson };
    delete normalized.version;
    for (const field of PackageTreeHasher.DEPENDENCY_FIELDS) {
      if (normalized[field] && typeof normalized[field] === 'object') {
        normalized[field] = this.normalizeSpecs(normalized[field]);
      }
    }
    return normalized;
  }

  /**
   * `package-lock.json` without release bookkeeping: no top-level `version`; the root entry
   * normalized like package.json; every entry that IS a workspace member (or is nested under
   * one — the registry copy's private node_modules, gone once the member is symlinked) dropped.
   * Lockfile v2 carries a legacy `dependencies` mirror of `packages` — dropped as redundant;
   * v1 (no `packages`) normalizes the `dependencies` tree recursively.
   */
  normalizeLockfile(lock: any): any {
    const normalized = { ...lock };
    delete normalized.version;
    if (normalized.packages && typeof normalized.packages === 'object') {
      const packages: Record<string, unknown> = {};
      for (const key of Object.keys(normalized.packages)) {
        if (key === '') {
          packages[key] = this.normalizePackageJson(normalized.packages[key]);
        } else if (!this.belongsToWorkspaceMember(key)) {
          packages[key] = normalized.packages[key];
        }
      }
      normalized.packages = packages;
      delete normalized.dependencies;
    } else if (normalized.dependencies && typeof normalized.dependencies === 'object') {
      normalized.dependencies = this.normalizeLegacyDependencies(normalized.dependencies);
    }
    return normalized;
  }

  /**
   * The sources, relative to the package dir: git's own view (tracked + untracked-unignored
   * files) inside a git work tree; the file tree under the `.gitignore` rules outside one.
   */
  private async listSources(packageDir: string): Promise<string[]> {
    if (!(await PackageTreeHasher.insideGitWorkTree(packageDir))) {
      return this.listSourcesFromFileTree(packageDir);
    }
    let stdout: string;
    try {
      ({ stdout } = await cmd(
        'git',
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { cwd: packageDir },
        { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }
      ));
    } catch (e: any) {
      throw new Error(
        `build-workspace derives each package's sources from git (tracked + unignored untracked files), and git ls-files failed in ${packageDir}: ${(e.stderr || e.message || String(e)).trim()}`
      );
    }
    return Array.from(
      new Set(
        stdout
          .split('\0')
          .filter((relPath) => relPath.length > 0 && path.basename(relPath) !== PackageTreeHasher.FINDER_LITTER)
      )
    );
  }

  /**
   * Every regular file and symlink under the package dir, relative paths, never descending into
   * node_modules, .git, or a nested git work tree (another repo's files are its own), never
   * following symlinks.
   */
  private async listFiles(packageDir: string): Promise<string[]> {
    const found: string[] = [];
    const pending: string[] = [packageDir];
    while (pending.length > 0) {
      const dir = pending.pop()!;
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      if (dir !== packageDir && dirents.some((dirent) => dirent.name === '.git')) {
        continue;
      }
      for (const dirent of dirents) {
        if (dirent.isDirectory()) {
          if (!PackageTreeHasher.PRUNED_DIR_NAMES.has(dirent.name)) {
            pending.push(path.join(dir, dirent.name));
          }
        } else if ((dirent.isFile() || dirent.isSymbolicLink()) && dirent.name !== PackageTreeHasher.FINDER_LITTER) {
          found.push(path.relative(packageDir, path.join(dir, dirent.name)));
        }
      }
    }
    return found;
  }

  /**
   * Not a git work tree: the on-disk tree filtered by the `.gitignore` files from the workspace
   * root down, as git would filter it. Said once per hasher — one per build-workspace run.
   */
  private async listSourcesFromFileTree(packageDir: string): Promise<string[]> {
    if (!this.fileTreeAnnounced) {
      this.fileTreeAnnounced = true;
      this.logger.info({
        message: `sources from the file tree — not a git work tree (${this.workspacePath}); the .gitignore rules from the workspace root down apply`,
      });
    }
    const relPath = path.relative(this.workspacePath, packageDir);
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
      throw new Error(
        `${packageDir} is outside the workspace (${this.workspacePath}) whose .gitignore rules would apply to it`
      );
    }
    const scopes: IgnoreScope[] = [];
    const segments = relPath === '' ? [] : relPath.split(path.sep);
    for (let depth = 0; depth < segments.length; depth++) {
      const dir = path.join(this.workspacePath, ...segments.slice(0, depth));
      const rules = await PackageTreeHasher.ignoreRules(dir);
      if (rules) {
        scopes.push({ dir, rules });
      }
    }
    const found: string[] = [];
    await PackageTreeHasher.collectUnignored(packageDir, packageDir, scopes, found);
    return found;
  }

  /**
   * Depth-first under `dir` with the `.gitignore` files above it (shallowest first) plus its
   * own: a directory git would exclude is never entered, so nothing beneath it can be
   * re-included; `node_modules`, `.git`, a nested git work tree, and Finder litter are never
   * sources.
   */
  private static async collectUnignored(
    packageDir: string,
    dir: string,
    above: IgnoreScope[],
    found: string[]
  ): Promise<void> {
    const own = await PackageTreeHasher.ignoreRules(dir);
    const scopes = own ? [...above, { dir, rules: own }] : above;
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    if (dir !== packageDir && dirents.some((dirent) => dirent.name === '.git')) {
      return;
    }
    for (const dirent of dirents) {
      const entryPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (
          !PackageTreeHasher.PRUNED_DIR_NAMES.has(dirent.name) &&
          !PackageTreeHasher.ignored(scopes, entryPath, true)
        ) {
          await PackageTreeHasher.collectUnignored(packageDir, entryPath, scopes, found);
        }
      } else if (
        (dirent.isFile() || dirent.isSymbolicLink()) &&
        dirent.name !== PackageTreeHasher.FINDER_LITTER &&
        !PackageTreeHasher.ignored(scopes, entryPath, false)
      ) {
        found.push(path.relative(packageDir, entryPath));
      }
    }
  }

  /**
   * Git's precedence: every `.gitignore` above the entry is consulted and the deepest one with
   * a matching pattern decides (within one file the last matching pattern wins — `ignore`'s
   * part). A directory is tested with its trailing slash so `dir/` patterns match it.
   */
  private static ignored(scopes: IgnoreScope[], entryPath: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const scope of scopes) {
      const relPath = path.relative(scope.dir, entryPath).split(path.sep).join('/') + (isDirectory ? '/' : '');
      const verdict = scope.rules.test(relPath);
      if (verdict.ignored) {
        ignored = true;
      } else if (verdict.unignored) {
        ignored = false;
      }
    }
    return ignored;
  }

  /** the directory's `.gitignore` as a matcher; undefined when it has none */
  private static async ignoreRules(dir: string): Promise<Ignore | undefined> {
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, '.gitignore'), 'utf-8');
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return undefined;
      }
      throw e;
    }
    return ignore().add(content);
  }

  /** a `.git` — the directory, or a worktree's / submodule's pointer file — in `dir` or any ancestor */
  private static async insideGitWorkTree(dir: string): Promise<boolean> {
    for (let current = dir; ; current = path.dirname(current)) {
      try {
        await fs.lstat(path.join(current, '.git'));
        return true;
      } catch (e: any) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
          throw e;
        }
      }
      if (path.dirname(current) === current) {
        return false;
      }
    }
  }

  private async hashFiles(packageDir: string, relPaths: string[], sourceRules: boolean): Promise<string> {
    const hash = createHash('sha256');
    for (const relPath of [...relPaths].sort()) {
      if (sourceRules && PackageTreeHasher.RELEASE_BOOKKEEPING_FILES.has(relPath)) {
        continue;
      }
      const filePath = path.join(packageDir, relPath);
      let stat;
      try {
        stat = await fs.lstat(filePath);
      } catch {
        continue; // listed by git but gone from the working tree — its absence is the change
      }
      let content: Buffer;
      let kind: string;
      if (stat.isSymbolicLink()) {
        kind = 'link';
        content = Buffer.from(await fs.readlink(filePath));
      } else if (stat.isFile()) {
        kind = 'file';
        content = await fs.readFile(filePath);
        if (sourceRules && relPath === 'package.json') {
          content = Buffer.from(
            this.normalizeJson(content.toString('utf-8'), (json) => this.normalizePackageJson(json))
          );
        } else if (sourceRules && relPath === 'package-lock.json') {
          content = Buffer.from(this.normalizeJson(content.toString('utf-8'), (json) => this.normalizeLockfile(json)));
        }
      } else {
        continue;
      }
      hash.update(`${relPath}\0${kind}\0${content.length}\0`);
      hash.update(content);
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  /** Normalized JSON text; content that does not parse hashes as-is (it is still a change). */
  private normalizeJson(raw: string, normalize: (json: any) => any): string {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (!parsed || typeof parsed !== 'object') {
      return raw;
    }
    return JSON.stringify(normalize(parsed));
  }

  private normalizeSpecs(specs: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const name of Object.keys(specs)) {
      normalized[name] = this.workspaceMemberNames.has(name) ? PackageTreeHasher.WORKSPACE_SPEC : specs[name];
    }
    return normalized;
  }

  /** `node_modules/@scope/member`, or anything nested beneath a member's entry, at any depth. */
  private belongsToWorkspaceMember(lockKey: string): boolean {
    return lockKey
      .split(/(?:^|\/)node_modules\//)
      .filter((name) => name.length > 0)
      .some((name) => this.workspaceMemberNames.has(name));
  }

  private normalizeLegacyDependencies(dependencies: Record<string, any>): Record<string, any> {
    const normalized: Record<string, any> = {};
    for (const name of Object.keys(dependencies)) {
      if (this.workspaceMemberNames.has(name)) {
        continue;
      }
      const entry = { ...dependencies[name] };
      if (entry.requires && typeof entry.requires === 'object') {
        entry.requires = this.normalizeSpecs(entry.requires);
      }
      if (entry.dependencies && typeof entry.dependencies === 'object') {
        entry.dependencies = this.normalizeLegacyDependencies(entry.dependencies);
      }
      normalized[name] = entry;
    }
    return normalized;
  }

  private static sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }
}
