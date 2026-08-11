import * as path from 'path';
import * as fs from 'fs/promises';
import { cmd, LogOptions } from '@proteinjs/util-node';

/**
 * Install a package's dependencies WITHOUT mutating its committed lockfile.
 *
 * Build-workspace and the doctor run `npm install` to MATERIALIZE node_modules — the intent is
 * node_modules state, never lockfile state. npm nonetheless rewrites package-lock.json on these
 * installs (normalizing shape, "correcting" entries for workspace deps that are symlinks on
 * disk), leaving unstaged churn in every built repo — churn nobody commits, which then wedges
 * rebase pulls (see syncWorkspace). Dependency-DECLARATION changes (`workspace-package npm i
 * <pkg>`) are the explicit path and keep updating lockfiles; every implicit install goes
 * through here instead.
 *
 * Mechanism: snapshot the lockfile, install (the lockfile still drives resolution), restore the
 * snapshot if the install changed it. A lockfile that was already dirty before the install is
 * restored to exactly that dirty content — this helper only guarantees the install itself adds
 * no churn; it never cleans up anyone else's.
 *
 * CI is the exception, same split as linting in buildWorkspace: CI COMMITS its own fallout —
 * the "commit package-locks" release step depends on CI installs regenerating locks after
 * version bumps — so under CI=true the install writes lockfiles normally. Locally there is no
 * commit step, so lockfile writes are pure churn.
 */
export const materializeDependencies = async (packageDir: string, logOptions?: LogOptions): Promise<void> => {
  if (process.env.CI === 'true') {
    await cmd('npm', ['install'], { cwd: packageDir }, logOptions);
    return;
  }

  const lockfilePath = path.join(packageDir, 'package-lock.json');
  let before: string | undefined;
  try {
    before = await fs.readFile(lockfilePath, 'utf-8');
  } catch {
    before = undefined;
  }

  await cmd('npm', ['install'], { cwd: packageDir }, logOptions);

  if (before === undefined) {
    // No lockfile existed — materialization must not introduce one.
    await fs.rm(lockfilePath, { force: true });
    return;
  }
  const after = await fs.readFile(lockfilePath, 'utf-8').catch(() => undefined);
  if (after !== before) {
    await fs.writeFile(lockfilePath, before);
  }
};
