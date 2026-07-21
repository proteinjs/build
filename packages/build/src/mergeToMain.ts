import * as path from 'path';
import { exec } from 'child_process';
import { PackageUtil, cmd, LogColorWrapper } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { primaryLogColor, secondaryLogColor } from './logColors';

const cw = new LogColorWrapper();
const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('merge', secondaryLogColor) });

/**
 * Opt-in pre-phase for `version-workspace`: merge feature-branch work into `main` in each leaf git
 * repo BEFORE versioning, so the release runs on main. Without the flag, behavior is unchanged —
 * the workspace versions in place on whatever branch each repo is on (the "stay on feature
 * branches and just bump deps" mode).
 *
 *   version-workspace --merge-to-main
 *       Every leaf repo whose current branch != main merges its current branch HEAD into main.
 *
 *   version-workspace --merge-to-main=chat:17dda73,thought:ffdc105
 *       Only the named repos (matched by git-repo directory name), each merged at the PINNED sha —
 *       work pushed to the feature branch after the pin simply isn't in this release. A bare name
 *       (no `:sha`) merges that repo's current branch HEAD.
 *
 * Also accepted via env: VERSION_WORKSPACE_MERGE_TO_MAIN (same syntax; `1`/`true` = bare mode).
 *
 * Semantics per repo: fetch; checkout main; sync with origin/main FAST-FORWARD-ONLY (never rebase
 * — local main legitimately holds an unpushed merge commit on resume, and a rebase would
 * linearize it; true local/origin divergence stops loudly); merge the sha with a merge commit
 * (`--no-ff`). Already-merged shas are skipped (idempotent — safe to re-run after fixing a
 * conflict). A conflict stops the run with the repo + conflicted files named, leaving the merge in
 * progress in that repo for resolution; re-running continues past it. Repos are LEFT ON MAIN
 * afterward (the feature branch itself is never modified); the workspace root/metarepos are never
 * touched by this phase.
 */
export type MergeToMainSpec = { enabled: boolean; pins: Map<string, string | undefined> };

export function parseMergeToMainSpec(args: string[], envValue?: string): MergeToMainSpec {
  const pins = new Map<string, string | undefined>();
  let enabled = false;

  const consume = (value: string) => {
    enabled = true;
    if (value === '' || value === 'true' || value === '1') {
      return; // bare mode: all repos at branch HEAD
    }
    for (const entry of value.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }
      const [repo, sha] = trimmed.split(':').map((s) => s.trim());
      pins.set(repo, sha || undefined);
    }
  };

  for (const arg of args) {
    if (arg === '--merge-to-main') {
      consume('');
    } else {
      const match = arg.match(/^--merge-to-main=(.*)$/);
      if (match) {
        consume(match[1]);
      }
    }
  }
  if (!enabled && envValue) {
    consume(envValue);
  }

  return { enabled, pins };
}

export async function mergeToMain(workspacePath: string, spec: MergeToMainSpec, planOnly: boolean): Promise<void> {
  if (!spec.enabled) {
    return;
  }

  const repoRoots = await leafRepoRoots(workspacePath);
  for (const repoRoot of repoRoots) {
    const repoName = path.basename(repoRoot);
    const pinned = spec.pins.size > 0;
    if (pinned && !spec.pins.has(repoName)) {
      continue;
    }
    const branch = await git(repoRoot, 'rev-parse --abbrev-ref HEAD');
    const sha = spec.pins.get(repoName) ?? (branch === 'main' ? undefined : await git(repoRoot, 'rev-parse HEAD'));
    if (!sha) {
      // Bare mode and already on main with no pin: nothing to merge.
      continue;
    }

    if (planOnly) {
      logger.info({
        message: `(${cw.color(repoName)}) would merge ${sha.slice(0, 9)} (${branch}) into main. NOTE: plan-only bump levels below reflect PRE-merge state; run with --dry-run after merging for post-merge planning.`,
      });
      continue;
    }

    await cmd('git', ['fetch', '-q'], { cwd: repoRoot }, { logPrefix: `[${cw.color(repoName)}] ` });
    try {
      await git(repoRoot, `cat-file -e ${sha}^{commit}`);
    } catch {
      throw new Error(`(${repoName}) --merge-to-main sha ${sha} is not a commit in this repo`);
    }

    if (branch !== 'main') {
      await cmd('git', ['checkout', 'main'], { cwd: repoRoot }, { logPrefix: `[${cw.color(repoName)}] ` });
    }
    // Sync local main with origin FAST-FORWARD-ONLY — never rebase: after a prior run of this
    // phase, local main legitimately holds an UNPUSHED MERGE COMMIT, and a rebase would linearize
    // it (replaying every branch commit, usually into conflicts). Ahead-of-origin is the normal
    // resume state and is fine; true divergence (local merge AND origin moved) is abnormal —
    // stop loudly rather than guess.
    try {
      await cmd(
        'git',
        ['merge', '--ff-only', 'origin/main'],
        { cwd: repoRoot },
        { logPrefix: `[${cw.color(repoName)}] ` }
      );
    } catch {
      const originIsAncestor = await git(repoRoot, 'merge-base --is-ancestor origin/main HEAD')
        .then(() => true)
        .catch(() => false);
      if (!originIsAncestor) {
        throw new Error(
          `(${repoName}) local main and origin/main have DIVERGED (local holds unpushed commits AND origin moved). ` +
            `Reconcile manually (e.g. merge origin/main into main), then re-run.`
        );
      }
      logger.info({
        message: `(${cw.color(repoName)}) local main is ahead of origin (unpushed merge from a prior run) — continuing`,
      });
    }

    const alreadyMerged = await git(repoRoot, `merge-base --is-ancestor ${sha} HEAD`)
      .then(() => true)
      .catch(() => false);
    if (alreadyMerged) {
      logger.info({ message: `(${cw.color(repoName)}) ${sha.slice(0, 9)} already on main — skipping merge` });
      continue;
    }

    logger.info({ message: `(${cw.color(repoName)}) merging ${sha.slice(0, 9)} (${branch}) into main` });
    try {
      await cmd(
        'git',
        [
          'merge',
          '--no-ff',
          '-m',
          `merge: ${branch} @ ${sha.slice(0, 9)} -> main (version-workspace --merge-to-main)`,
          sha,
        ],
        { cwd: repoRoot },
        { logPrefix: `[${cw.color(repoName)}] ` }
      );
    } catch (error) {
      const conflicted = await git(repoRoot, 'diff --name-only --diff-filter=U').catch(() => '');
      throw new Error(
        `(${repoName}) merge of ${sha.slice(0, 9)} into main has conflicts: [${conflicted.split('\n').filter(Boolean).join(', ')}]. ` +
          `Resolve + commit the merge in ${repoRoot}, then re-run — already-merged repos are skipped.`
      );
    }
  }
}

/**
 * Idempotency guard for the release flow. The versioning loop writes a package's bumped
 * package.json to disk (versionWorkspace.ts) BEFORE it commits + pushes that package; an
 * interruption in that window (a flaky release-build/test failure, a publish/push error) leaves an
 * uncommitted bumped package.json. A blind re-run would then read the already-bumped DISK version
 * as its base and double-bump it — or, for a partially-pushed multi-package repo, fail to re-flag
 * the un-pushed package and silently SKIP it. Both produce a wrong release.
 *
 * So, before the versioning loop (release mode only), STOP if any leaf repo carries uncommitted
 * package.json / package-lock.json — those can only be leftovers from a prior interrupted run
 * (a clean merge phase commits its resolutions). Non-destructive: it names the files and the
 * one-line reset, and never mutates — the operator resets to committed (source-of-truth) state and
 * re-runs. On a fresh run after clean merges there is nothing uncommitted, so this is a no-op.
 */
export async function assertNoLeftoverVersionState(workspacePath: string): Promise<void> {
  const repoRoots = await leafRepoRoots(workspacePath);
  const dirty: string[] = [];
  for (const repoRoot of repoRoots) {
    const out = await git(repoRoot, 'status --porcelain').catch(() => '');
    for (const line of out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      const file = line.replace(/^.. /, '');
      const base = path.basename(file);
      if (base === 'package.json' || base === 'package-lock.json') {
        dirty.push(`${path.basename(repoRoot)}: ${line}`);
      }
    }
  }
  if (dirty.length > 0) {
    throw new Error(
      `Refusing to version: uncommitted package.json/package-lock.json detected — almost certainly ` +
        `leftovers from a PRIOR INTERRUPTED release run. Re-running blindly could double-bump or skip ` +
        `these packages. Reset each to its committed (source-of-truth) state and re-run:\n` +
        dirty.map((d) => `  ${d}`).join('\n') +
        `\n  (per repo: git checkout -- <file>, or git checkout -- . after confirming there is no ` +
        `unrelated work)`
    );
  }
}

/** Unique git-repo roots that directly contain workspace packages — never the workspace root. */
async function leafRepoRoots(workspacePath: string): Promise<string[]> {
  const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const roots = new Set<string>();
  for (const packageName of sortedPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    const repoRoot = await git(packageDir, 'rev-parse --show-toplevel').catch(() => undefined);
    if (repoRoot && path.resolve(repoRoot) !== path.resolve(workspacePath)) {
      roots.add(repoRoot);
    }
  }
  return Array.from(roots).sort();
}

function git(cwd: string, args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git ${args}`, { cwd }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
  });
}
