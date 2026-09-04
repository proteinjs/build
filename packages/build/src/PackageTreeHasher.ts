import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { cmd } from '@proteinjs/util-node';

export type PackageTreeHash = {
  /**
   * Everything git considers part of the package — tracked files plus untracked files its
   * ignore rules do not exclude — minus release bookkeeping (see `PackageTreeHasher`).
   */
  sourceHash: string;
  /**
   * Everything git IGNORES under the package except node_modules: dist, generated, tsbuildinfo —
   * whatever the build wrote. Ignore rules are the repo's own declaration of "this is a product,
   * not a source", so the split needs no per-package configuration.
   */
  outputHash: string;
};

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

  constructor(private workspaceMemberNames: ReadonlySet<string>) {}

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

  /** tracked + untracked-unignored files, relative to the package dir — git's own view of the sources */
  private async listSources(packageDir: string): Promise<string[]> {
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
