import * as path from 'path';
import * as fs from 'fs/promises';

/** What the last `npm install` in a package satisfied: its lock's install identity under a toolchain. */
export type InstallStamp = {
  /** `PackageTreeHasher.lockHash` — the normalized package-lock.json */
  lockHash: string;
  /** node major */
  node: string;
  /** npm major */
  npm: string;
};

/** What the last `npm run build` in a package consumed and produced. */
export type BuildStamp = {
  /** `PackageTreeHasher.FORMAT` the hashes were computed under */
  format: number;
  /** own sources + install identity + every transitive workspace dependency's sources and outputs */
  inputHash: string;
  /** the package's own outputs right after the build — a later mismatch means the outputs were touched or removed */
  outputHash: string;
};

/**
 * The two per-package markers `build-workspace` reads and writes, both inside node_modules:
 * `.proteinjs-install-stamp` and `.proteinjs-build-stamp`. node_modules is the one directory
 * every package already gitignores, npm leaves dotfiles there alone, and a package's `clean`
 * script removes it — so a clean is a cold start by construction, and no stamp can ever be
 * committed. A stamp is cleared BEFORE its step runs and written only after the step succeeds:
 * an interrupted install or build leaves no stamp behind, so the next run redoes it.
 */
export class PackageStamps {
  static readonly INSTALL_STAMP_FILE = '.proteinjs-install-stamp';
  static readonly BUILD_STAMP_FILE = '.proteinjs-build-stamp';

  constructor(private packageDir: string) {}

  static installSatisfied(stamp: InstallStamp, current: InstallStamp): boolean {
    return stamp.lockHash === current.lockHash && stamp.node === current.node && stamp.npm === current.npm;
  }

  static buildSatisfied(stamp: BuildStamp, format: number, inputHash: string, outputHash: string): boolean {
    return stamp.format === format && stamp.inputHash === inputHash && stamp.outputHash === outputHash;
  }

  async readInstall(): Promise<InstallStamp | undefined> {
    const stamp = await this.read(PackageStamps.INSTALL_STAMP_FILE);
    return stamp &&
      typeof stamp.lockHash === 'string' &&
      typeof stamp.node === 'string' &&
      typeof stamp.npm === 'string'
      ? (stamp as InstallStamp)
      : undefined;
  }

  async writeInstall(stamp: InstallStamp): Promise<void> {
    await this.write(PackageStamps.INSTALL_STAMP_FILE, stamp);
  }

  async clearInstall(): Promise<void> {
    await this.clear(PackageStamps.INSTALL_STAMP_FILE);
  }

  async readBuild(): Promise<BuildStamp | undefined> {
    const stamp = await this.read(PackageStamps.BUILD_STAMP_FILE);
    return stamp &&
      typeof stamp.format === 'number' &&
      typeof stamp.inputHash === 'string' &&
      typeof stamp.outputHash === 'string'
      ? (stamp as BuildStamp)
      : undefined;
  }

  async writeBuild(stamp: BuildStamp): Promise<void> {
    await this.write(PackageStamps.BUILD_STAMP_FILE, stamp);
  }

  async clearBuild(): Promise<void> {
    await this.clear(PackageStamps.BUILD_STAMP_FILE);
  }

  private stampPath(fileName: string): string {
    return path.join(this.packageDir, 'node_modules', fileName);
  }

  /** undefined when absent or unreadable — a corrupt stamp is no stamp */
  private async read(fileName: string): Promise<Record<string, unknown> | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.stampPath(fileName), 'utf-8'));
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Atomic: written beside, then renamed over — a crash mid-write leaves the old stamp or none. */
  private async write(fileName: string, value: unknown): Promise<void> {
    const stampPath = this.stampPath(fileName);
    await fs.mkdir(path.dirname(stampPath), { recursive: true });
    const tempPath = `${stampPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(value));
    await fs.rename(tempPath, stampPath);
  }

  private async clear(fileName: string): Promise<void> {
    await fs.rm(this.stampPath(fileName), { force: true });
  }
}
