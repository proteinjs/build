import { cmd, LogOptions } from '@proteinjs/util-node';
import { LockfileSnapshot } from './LockfileSnapshot';

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
 * Mechanism (`LockfileSnapshot`): snapshot the lockfile, install (the lockfile still drives
 * resolution), restore the snapshot if the install changed it. A lockfile that was already dirty
 * before the install is restored to exactly that dirty content — this helper only guarantees the
 * install itself adds no churn; it never cleans up anyone else's.
 *
 * CI is the exception, same split as linting in buildWorkspace: CI COMMITS its own fallout —
 * the "commit package-locks" release step depends on CI installs regenerating locks after
 * version bumps — so under CI=true the install writes lockfiles normally. Locally there is no
 * commit step, so lockfile writes are pure churn.
 */
export const materializeDependencies = async (packageDir: string, logOptions?: LogOptions): Promise<void> => {
  if (process.env.CI === 'true') {
    await cmd('npm', MATERIALIZE_INSTALL_ARGS, { cwd: packageDir }, logOptions);
    return;
  }

  const snapshot = await LockfileSnapshot.take(packageDir);
  await cmd('npm', MATERIALIZE_INSTALL_ARGS, { cwd: packageDir }, logOptions);
  await snapshot.restore();
};

/**
 * The one owner of npm-install args: EVERY `npm install` this package spawns — build-workspace's
 * and the doctor's materialization, pull-forward's manifest installs, version-workspace's CI
 * installs (`--package-lock-only` composes on top), and the test fixtures' — reads these, so the
 * audit report and the funding notice — output nobody reads at this point, each a registry round
 * trip of its own — are off everywhere at once (installArgsOwner.test.ts reds a second owner).
 * Measured 2026-09-04 on the founder's Mac: with the audit call `npm install left-pad` took
 * 5 min 00 s (the advisories endpoint hung to npm's timeout), without it 0.3 s; the same stall
 * sat inside every package install of a cold `build-workspace`, and inside the pullForward
 * fixture's bare installs, which timed the suite out at the R7 departure.
 */
export const MATERIALIZE_INSTALL_ARGS: readonly string[] = ['install', '--no-audit', '--no-fund'];
