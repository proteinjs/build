import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * The lockfile-preservation rule for implicit installs (see `materializeDependencies` for why):
 * take a snapshot before `npm install`, restore it afterwards if npm rewrote the lock, and
 * remove a lock npm introduced where none was committed. One owner; both the doctor's
 * `materializeDependencies` and `build-workspace`'s install step apply it.
 */
export class LockfileSnapshot {
  private constructor(
    private lockfilePath: string,
    private before: string | undefined
  ) {}

  static async take(packageDir: string): Promise<LockfileSnapshot> {
    const lockfilePath = path.join(packageDir, 'package-lock.json');
    const before = await fs.readFile(lockfilePath, 'utf-8').catch(() => undefined);
    return new LockfileSnapshot(lockfilePath, before);
  }

  async restore(): Promise<void> {
    if (this.before === undefined) {
      // No lockfile existed — materialization must not introduce one.
      await fs.rm(this.lockfilePath, { force: true });
      return;
    }
    const after = await fs.readFile(this.lockfilePath, 'utf-8').catch(() => undefined);
    if (after !== this.before) {
      await fs.writeFile(this.lockfilePath, this.before);
    }
  }
}
