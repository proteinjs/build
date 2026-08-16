import * as path from 'path';
import { exec } from 'child_process';
import { LocalPackage, LocalPackageMap, PackageUtil, cmd, Fs, LogColorWrapper } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import semver from 'semver';
import { primaryLogColor, secondaryLogColor } from './logColors';
import { hasLintConfig } from './lintWorkspace';
import { mergeToMain, parseMergeToMainSpec, revertLeftoverVersionState } from './mergeToMain';
import { PackageRegistry, NpmPackageRegistry, isNetworkError, maxPublishedVersion } from './PackageRegistry';

const cw = new LogColorWrapper();
const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('version', secondaryLogColor) });
const fixedVersionWorkspacesToVersion: { [workspacePath: string]: boolean } = {};

/**
 * Injectable collaborators for `versionWorkspace`. Production runs use the npm-CLI registry
 * and the real clean/install/build/test pipeline; the test harness substitutes an in-memory
 * registry and a lightweight build so the versioning flow itself — baselines, publishes,
 * records, cascades — runs hermetically against staged registry/git states.
 */
export type VersionWorkspaceSeams = {
  registry: PackageRegistry;
  buildAndTest: (localPackage: LocalPackage) => Promise<void>;
};

export type VersionWorkspaceOptions = {
  /** Workspace root to version. Defaults to `process.cwd()` (the bin entry's contract). */
  workspacePath?: string;
  seams?: Partial<VersionWorkspaceSeams>;
};

export async function versionWorkspace(options: VersionWorkspaceOptions = {}) {
  const dryRun = isDryRun();
  const planOnly = isPlanOnly();
  const ciMode = isCiMode();
  const seams: VersionWorkspaceSeams = {
    registry: options.seams?.registry ?? new NpmPackageRegistry(),
    buildAndTest: options.seams?.buildAndTest ?? (ciMode ? ciPrepareForPublish : buildAndTest),
  };

  if (planOnly) {
    logger.info({
      message:
        'Plan-only mode enabled. Scan + commit-leaves + would-be bumps will be computed and logged; nothing will be written to disk, built, tested, published, committed, or pushed.',
    });
  } else if (dryRun) {
    logger.info({ message: 'Dry run mode enabled. Publish and push operations will be skipped.' });
  }
  if (ciMode) {
    logger.info({
      message:
        'CI publish mode enabled. The checkout is the workflow-pinned tip (never pulled); the workflow owns build/test; baselines come from the registry, never the local record.',
    });
  }
  const workspacePath = options.workspacePath ?? process.cwd();
  await evictGitLocks(workspacePath);

  // Opt-in pre-phase: merge feature-branch work into main per leaf repo before versioning (see
  // mergeToMain.ts). Default (no flag) is unchanged: version in place on each repo's current
  // branch. Repos this phase touches are left ON MAIN; feature branches are never modified.
  // Never in CI mode: CI publishes exactly the pushed tip it was triggered by.
  const mergeSpec = parseMergeToMainSpec(process.argv.slice(2), process.env.VERSION_WORKSPACE_MERGE_TO_MAIN);
  if (!ciMode) {
    await mergeToMain(workspacePath, mergeSpec, planOnly);
  }

  // Release-flow idempotency sweep: after clean merges, uncommitted package.json/lock can only be
  // crash residue from a prior interrupted versioning run (in-run failures revert their own
  // transient writes). Restore committed truth before the loop reads disk state — the re-run then
  // recomputes every bump from its registry baseline, healing the interruption without operator
  // surgery. Release mode = --merge-to-main; skip in preview/dry modes (which legitimately leave
  // writes).
  if (!ciMode && mergeSpec.enabled && !planOnly && !dryRun) {
    await revertLeftoverVersionState(workspacePath);
  }

  const workspaceRootDirty = await isRepoDirty(workspacePath);
  if (workspaceRootDirty) {
    logger.info({ message: `> Workspace root is dirty, will skip pull/push for root repo` });
  }
  if (ciMode) {
    // NEVER pull in CI: the workflow's stale-checkout guard decides whether this checkout may
    // publish at all. Fast-forwarding here would advance the tree PAST the checkout the
    // workflow built and tested — the dist on disk would no longer match HEAD, re-opening the
    // stale-dist-under-newer-tag publish race the guard exists to close.
    logger.info({ message: `> CI publish mode: skipping pullWorkspace for (${workspacePath})` });
  } else if (dryRun || planOnly) {
    logger.info({ message: `> Skipping pullWorkspace for (${workspacePath})` });
  } else {
    await pullWorkspace(workspacePath, workspaceRootDirty);
  }

  const { packageMap, packageGraph, sortedPackageNames, workspaceToPackageMap } =
    await PackageUtil.getWorkspaceMetadata(workspacePath);
  const userSkippedPackages = getUserSkippedPackages();
  if (userSkippedPackages.size > 0) {
    logger.info({
      message: `> Skipping packages this run (no version/build/publish; dependents keep their current dep versions): ${Array.from(
        userSkippedPackages
      )
        .map((n) => cw.color(n))
        .join(', ')}`,
    });
  }
  const skippedPackages = ['root', 'typescript-parser', ...Array.from(userSkippedPackages)];
  const filteredPackageNames = sortedPackageNames.filter((packageName) => {
    const localPackage = packageMap[packageName];
    return (
      !!localPackage.packageJson.scripts?.clean &&
      !!localPackage.packageJson.scripts?.build &&
      !skippedPackages.includes(packageName)
    );
  });

  logger.info({ message: `> Versioning workspace (${workspacePath})` });

  // Phase 0: scan every candidate package's UNRELEASED commits up front. For a publishable
  // package the scan is anchored on the record commit of its REGISTRY-MAX release (via the
  // release tag), not on the upstream branch — pushed-but-never-released content (a shadowed
  // release under a sibling lineage's higher versions) still counts as changes to ship. This
  // gives us a map of packages that have their own changes to ship, separate from the
  // traditional "dependency bumped, cascade" trigger.
  const commitBumps = await scanCommitBumps(filteredPackageNames, packageMap, seams.registry, ciMode);
  if (commitBumps.size === 0) {
    logger.info({ message: `> No packages have unreleased changes` });
  } else {
    const scanSummary = Array.from(commitBumps.entries())
      .map(([name, bump]) => `${cw.color(name)}:${bump}`)
      .join(', ');
    logger.info({ message: `> Packages with unreleased changes: ${scanSummary}` });
  }

  // Phase 1: identify commit-leaves — packages with unreleased commits whose
  // direct workspace-local deps have none. These are the roots of change
  // and must be versioned+published first; once they're out, the cascade of
  // dep-version rewrites propagates to the rest.
  const commitLeaves = computeCommitLeaves(commitBumps, packageGraph, filteredPackageNames);
  if (commitLeaves.length > 0) {
    logger.info({
      message: `> Commit-leaves (root changes, will publish first): ${commitLeaves.map((n) => cw.color(n)).join(', ')}`,
    });
  }

  // Phase 2: unified topo-ordered loop. For each package we combine two
  // signals: own unreleased commits (from `commitBumps`) and dep-version
  // rewrites (from `applyDependencyVersionRewrites`). A package publishes
  // iff either signal fires. The effective bump is the max of (own-commit
  // bump) and (cascade → 'patch'). Topo order (deps-first) ensures leaves
  // publish before dependents that need to consume their new versions, and
  // any non-leaf commit-haver still gets its own-commit bump respected
  // rather than being demoted to 'patch' by the cascade.
  //
  // Versions this run saw the registry accept (or would accept, in plan/dry preview modes),
  // by package name. Dependent ranges are rewritten from THIS map for deps releasing this
  // run, and from the registry's own version list for deps whose latest release a PRIOR run
  // recorded (see applyDependencyVersionRewrites) — never from in-memory package.json state:
  // a range only ever points at a version that verifiably exists on the registry (topo order
  // guarantees the upstream entry lands before dependents read it).
  //
  // INVARIANT: every entry EXCEEDS the package's registry max at compute time. Targets are
  // computed as bump(registry max), and `publish` refuses (loudly) to record a target that
  // does not exceed every other published version (see assertReleaseExceedsRegistryMax) —
  // so a caret range rewritten from an entry here always semver-resolves to THIS run's
  // release, never to a shadowed lower version or another lineage's content.
  const acceptedVersions = new Map<string, string>();
  // Registry version lists read for the prior-run rewrite path, cached per run: a dep that is
  // not releasing this run cannot grow new versions mid-run, and a dep that IS releasing hits
  // the acceptedVersions short-circuit before this cache is ever consulted. Never shared with
  // the scan, baseline, or publish reads — those need per-phase registry truth, not a snapshot.
  const rewriteVersionsCache = new Map<string, string[]>();
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const skipBumpingPackageVersion = isInFixedVersionWorkspace(localPackage);
    const ownBump = skipBumpingPackageVersion ? undefined : commitBumps.get(packageName);
    const dependenciesChanged = await applyDependencyVersionRewrites(
      localPackage,
      packageMap,
      packageGraph,
      userSkippedPackages,
      acceptedVersions,
      seams.registry,
      rewriteVersionsCache
    );
    const cascadeBump: CommitBump | undefined = dependenciesChanged ? 'patch' : undefined;
    const effectiveBump = maxBump(ownBump, cascadeBump);

    if (!effectiveBump && !dependenciesChanged) {
      continue;
    }

    const willPublish = !skipBumpingPackageVersion && shouldPublishPackage(localPackage);
    if (effectiveBump && !skipBumpingPackageVersion) {
      const localVersion = localPackage.packageJson.version;
      // REGISTRY-RECONCILED BASELINE: the version we bump from is the max PUBLISHED version
      // across the package's full registry version list — never the local package.json, and
      // never the `latest` dist-tag (which can diverge from version order). The local record
      // desyncs in both directions (bump-without-publish, publish-without-record) and can sit
      // entirely below another workspace lineage's releases (2026-08-12 train: chat-common
      // local 1.22.x vs sibling-published 1.24.0 — dependents' caret ranges resolved to the
      // sibling's content, shadowing this workspace's release). Bumping PAST the registry max
      // makes every one of those shapes self-heal on the next run. A never-published package
      // has no registry lineage; its local version is the only baseline that exists.
      let baseline = localVersion;
      if (willPublish) {
        const registryMax = maxPublishedVersion(await seams.registry.getPublishedVersions(localPackage));
        if (registryMax) {
          baseline = registryMax;
          if (registryMax !== localVersion) {
            logger.info({
              message: `(${cw.color(packageName)}) registry max (${registryMax}) != local package.json (${localVersion}) — reconciling: the registry is the baseline`,
            });
          }
        } else {
          logger.info({
            message: `(${cw.color(packageName)}) no published versions on its registry — first publish, baseline is local (${localVersion})`,
          });
        }
      }
      localPackage.packageJson.version = semver.inc(baseline, effectiveBump);
      const sourceNote = ownBump ? (cascadeBump ? `own+cascade, own=${ownBump}` : `own=${ownBump}`) : 'dep cascade';
      const planPrefix = planOnly ? 'would bump' : 'bumping';
      logger.info({
        message: `(${cw.color(packageName)}) ${planPrefix} version (${effectiveBump}; ${sourceNote}) from ${baseline} -> ${localPackage.packageJson.version}`,
      });
    }

    // Fixed-version workspace tracking: record even in plan-only so we can
    // report the would-be synced version below. This is metadata only — the
    // actual sync (disk write, commit, push) is gated by the planOnly /
    // dryRun guards after the loop.
    if (isInFixedVersionWorkspace(localPackage) && localPackage.workspace) {
      fixedVersionWorkspacesToVersion[localPackage.workspace.path] = true;
    }

    if (planOnly) {
      // Plan-only: skip the disk write, the build/test, publish, push/tag,
      // and the eventual syncFixedVersionWorkspaces pass. Recording the would-be
      // accepted version keeps the simulated cascade correct for the remaining
      // packages in this loop.
      if (willPublish && effectiveBump) {
        acceptedVersions.set(packageName, localPackage.packageJson.version);
      }
      continue;
    }

    if (effectiveBump || dependenciesChanged) {
      await Fs.writeFiles([
        { path: localPackage.filePath, content: JSON.stringify(localPackage.packageJson, null, 2) },
      ]);
    }

    // TRANSIENT BUMP: from the write above until the durable record (`pushAndTag` commits
    // package.json + lockfile), the bumped version exists only in the working tree. Registry
    // acceptance is the commit point — any failure before it reverts the transient writes, so
    // an interrupted run leaves committed truth on disk and the next run recomputes everything
    // from the registry baseline instead of double-bumping off leftover state.
    try {
      await seams.buildAndTest(localPackage);
      if (isInFixedVersionWorkspace(localPackage) && localPackage.workspace) {
        logger.info({
          message: `(${cw.color(packageName)}) skipping version push for package in a fixed-version workspace`,
        });
        continue;
      }

      if (willPublish) {
        await publish(localPackage, seams.registry);
        acceptedVersions.set(packageName, localPackage.packageJson.version);
      }
    } catch (error) {
      await revertTransientVersionWrites(localPackage);
      throw error;
    }

    await pushAndTag(localPackage);
  }

  if (planOnly) {
    await logPlannedFixedVersionSyncs(Object.keys(fixedVersionWorkspacesToVersion), packageMap, workspaceToPackageMap);
    logger.info({ message: `> Plan-only: skipping fixed-version sync, metarepo push, and symlink refresh` });
    logger.info({ message: `> Finished versioning workspace (${workspacePath}) [plan-only]` });
    return;
  }

  const pushWithoutSync = true;
  await syncFixedVersionWorkspaces(
    Object.keys(fixedVersionWorkspacesToVersion),
    packageMap,
    workspaceToPackageMap,
    pushWithoutSync
  );
  if (ciMode) {
    // Workstation tail phases don't apply in CI: there is no parent metarepo pointer to push
    // from a leaf repo's workflow checkout, and refreshing workspace symlinks would only churn
    // a node_modules tree the runner is about to discard.
    logger.info({ message: `> Finished versioning workspace (${workspacePath}) [ci]` });
    return;
  }
  await pushMetarepos(workspacePath, workspaceRootDirty);
  await symlinkWorkspace(workspacePath, filteredPackageNames, packageMap);
  logger.info({ message: `> Finished versioning workspace (${workspacePath})` });
}

function isDryRun() {
  const args = process.argv.slice(2);
  if (args.includes('--dry-run') || args.includes('--dryrun')) {
    return true;
  }

  const envFlag = process.env.VERSION_WORKSPACE_DRY_RUN ?? process.env.DRY_RUN;
  if (envFlag) {
    return envFlag === 'true' || envFlag === '1';
  }

  return false;
}

/**
 * Plan-only mode: the strictest possible preview. Runs Phase 0 (commit-bump
 * scan) and Phase 1 (commit-leaf detection) so you can see which packages
 * would be published and at what level, then simulates the topo-ordered
 * cascade in memory (for correct would-be bump reporting) but:
 *
 *   - does NOT write any package.json or lerna.json to disk
 *   - does NOT run `npm install` / lint / build / test
 *   - does NOT publish, commit, push, tag, or refresh symlinks
 *
 * Intended for a fast preview of "what will this release do?" Implies
 * dry-run for the few checks that need a binary answer (e.g. `publish`'s
 * own dry-run guard), but the stricter plan-only guards in the main loop
 * mean those code paths never execute in the first place.
 */
function isPlanOnly() {
  const args = process.argv.slice(2);
  if (args.includes('--plan-only') || args.includes('--planonly') || args.includes('--plan')) {
    return true;
  }

  const envFlag = process.env.VERSION_WORKSPACE_PLAN_ONLY ?? process.env.PLAN_ONLY;
  if (envFlag) {
    return envFlag === 'true' || envFlag === '1';
  }

  return false;
}

/**
 * CI publish mode: the repo's publish workflow invoking the SAME registry-reconciled release
 * flow the local train runs — one implementation, not a second brain (the June drift and the
 * 3.27.0 race class both came from CI versioning off its checkout — package.json, lockfile,
 * local tags — while concurrent releases advanced the registry past it, minting shadowed
 * releases dependents' ranges never resolve to).
 *
 * What the mode changes is CONTEXT, not versioning semantics:
 *   - the checkout is the workflow's pinned tip: never pulled, never merged into;
 *   - the workflow owns install/build/test of the whole workspace BEFORE the publish step, so
 *     the per-package pipeline reduces to lockfile regeneration (`ciPrepareForPublish`);
 *   - change detection can never lean on the unpushed scan (a push-event checkout has nothing
 *     unpushed) — see the CI anchors in `classifyUnreleasedCommits`;
 *   - workstation tail phases (metarepo pointer pushes, symlink refresh) don't run.
 * Baselines, cascade rewrites, the release invariant, the resume window, and publish-confirmed
 * recording are the shared path, unchanged.
 *
 * Accepts `--ci` or the VERSION_WORKSPACE_CI env var.
 */
function isCiMode() {
  const args = process.argv.slice(2);
  if (args.includes('--ci')) {
    return true;
  }

  const envFlag = process.env.VERSION_WORKSPACE_CI;
  if (envFlag) {
    return envFlag === 'true' || envFlag === '1';
  }

  return false;
}

/**
 * Packages to exclude from this run entirely: not versioned, built, or
 * published, and — critically — dependents' references to them are NOT
 * rewritten to the on-disk version (see `applyDependencyVersionRewrites`).
 *
 * Use case: a package in the workspace has shipped a breaking new major
 * (already published and checked out locally) but its consumers haven't been
 * migrated yet. Skipping it lets the rest of the workspace version and deploy
 * while consumers stay pinned to the version they were built against.
 *
 * Accepts `--skip=<name>[,<name>...]` (repeatable) or the
 * VERSION_WORKSPACE_SKIP env var, e.g.:
 *   version-workspace --skip=@proteinjs/conversation
 */
function getUserSkippedPackages(): Set<string> {
  const skipped = new Set<string>();
  const args = process.argv.slice(2);
  for (const arg of args) {
    const match = arg.match(/^--skip=(.+)$/);
    if (match) {
      match[1]
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
        .forEach((name) => skipped.add(name));
    }
  }

  const envFlag = process.env.VERSION_WORKSPACE_SKIP;
  if (envFlag) {
    envFlag
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .forEach((name) => skipped.add(name));
  }

  return skipped;
}

function isInFixedVersionWorkspace(localPackage: LocalPackage) {
  return (
    localPackage.workspace &&
    localPackage.workspace.lernaJson &&
    localPackage.workspace.lernaJson.version !== 'independent'
  );
}

async function getGitRepoRoot(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec('git rev-parse --show-toplevel', { cwd: dir }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function pullWorkspace(workspacePath: string, skipRootRepo = false) {
  const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const filteredPackageNames = sortedPackageNames.filter((packageName) => {
    const localPackage = packageMap[packageName];
    return (
      !!localPackage.packageJson.scripts?.clean &&
      !!localPackage.packageJson.scripts?.build &&
      packageName != 'typescript-parser'
    );
  });

  // Deduplicate: pull once per unique leaf git repo (repos that directly contain packages)
  const pulledRepoRoots = new Set<string>();
  logger.info({ message: `> Pulling workspace (${workspacePath})` });
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    const repoRoot = await getGitRepoRoot(packageDir);
    if (pulledRepoRoots.has(repoRoot)) {
      continue;
    }
    pulledRepoRoots.add(repoRoot);
    if (skipRootRepo && path.resolve(repoRoot) === path.resolve(workspacePath)) {
      const repoName = path.basename(repoRoot);
      logger.info({ message: `(${cw.color(repoName)}) skipping pull for dirty workspace root repo` });
      continue;
    }
    const repoName = path.basename(repoRoot);
    logger.info({ message: `(${cw.color(repoName)}) pulling latest changes` });
    await cmd('git', ['fetch'], { cwd: repoRoot }, { logPrefix: `[${cw.color(repoName)}] ` });
    const branch = await getCurrentBranch(repoRoot);
    // FAST-FORWARD-ONLY, never rebase: a repo may legitimately be AHEAD of its upstream with
    // unpushed commits — e.g. the `--merge-to-main` pre-phase leaves a main with an unpushed merge
    // commit. Rebasing linearizes that merge, replaying every branch commit into conflicts (the
    // failure this replaced). Ahead-of-upstream is a no-op here (versioning pushes it); a true
    // divergence (local unpushed AND upstream moved) stops loudly rather than silently rewriting.
    try {
      await cmd(
        'git',
        ['merge', '--ff-only', `origin/${branch}`],
        { cwd: repoRoot },
        { logPrefix: `[${cw.color(repoName)}] ` }
      );
      logger.info({ message: `(${cw.color(repoName)}) pulled latest changes` });
    } catch {
      const upstreamIsAncestor = await new Promise<boolean>((resolve) => {
        exec(`git merge-base --is-ancestor origin/${branch} HEAD`, { cwd: repoRoot }, (error) => resolve(!error));
      });
      if (!upstreamIsAncestor) {
        throw new Error(
          `(${repoName}) local ${branch} and origin/${branch} have DIVERGED (local holds unpushed commits AND upstream moved). ` +
            `Reconcile manually, then re-run.`
        );
      }
      logger.info({
        message: `(${cw.color(repoName)}) local ${branch} is ahead of origin (unpushed commits) — nothing to pull`,
      });
    }
  }

  logger.info({ message: `> Finished pulling workspace (${workspacePath})` });
}

/**
 * Rewrite `localPackage`'s dependency-version fields in package.json to the version each
 * workspace-local dep most recently had ACCEPTED BY THE REGISTRY: from `acceptedVersions`
 * when the dep released THIS run (topo order guarantees an upstream's acceptance lands before
 * its dependents are processed), and from the dep's own registry version list when its latest
 * release was recorded by a PRIOR run. Returns true if any dep version was rewritten.
 *
 * Ranges are rewritten from registry-accepted versions ONLY — never from a dep's on-disk
 * package.json. A local record is not proof of a publishable version: rewriting a dependent
 * to a bumped-but-never-published dep version strands it on an uninstallable range
 * (`npm install` retries ETARGET for minutes before dying).
 *
 * Why the registry read for deps that didn't release this run: acceptance is DURABLE, the
 * in-run map is not. An interrupted run can release an upstream (recorded + tagged) and die
 * before its dependents record their rewritten ranges — the revert restores their
 * pre-release ranges, and the re-run's scan finds nothing to ship for the upstream, so
 * `acceptedVersions` never carries its release. 2026-08-12 train, attempts 12+13:
 * chat-common@1.25.0 released and recorded at 2:42, the run died on a later package's
 * publish read; the re-run left space-common's stale ^1.22.1 in place and its committed
 * lockfile pin at the sibling's pre-ops 1.24.0 still SATISFIED that range, so `npm install`
 * bound to 1.24.0 and the build died on missing exports. Rewriting the floor to the registry
 * max closes both halves at once: the range tracks the accepted release, and a floor equal
 * to the highest published version invalidates every lower lockfile pin — the install that
 * follows can only resolve the rewritten floor.
 *
 * Pure rewrite — does NOT bump `localPackage`'s own version; the caller decides that by
 * combining this result with the commit-scan map (see `versionWorkspace`). Writing the
 * package.json to disk is left to the caller too, so we can apply the own-version bump in
 * the same write — which the caller MUST land before the package's `npm install` (the
 * install reads disk, not memory).
 */
async function applyDependencyVersionRewrites(
  localPackage: LocalPackage,
  packageMap: LocalPackageMap,
  packageGraph: any,
  userSkippedPackages: Set<string>,
  acceptedVersions: Map<string, string>,
  registry: PackageRegistry,
  rewriteVersionsCache: Map<string, string[]>
): Promise<boolean> {
  const localDependencies = packageGraph.successors(localPackage.name);
  if (!localDependencies || localDependencies.length == 0) {
    return false;
  }

  let dependenciesChanged = false;
  for (const localDependency of localDependencies) {
    const localDependencyPackage = packageMap[localDependency];
    const currentDependencyVersion = getDependencyVersion(localDependency, localPackage);
    if (!currentDependencyVersion) {
      throw new Error(
        `Package (${cw.color(localPackage.name)}) has dependency on ${localDependency}, but cannot find version in ${cw.color(localPackage.name)}'s package.json`
      );
    }

    if (currentDependencyVersion.isLocalPath) {
      continue;
    }

    if (userSkippedPackages.has(localDependency)) {
      // The dep was skipped via --skip: leave this package's reference at its
      // current (published, known-compatible) version.
      logger.info({
        message: `(${cw.color(localPackage.name)}) keeping dependency version of ${cw.color(localDependency)} at ${currentDependencyVersion.prefix ?? ''}${currentDependencyVersion.version} (skipped via --skip)`,
      });
      continue;
    }

    let targetVersion = acceptedVersions.get(localDependency);
    if (!targetVersion) {
      // The dep isn't releasing this run — but a PRIOR run may have released past this
      // package's recorded floor (see the function doc). The registry is the durable
      // accepted-version record; adopt its max. A registry max BELOW the recorded floor can
      // only be a stale/partial read (the floor was itself accepted once) — never downgrade.
      const priorReleaseMax = await maxPriorReleasedVersion(localDependencyPackage, registry, rewriteVersionsCache);
      if (priorReleaseMax && semver.gt(priorReleaseMax, currentDependencyVersion.version)) {
        logger.info({
          message: `(${cw.color(localPackage.name)}) dependency ${cw.color(localDependency)} released ${priorReleaseMax} in a prior run (recorded range floor ${currentDependencyVersion.version}) — adopting the registry-accepted version`,
        });
        targetVersion = priorReleaseMax;
      }
    }
    if (!targetVersion) {
      const onDiskVersion = localDependencyPackage.packageJson.version as string;
      if (currentDependencyVersion.version !== onDiskVersion) {
        logger.info({
          message: `(${cw.color(localPackage.name)}) leaving dependency version of ${cw.color(localDependency)} at ${currentDependencyVersion.prefix ?? ''}${currentDependencyVersion.version} (its local record ${onDiskVersion} did not release this run; ranges only track registry-accepted versions)`,
        });
      }
      continue;
    }

    if (currentDependencyVersion.version == targetVersion) {
      continue;
    }

    const newDependencyVersion: DependencyVersion = {
      prefix: currentDependencyVersion.prefix,
      version: targetVersion,
    };
    setDependencyVersion(localDependency, currentDependencyVersion, newDependencyVersion, localPackage);
    dependenciesChanged = true;
  }

  return dependenciesChanged;
}

/**
 * The max registry-accepted version of a dep that is not releasing this run — the durable
 * counterpart of `acceptedVersions` (every release flow's record path ends at the registry,
 * so the registry version list IS the accepted-version record that survives interrupted
 * runs). `undefined` for non-publishable deps (no registry to consult) and never-published
 * deps (no accepted versions exist). Reads are cached per run: see `rewriteVersionsCache`.
 */
async function maxPriorReleasedVersion(
  localDependencyPackage: LocalPackage,
  registry: PackageRegistry,
  rewriteVersionsCache: Map<string, string[]>
): Promise<string | undefined> {
  if (!shouldPublishPackage(localDependencyPackage, { quiet: true })) {
    return undefined;
  }
  let versions = rewriteVersionsCache.get(localDependencyPackage.name);
  if (!versions) {
    versions = await registry.getPublishedVersions(localDependencyPackage);
    rewriteVersionsCache.set(localDependencyPackage.name, versions);
  }
  return maxPublishedVersion(versions);
}

/**
 * Up-front scan: for each candidate package, classify its unreleased commits into a semver
 * bump level (`classifyUnreleasedCommits`). Returns a map (only contains entries for
 * packages with classifiable unreleased commits).
 *
 * This is the input to `computeCommitLeaves` and to the per-package bump-level
 * combine in the main loop.
 */
async function scanCommitBumps(
  packageNames: string[],
  packageMap: LocalPackageMap,
  registry: PackageRegistry,
  ciMode: boolean
): Promise<Map<string, CommitBump>> {
  const result = new Map<string, CommitBump>();
  for (const packageName of packageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    const bump = await classifyUnreleasedCommits(localPackage, packageDir, registry, ciMode);
    if (bump) {
      result.set(packageName, bump);
    }
  }
  return result;
}

/**
 * Change detection for one package: classify the commits its repo carries SINCE THE RECORD
 * COMMIT OF ITS REGISTRY-MAX RELEASE. The anchor is the release tag `<name>@<registryMax>`
 * that every release flow pushes (this flow's `pushAndTag`, CI's chore(release)) at the
 * commit that recorded the release. Path-filtered to the package dir so sibling packages'
 * commits in a multi-package repo don't register as this package's changes.
 *
 * Why not unpushed commits (`@{u}..HEAD`)? Pushed-but-unreleased content is invisible to a
 * branch-anchored scan. 2026-08-12 train, attempt 10: chat-common's ops content and its
 * shadowed 1.22.1 record were fully pushed while the registry max was a sibling lineage's
 * 1.24.0 — the branch scan reported "nothing to ship", so no run ever released the content
 * past the sibling's max, and dependents' recorded ^1.22.1 ranges kept resolving to the
 * sibling's pre-ops 1.24.0 (space-server/space-ui died on missing exports, every re-run,
 * forever). Anchoring on the registry-max release closes that at the source: the commits
 * between the sibling's record (merged into our history) and HEAD ARE unreleased content,
 * and the resulting bump — applied to the registry-max baseline in the main loop — releases
 * past the shadow. When the release tag exists this scan is a superset of the unpushed scan
 * (release records are always pushed), and prior-attempt residue can never lower the anchor
 * because the anchor version comes from the registry, not from local tags or records.
 *
 * Named fallbacks, each keeping the branch-anchored semantics:
 *   - not a publishable package: "released" doesn't exist for it; its bumps only version
 *     git records, and unpushed commits remain the right signal.
 *   - never published (no registry versions): every commit is unreleased and the local
 *     version is the only baseline that exists. Locally `@{u}..HEAD` matches how that
 *     baseline advances; in CI mode NOTHING is ever unpushed (the push event IS pushed
 *     commits), so the full path-scoped history is the unreleased content.
 *   - registry max has no local release tag: locally that usually means tags were never
 *     fetched — no commit to anchor on, fall back loudly to the unpushed scan. In CI mode
 *     (tags always fetched by the workflow's full checkout) the same shape means
 *     REGISTRY-AHEAD-OF-MAIN drift: the registry max was released from a lineage whose
 *     record never landed in this history (a sibling workspace's train, an overlapping run,
 *     a burned number). Anchor on the highest release record that IS in this history —
 *     commits since it are this lineage's unreleased content, and the registry-max BASELINE
 *     in the main loop still lifts the release past the foreign lineage. With no release
 *     record in the history at all, the full path-scoped history is unreleased.
 */
async function classifyUnreleasedCommits(
  localPackage: LocalPackage,
  packageDir: string,
  registry: PackageRegistry,
  ciMode: boolean
): Promise<CommitBump | undefined> {
  if (!shouldPublishPackage(localPackage, { quiet: true })) {
    return classifyUnpushedCommits(packageDir);
  }
  const registryMax = maxPublishedVersion(await registry.getPublishedVersions(localPackage));
  if (!registryMax) {
    if (ciMode) {
      return classifyCommitRange(packageDir, 'HEAD', '.');
    }
    return classifyUnpushedCommits(packageDir);
  }
  const releaseTag = `${localPackage.name}@${registryMax}`;
  if (!(await refExists(packageDir, `refs/tags/${releaseTag}`))) {
    if (ciMode) {
      const localAnchorTag = await maxLocalReleaseTag(packageDir, localPackage.name);
      if (localAnchorTag) {
        logger.warn({
          message: `(${cw.color(localPackage.name)}) registry max ${registryMax} has no release record in this history (registry-ahead drift: a concurrent lineage released it) — anchoring the change scan on this history's own latest release record (${localAnchorTag}); the registry-max baseline still lifts the release past the foreign lineage`,
        });
        return classifyCommitRange(packageDir, `${localAnchorTag}..HEAD`, '.');
      }
      logger.warn({
        message: `(${cw.color(localPackage.name)}) registry max ${registryMax} has no release record in this history, and the history carries no release record at all — treating the full path-scoped history as unreleased`,
      });
      return classifyCommitRange(packageDir, 'HEAD', '.');
    }
    logger.warn({
      message: `(${cw.color(localPackage.name)}) registry max ${registryMax} has no local release tag (${releaseTag}) — cannot anchor the change scan on the release record; falling back to the unpushed-commit scan (a pushed-but-unreleased change is invisible to it)`,
    });
    return classifyUnpushedCommits(packageDir);
  }
  return classifyCommitRange(packageDir, `${releaseTag}..HEAD`, '.');
}

/**
 * The highest release record present in THIS history for the package: max-semver among the
 * repo's `<name>@<version>` tags. `undefined` when no such tag exists. Scoped names contain
 * `@` themselves, so the version is whatever follows the LAST `@`.
 */
async function maxLocalReleaseTag(packageDir: string, packageName: string): Promise<string | undefined> {
  const tags = await new Promise<string[]>((resolve) => {
    exec(`git tag --list '${packageName}@*'`, { cwd: packageDir }, (error, stdout) => {
      resolve(error ? [] : stdout.split('\n').filter((line) => line.trim().length > 0));
    });
  });
  let maxVersion: string | undefined;
  let maxTag: string | undefined;
  for (const tag of tags) {
    const version = tag.slice(tag.lastIndexOf('@') + 1);
    if (!semver.valid(version)) {
      continue;
    }
    if (!maxVersion || semver.gt(version, maxVersion)) {
      maxVersion = version;
      maxTag = tag;
    }
  }
  return maxTag;
}

/**
 * A package is a "commit-leaf" if it has unreleased commits (i.e. appears in
 * `scanMap`) AND none of its direct workspace-local deps have unreleased
 * commits. These are the true sources of change — they trigger the entire
 * cascade, so they must be versioned + published first.
 *
 * Direct deps only (not transitive): the topo-ordered main loop handles
 * transitivity naturally by cascading dep-version rewrites forward.
 *
 * Returns leaves in topo order (deps-first) so independent leaves publish
 * in a deterministic, dependency-respecting sequence.
 */
function computeCommitLeaves(
  scanMap: Map<string, CommitBump>,
  packageGraph: any,
  sortedPackageNames: string[]
): string[] {
  const leaves: string[] = [];
  for (const packageName of sortedPackageNames) {
    if (!scanMap.has(packageName)) {
      continue;
    }
    const directDeps: string[] = packageGraph.successors(packageName) ?? [];
    const anyDepHasCommits = directDeps.some((dep) => scanMap.has(dep));
    if (!anyDepHasCommits) {
      leaves.push(packageName);
    }
  }
  return leaves;
}

type DependencyVersion = { prefix?: string; version: string; isLocalPath?: boolean };

function getDependencyVersion(
  dependencyPackageName: string,
  localPackage: LocalPackage
): DependencyVersion | undefined {
  let currentRawDependencyVersion = localPackage.packageJson.dependencies
    ? localPackage.packageJson.dependencies[dependencyPackageName]
    : undefined;
  if (!currentRawDependencyVersion) {
    currentRawDependencyVersion = localPackage.packageJson.devDependencies
      ? localPackage.packageJson.devDependencies[dependencyPackageName]
      : undefined;
  }

  if (!currentRawDependencyVersion) {
    return undefined;
  }

  if (currentRawDependencyVersion.startsWith('file:') || currentRawDependencyVersion.startsWith('.')) {
    return { version: currentRawDependencyVersion, isLocalPath: true };
  }

  const match = currentRawDependencyVersion.match(/^([~^]?)(\d+\.\d+\.\d+)/);
  return { prefix: match[1], version: match[2] };
}

function setDependencyVersion(
  dependencyPackageName: string,
  currentVersion: DependencyVersion,
  newVersion: DependencyVersion,
  localPackage: LocalPackage
) {
  const newRawVersion = newVersion.prefix ? newVersion.prefix + newVersion.version : newVersion.version;
  if (localPackage.packageJson.dependencies && localPackage.packageJson.dependencies[dependencyPackageName]) {
    localPackage.packageJson.dependencies[dependencyPackageName] = newRawVersion;
  } else {
    localPackage.packageJson.devDependencies[dependencyPackageName] = newRawVersion;
  }

  const currentRawVersion = currentVersion.prefix
    ? currentVersion.prefix + currentVersion.version
    : currentVersion.version;
  logger.info({
    message: `(${cw.color(localPackage.name)}) updating dependency version of ${cw.color(dependencyPackageName)} (${currentRawVersion} -> ${newRawVersion})`,
  });
}

async function syncFixedVersionWorkspaces(
  fixedVersionWorkspacePaths: string[],
  packageMap: LocalPackageMap,
  workspaceToPackageMap: { [workspacePath: string]: string[] },
  pushWithoutSync = false
) {
  if (fixedVersionWorkspacePaths.length == 0) {
    return;
  }

  logger.info({ message: `> Syncing fixed-version workspaces` });
  for (const workspacePath of fixedVersionWorkspacePaths) {
    const workspacePackages = workspaceToPackageMap[workspacePath]
      .filter((packageName) => packageName != 'typescript-parser')
      .map((packageName) => packageMap[packageName]);
    if (workspacePackages.length == 0) {
      continue;
    }

    let syncedVersion: string | false = false;
    if (!pushWithoutSync) {
      syncedVersion = await syncFixedVersions(workspacePath, workspacePackages);
      if (!syncedVersion) {
        continue;
      }
    }

    const skipTagging = pushWithoutSync;
    const skipCi = !pushWithoutSync;
    await pushAndTagFixedVersionRepo(workspacePath, syncedVersion, skipTagging, skipCi);
  }

  logger.info({ message: `> Synced fixed-version workspaces` });
}

/**
 * Plan-only companion to `syncFixedVersionWorkspaces`: for each fixed-version
 * workspace that would be touched, classify unpushed commits at the workspace
 * root and log the version it would sync to. No disk writes, no git ops.
 */
async function logPlannedFixedVersionSyncs(
  fixedVersionWorkspacePaths: string[],
  packageMap: LocalPackageMap,
  workspaceToPackageMap: { [workspacePath: string]: string[] }
) {
  if (fixedVersionWorkspacePaths.length === 0) {
    return;
  }
  logger.info({ message: `> Fixed-version workspaces that would sync:` });
  for (const workspacePath of fixedVersionWorkspacePaths) {
    const workspacePackageNames = workspaceToPackageMap[workspacePath] ?? [];
    const anyPackageInWs = workspacePackageNames.map((n) => packageMap[n]).find((p) => p?.workspace?.lernaJson);
    const lernaJson = anyPackageInWs?.workspace?.lernaJson;
    const repoName = path.basename(workspacePath.endsWith(path.sep) ? workspacePath.slice(0, -1) : workspacePath);
    if (!lernaJson) {
      logger.info({
        message: `  (${cw.color(repoName)}) would sync fixed-version workspace (lerna.json not available; bump level unknown)`,
      });
      continue;
    }
    // Mirror `syncFixedVersions`: classify commits at the workspace root;
    // fall back to 'patch' when there are no classifiable unpushed commits
    // (the sync was triggered purely by a sub-package's dep-version rewrite).
    const bump = (await classifyUnpushedCommits(workspacePath)) ?? 'patch';
    const wouldBeVersion = semver.inc(lernaJson.version, bump);
    logger.info({
      message: `  (${cw.color(repoName)}) would sync fixed-version workspace ${lernaJson.version} -> ${wouldBeVersion} (${bump})`,
    });
  }
}

async function syncFixedVersions(workspacePath: string, localPackages: LocalPackage[]): Promise<string | false> {
  const lernaJson = localPackages[0].workspace?.lernaJson;
  if (!lernaJson) {
    throw new Error(`Cannot find lerna.json for workspace: ${workspacePath}`);
  }

  // Fixed-version workspaces bump at the workspace-root level; use the
  // net-bump classifier so a `feat!`/`BREAKING CHANGE` in any sub-package
  // promotes the whole workspace to major. Fall back to patch when there
  // are no classifiable unpushed commits (i.e. nothing to publish, but we
  // were called because dep rewrites on a sub-package triggered the sync).
  const bump = (await classifyUnpushedCommits(workspacePath)) ?? 'patch';
  const highestVersion = semver.inc(lernaJson.version, bump);
  if (!highestVersion) {
    throw new Error(`Lerna version not specified for workspace: ${workspacePath}`);
  }

  let syncedFixedVersions = false;
  for (const localPackage of localPackages) {
    const currentVersion = localPackage.packageJson.version;
    if (currentVersion === highestVersion) {
      continue;
    }

    localPackage.packageJson.version = highestVersion;
    logger.info({
      message: `(${cw.color(localPackage.name)}) bumping version from ${currentVersion} -> ${localPackage.packageJson.version}`,
    });
    await Fs.writeFiles([{ path: localPackage.filePath, content: JSON.stringify(localPackage.packageJson, null, 2) }]);
    syncedFixedVersions = true;
  }

  if (syncedFixedVersions) {
    const lernaJsonPath = path.join(workspacePath, 'lerna.json');
    lernaJson.version = highestVersion;
    await Fs.writeFiles([{ path: lernaJsonPath, content: JSON.stringify(lernaJson, null, 2) }]);
  }

  return syncedFixedVersions ? highestVersion : false;
}

async function installWithRetry(localPackage: LocalPackage, packageDir: string, npmArgs: string[] = ['install']) {
  const maxRetries = 10;
  const retryDelayMs = 90_000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await cmd('npm', npmArgs, { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
      return;
    } catch (error: any) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      const isRegistryPropagationError =
        /No matching version found/i.test(output) || /ETARGET/i.test(output) || /404 Not Found/i.test(output);
      const isRetryable = isRegistryPropagationError || isNetworkError(error);
      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }
      const reason = isRegistryPropagationError ? 'dependency not yet available on registry' : 'network error';
      logger.info({
        message: `(${cw.color(localPackage.name)}) ${reason}, retrying install (attempt ${attempt}/${maxRetries}, next retry in ${retryDelayMs / 1000}s)`,
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

/**
 * CI-mode replacement for the per-package clean/install/build/test pipeline. The workflow
 * already installed, built, and tested the WHOLE workspace against this checkout before the
 * publish step — repeating that per package would double CI time without adding signal. What
 * the publish still needs is the lockfile to track the rewritten manifest (dependency ranges
 * bumped to registry-accepted versions; a stale lock pin that still satisfies a covering range
 * binds the next CI install to pre-release content — the lockfiles-bind-CI class), so
 * resolution is regenerated lock-only, with the same registry-propagation retry as the full
 * install (an upstream published moments earlier in this run may not be readable yet).
 */
async function ciPrepareForPublish(localPackage: LocalPackage) {
  const packageDir = path.dirname(localPackage.filePath);
  logger.info({ message: `(${cw.color(localPackage.name)}) regenerating lockfile resolution (CI publish mode)` });
  await installWithRetry(localPackage, packageDir, ['install', '--package-lock-only']);
}

async function buildAndTest(localPackage: LocalPackage) {
  const packageDir = path.dirname(localPackage.filePath);
  logger.info({ message: `(${cw.color(localPackage.name)}) cleaning package` });
  await cmd('npm', ['run', 'clean'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info({ message: `(${cw.color(localPackage.name)}) cleaned package` });
  logger.info({ message: `(${cw.color(localPackage.name)}) installing latest dependency versions` });
  await installWithRetry(localPackage, packageDir);
  logger.info({ message: `(${cw.color(localPackage.name)}) installed latest dependency versions` });
  if (hasLintConfig(localPackage)) {
    logger.info({ message: `Linting ${cw.color(localPackage.name)} (${packageDir})` });
    await cmd(
      'npx',
      ['prettier', localPackage.filePath, '--write'],
      { cwd: packageDir },
      { logPrefix: `[${cw.color(localPackage.name)}] ` }
    );
    await cmd(
      'npx',
      ['eslint', localPackage.filePath, '--fix'],
      { cwd: packageDir },
      { logPrefix: `[${cw.color(localPackage.name)}] ` }
    );
  }
  logger.info({ message: `(${cw.color(localPackage.name)}) building version ${localPackage.packageJson.version}` });
  await cmd('npm', ['run', 'build'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info({
    message: `(${cw.color(localPackage.name)}) built version ${localPackage.packageJson.version} (${packageDir})`,
  });
  if (localPackage.packageJson.scripts?.test) {
    logger.info({ message: `(${cw.color(localPackage.name)}) testing version ${localPackage.packageJson.version}` });
    await cmd('npm', ['run', 'test'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
    logger.info({ message: `(${cw.color(localPackage.name)}) tested version ${localPackage.packageJson.version}` });
  }
}

async function pull(localPackage: LocalPackage) {
  const packageDir = path.dirname(localPackage.filePath);
  logger.info({ message: `(${cw.color(localPackage.name)}) pulling latest changes` });
  await cmd('git', ['pull'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info({ message: `(${cw.color(localPackage.name)}) pulled latest changes` });
}

async function pushAndTag(localPackage: LocalPackage): Promise<void> {
  const dryRun = isDryRun();

  if (dryRun) {
    logger.info({
      message: `(${cw.color(localPackage.name)}) Dry run: skipping git add/commit/push/tag for version ${localPackage.packageJson.version}`,
    });
    return;
  }

  const packageDir = path.dirname(localPackage.filePath);
  logger.info({
    message: `(${cw.color(localPackage.name)}) pushing latest version (${localPackage.packageJson.version})`,
  });
  await cmd('git', ['add', '.'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  await cmd(
    'git',
    ['commit', '-m', `chore(version): bumping dependency versions for ${localPackage.name} [skip ci]`],
    { cwd: packageDir },
    { logPrefix: `[${cw.color(localPackage.name)}] ` }
  );
  await cmd('git', ['push'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info({
    message: `(${cw.color(localPackage.name)}) pushed latest version (${localPackage.packageJson.version})`,
  });
  const tagName = `${localPackage.name}@${localPackage.packageJson.version}`;
  logger.info({ message: `(${cw.color(localPackage.name)}) pushing tag (${tagName})` });
  await cmd(
    'git',
    ['tag', '-a', tagName, '-m', `Release ${tagName}`],
    { cwd: packageDir },
    { logPrefix: `[${cw.color(localPackage.name)}] ` }
  );
  await cmd(
    'git',
    ['push', 'origin', tagName],
    { cwd: packageDir },
    { logPrefix: `[${cw.color(localPackage.name)}] ` }
  );
  logger.info({ message: `(${cw.color(localPackage.name)}) pushed tag (${tagName})` });
}

async function pushAndTagFixedVersionRepo(
  dir: string,
  version: string | false,
  skipTagging = false,
  skipCi = true
): Promise<void> {
  const dryRun = isDryRun();

  if (dryRun) {
    const repoName = path.basename(dir.endsWith(path.sep) ? dir.slice(0, -1) : dir);
    logger.info({
      message: `(${cw.color(repoName)}) Dry run: skipping git add/commit/push${version ? ` for version ${version}` : ''}`,
    });
    return;
  }

  const repoName = path.basename(dir.endsWith(path.sep) ? dir.slice(0, -1) : dir);
  // Same guard as pushMetarepo: if nothing is pending, `git commit` exits 1
  // and kills the run. Skip commit/push in that case; fall through to the
  // tagging block below so that if the caller still wanted a tag (which is
  // orthogonal to whether there were file changes) it still happens.
  if (!(await hasPendingChanges(dir))) {
    logger.info({ message: `(${cw.color(repoName)}) fixed-version repo has no pending changes, skipping commit/push` });
  } else {
    if (version) {
      logger.info({ message: `(${cw.color(repoName)}) pushing latest version (${version})` });
    } else {
      logger.info({ message: `(${cw.color(repoName)}) pushing dependency bumps` });
    }
    await cmd('git', ['add', '.'], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
    await cmd(
      'git',
      ['commit', '-m', `chore(version): bumping dependency versions${skipCi ? ' [skip ci]' : ''}`],
      { cwd: dir },
      { logPrefix: `[${cw.color(repoName)}] ` }
    );
    await cmd('git', ['push'], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
    if (version) {
      logger.info({ message: `(${cw.color(repoName)}) pushed latest version (${version})` });
    } else {
      logger.info({ message: `(${cw.color(repoName)}) pushed dependency bumps` });
    }
  }
  if (!skipTagging) {
    const tagName = `v${version}`;
    logger.info({ message: `(${cw.color(repoName)}) pushing tag (${tagName})` });
    await cmd(
      'git',
      ['tag', '-a', tagName, '-m', `Release ${tagName}`],
      { cwd: dir },
      { logPrefix: `[${cw.color(repoName)}] ` }
    );
    await cmd('git', ['push', 'origin', tagName], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
    logger.info({ message: `(${cw.color(repoName)}) pushed tag (${tagName})` });
  }
}

async function pushMetarepos(dir: string, skipRootRepo = false) {
  const metarepoPaths = (await Fs.getFilePathsMatchingGlob(dir, '**/.gitmodules', ['**/node_modules/**', '**/dist/**']))
    .map((gitmodulesPath) => path.dirname(gitmodulesPath))
    .sort((a, b) => b.localeCompare(a));
  for (const metarepoPath of metarepoPaths) {
    if (skipRootRepo && path.resolve(metarepoPath) === path.resolve(dir)) {
      const repoName = path.basename(metarepoPath);
      logger.info({ message: `(${cw.color(repoName)}) skipping dirty workspace root repo` });
      continue;
    }
    await pushMetarepo(metarepoPath);
  }
}

async function pushMetarepo(dir: string) {
  const dryRun = isDryRun();

  if (dryRun) {
    const repoName = path.basename(dir.endsWith(path.sep) ? dir.slice(0, -1) : dir);
    logger.info({
      message: `(${cw.color(repoName)}) Dry run: skipping metarepo commit/push for ${dir}`,
    });
    return;
  }

  const repoName = path.basename(dir.endsWith(path.sep) ? dir.slice(0, -1) : dir);
  // Nothing to commit means `git commit` would exit 1 and blow up the whole
  // run. This happens routinely — e.g. the proteinjs metarepo has no pending
  // submodule pointer bumps on a run that only touched unrelated packages.
  // Silently skip those repos instead of aborting.
  if (!(await hasPendingChanges(dir))) {
    logger.info({ message: `(${cw.color(repoName)}) metarepo has no pending changes, skipping commit/push` });
    return;
  }
  logger.info({ message: `(${cw.color(repoName)}) pushing metarepo (${dir})` });
  await cmd('git', ['add', '.'], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  await cmd(
    'git',
    ['commit', '-m', `chore(version): bumping submodule versions [skip ci]`],
    { cwd: dir },
    { logPrefix: `[${cw.color(repoName)}] ` }
  );
  await cmd('git', ['pull'], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  await cmd('git', ['push'], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  logger.info({ message: `(${cw.color(repoName)}) pushed metarepo (${dir})` });
}

async function symlinkWorkspace(workspacePath: string, packageNames: string[], packageMap: LocalPackageMap) {
  logger.info({ message: `> Symlinking local dependencies in workspace (${workspacePath})` });
  for (const packageName of packageNames) {
    const localPackage = packageMap[packageName];
    await PackageUtil.symlinkDependencies(localPackage, packageMap);
  }

  logger.info({ message: `> Symlinked local dependencies in workspace (${workspacePath})` });
}

async function publish(localPackage: LocalPackage, registry: PackageRegistry) {
  const dryRun = isDryRun();
  const target = localPackage.packageJson.version;
  if (dryRun) {
    logger.info({
      message: `(${cw.color(localPackage.name)}) Dry run: would publish version ${target}`,
    });
    return;
  }

  // Every path out of this function feeds `acceptedVersions` — enforce the release
  // invariant on the freshly read registry state before ANY of them can record `target`.
  const publishedBefore = await registry.getPublishedVersions(localPackage);
  assertReleaseExceedsRegistryMax(localPackage.name, target, publishedBefore);

  // RESUME WINDOW: the computed target can already be on the registry — a prior attempt was
  // accepted but the response was lost, or a run died between acceptance and the durable
  // record. Acceptance is what matters; re-publishing the same version can only collide.
  // Skip straight to recording. The assert above scopes this window to a genuinely
  // this-run target (one that exceeds every OTHER published version): a pre-existing OLD
  // own version at-or-below the registry max is history, never a resume.
  if (publishedBefore.includes(target)) {
    logger.info({
      message: `(${cw.color(localPackage.name)}) ${target} is already on the registry — resuming: skipping publish, recording only`,
    });
    return;
  }

  try {
    await registry.publish(localPackage);
  } catch (error) {
    // The registry can accept a publish while the client sees an error (lost response,
    // timeout mid-upload). The registry is the authority, not the exit code: if the target
    // landed, the publish succeeded — continue to the durable record.
    const publishedAfter = await registry.getPublishedVersions(localPackage).catch(() => undefined);
    if (publishedAfter && publishedAfter.includes(target)) {
      // This exit records `target` too, so it enforces the invariant on ITS OWN read. The
      // assert at the top of this function is only as good as the pre-check read behind it:
      // if that read was also stale (empty list — the authenticated-404 shape), it was
      // vacuous, the publish of an old own version failed as a conflict, and this re-check
      // is the first read to see registry truth. Membership alone would launder the shadow;
      // the assert makes acceptance mean "this run's release", not "this version exists".
      assertReleaseExceedsRegistryMax(localPackage.name, target, publishedAfter);
      logger.info({
        message: `(${cw.color(localPackage.name)}) publish reported an error but the registry accepted ${target} — continuing to record`,
      });
      return;
    }
    throw error;
  }
}

/**
 * INVARIANT: a release this run always EXCEEDS the registry max at compute time. Enforced at
 * the one boundary where a computed target becomes a recorded release (`publish` — its every
 * exit feeds `acceptedVersions`, which dependent ranges are rewritten from): `target` must be
 * strictly greater than every published version other than itself.
 *
 * Targets are computed as bump(registry max), so a violation here means the baseline read
 * was stale or wrong (an empty or partial version list — e.g. a transient authenticated 404
 * reading as "never published"). Recording anyway would create a SHADOWED release: an
 * at-or-below-max version whose dependents' caret ranges semver-resolve to another lineage's
 * content (2026-08-12 train: chat-common 1.22.1 recorded under a sibling's 1.24.0 —
 * dependents installed the sibling's pre-ops content and their builds died on missing
 * exports). The resume window and the publish-error acceptance check would otherwise LAUNDER
 * exactly that shape: the old own version is on the registry, so membership alone reads as
 * "this run's publish landed earlier". Fail loudly instead — the re-run recomputes from a
 * fresh baseline.
 */
function assertReleaseExceedsRegistryMax(packageName: string, target: string, publishedVersions: string[]) {
  const othersMax = maxPublishedVersion(publishedVersions.filter((version) => version !== target));
  if (othersMax && !semver.gt(target, othersMax)) {
    throw new Error(
      `(${packageName}) computed release target ${target} does not exceed the registry max ${othersMax} — ` +
        `refusing to record a shadowed release. The baseline this target was computed from does not match ` +
        `the registry's current version list; re-run to recompute from a fresh baseline.`
    );
  }
}

/**
 * Undo the transient writes of an in-flight version attempt for one package: restore
 * package.json and package-lock.json to their committed (HEAD) state. Only tracked files are
 * restored — an untracked lockfile has no committed truth to restore, and untracked files are
 * never versioning residue (the flow only rewrites files that are already committed).
 */
async function revertTransientVersionWrites(localPackage: LocalPackage) {
  const packageDir = path.dirname(localPackage.filePath);
  const tracked = (
    await cmd(
      'git',
      ['ls-files', '--', 'package.json', 'package-lock.json'],
      { cwd: packageDir },
      { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }
    )
  ).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (tracked.length === 0) {
    return;
  }
  await cmd(
    'git',
    ['checkout', 'HEAD', '--', ...tracked],
    { cwd: packageDir },
    { logPrefix: `[${cw.color(localPackage.name)}] ` }
  );
  logger.info({
    message: `(${cw.color(localPackage.name)}) reverted transient version writes (${tracked.join(', ')})`,
  });
}

/**
 * Whether the package publishes to a registry at all. `quiet` suppresses the skip-reason
 * logs for callers that only need the predicate (e.g. the phase-0 scan, which probes every
 * candidate package every run).
 */
function shouldPublishPackage(localPackage: LocalPackage, { quiet = false }: { quiet?: boolean } = {}) {
  if (localPackage.packageJson.private) {
    return false;
  }

  const publishConfig = localPackage.packageJson.publishConfig;
  if (!publishConfig) {
    if (!quiet) {
      logger.info({
        message: `(${cw.color(localPackage.name)}) skipping publish – package missing publishConfig`,
      });
    }
    return false;
  }

  const hasAccess = typeof publishConfig.access === 'string' && publishConfig.access.length > 0;
  const hasRegistry = typeof publishConfig.registry === 'string' && publishConfig.registry.length > 0;
  if (!hasAccess && !hasRegistry) {
    if (!quiet) {
      logger.info({
        message: `(${cw.color(localPackage.name)}) skipping publish – publishConfig requires an access or registry value`,
      });
    }
    return false;
  }

  return true;
}

async function getCurrentBranch(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec('git rev-parse --abbrev-ref HEAD', { cwd: dir }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function isRepoDirty(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec('git diff --ignore-submodules HEAD', { cwd: dir }, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(stdout.trim().length > 0);
    });
  });
}

/**
 * True iff there is anything staged or unstaged that a `git commit` would
 * capture. Used to guard commit/push steps in the metarepo and fixed-version
 * flows — without this, a repo with no pending changes (e.g. a parent
 * metarepo whose submodule pointers were already bumped in a prior run, or
 * the proteinjs metarepo on a run that only bumped unrelated packages) will
 * fail `git commit` with "nothing to commit, working tree clean" and the
 * entire version-workspace run throws.
 */
async function hasPendingChanges(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec('git status --porcelain', { cwd: dir }, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(stdout.trim().length > 0);
    });
  });
}

export type CommitBump = 'major' | 'minor' | 'patch';

const BUMP_ORDER: Record<CommitBump, number> = { patch: 1, minor: 2, major: 3 };

function maxBump(a: CommitBump | undefined, b: CommitBump | undefined): CommitBump | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return BUMP_ORDER[a] >= BUMP_ORDER[b] ? a : b;
}

/**
 * Classify the net semver bump implied by the set of commits in HEAD that
 * aren't yet on the tracked upstream branch (`git log @{u}..HEAD`).
 *
 *   - `major`: any commit declares a breaking change — either the
 *              conventional-commits `!` marker on the header (`feat!:`,
 *              `fix(scope)!:`, etc.) or a `BREAKING CHANGE:` footer.
 *   - `minor`: any commit is a `feat` (type, optionally scoped, no `!`).
 *   - `patch`: any other commit is present (fix/chore/refactor/docs/…).
 *   - `undefined`: no unpushed commits, OR no tracked upstream (the `@{u}`
 *                  shorthand errors silently — treated as "nothing to ship").
 *
 * Uses `%B` (full body) separated by a null byte so footer-style
 * `BREAKING CHANGE:` lines are visible. Shells out to `git` directly so we
 * don't depend on any repo state beyond a valid upstream ref.
 */
export async function classifyUnpushedCommits(dir: string): Promise<CommitBump | undefined> {
  return classifyCommitRange(dir, '@{u}..HEAD');
}

/**
 * Classify the net semver bump of the commits in `range` (optionally path-filtered relative
 * to `dir`) by conventional-commits rules. `undefined` when the range is empty or cannot be
 * resolved (missing upstream, unknown ref — treated as "nothing to ship").
 */
async function classifyCommitRange(dir: string, range: string, pathFilter?: string): Promise<CommitBump | undefined> {
  return new Promise((resolve) => {
    // `\x00` as record separator; each record is the full commit message body.
    //
    // `--full-history` (only meaningful with a pathspec): default history simplification
    // follows a single TREESAME parent through merges, which can prune an entire side
    // branch's commits from the listing. For change detection the safe bias is to KEEP
    // every commit touching the path — over-listing at worst releases a version whose
    // content matches the registry max (harmless), while under-listing recreates the
    // shadowed-release dead end this scan exists to close.
    const pathArgs = pathFilter ? ` --full-history -- ${pathFilter}` : '';
    exec(`git log '${range}' --format=%B%x00${pathArgs}`, { cwd: dir }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(undefined);
        return;
      }
      const commits = stdout
        .split('\x00')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      let result: CommitBump | undefined;
      for (const commit of commits) {
        result = maxBump(result, classifyCommitMessage(commit));
        if (result === 'major') {
          break;
        }
      }
      resolve(result);
    });
  });
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`git rev-parse --verify --quiet '${ref}'`, { cwd: dir }, (error) => resolve(!error));
  });
}

/**
 * Classify a single commit message by conventional-commits rules. Exported
 * so unit tests can exercise it without spawning git.
 *
 * Every signal is positional, never "appears somewhere in the text":
 *   - the `!` marker and the `feat` type are read off the header (first line)
 *     only, so prose in the body can't change the bump;
 *   - `BREAKING CHANGE:` counts only as a footer — at the start of a line, at
 *     column 0, outside code (see `declaresBreakingChange`).
 * Without that, a commit that merely *documents* these rules declares a
 * breaking change against itself (this repo's 0cd9b2b did, shipping a bogus
 * 1.9.2 -> 2.0.0).
 */
export function classifyCommitMessage(message: string): CommitBump | undefined {
  if (!message.trim()) {
    return undefined;
  }
  const header = message.split('\n')[0];

  // Breaking change: `type!:` / `type(scope)!:` on the header, or a footer.
  if (/^\w+(\([^)]*\))?!:/.test(header) || declaresBreakingChange(message)) {
    return 'major';
  }

  // `feat` type (optionally scoped) on the header → minor.
  if (/^feat(\([^)]*\))?:/i.test(header)) {
    return 'minor';
  }

  // Any other commit counts as patch.
  return 'patch';
}

/**
 * True when the message carries a `BREAKING CHANGE:` / `BREAKING-CHANGE:`
 * footer. Per the spec a footer token begins its own line at column 0, so
 * that's what we require. That one rule covers prose (the token is mid-line),
 * list items and quotes (indented), and inline-backticked mentions (the line
 * starts with a backtick) — only fenced blocks, which can hold a verbatim
 * sample commit at column 0, need to be skipped explicitly.
 *
 * We deliberately do NOT also require a blank line above the token: plenty of
 * real commits append the footer directly under the body, and a line that
 * starts with the token is a declaration either way. The blank line would only
 * cost us true positives, not buy us protection from false ones.
 */
function declaresBreakingChange(message: string): boolean {
  let inCodeFence = false;
  for (const line of message.split('\n')) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (!inCodeFence && /^BREAKING[ -]CHANGE\s*:/i.test(line)) {
      return true;
    }
  }
  return false;
}

export async function evictGitLocks(workspacePath: string) {
  // `.git` is a DIRECTORY only for a standalone checkout; a submodule's `.git` is a pointer
  // FILE ("gitdir: <path>") — globbing into it throws ENOTDIR (2026-08-08 train: the nested
  // proteinjs workspace inside the n3xa metarepo). Resolve the pointer; skip when absent.
  const gitPath = path.join(workspacePath, '.git');
  let gitDir = gitPath;
  try {
    const fsp = await import('fs/promises');
    const stat = await fsp.stat(gitPath);
    if (!stat.isDirectory()) {
      const pointer = await fsp.readFile(gitPath, 'utf-8');
      const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
      if (!match) {
        return;
      }
      gitDir = path.resolve(workspacePath, match[1].trim());
    }
  } catch {
    return; // no .git at all — nothing to evict
  }
  const lockFiles = await Fs.getFilePathsMatchingGlob(gitDir, '**/*.lock');
  if (lockFiles.length === 0) {
    return;
  }

  logger.info({ message: `> Evicting ${lockFiles.length} git lock file(s) from workspace` });
  await Fs.deleteFiles(lockFiles);
  logger.info({ message: `> Evicted git lock files` });
}
