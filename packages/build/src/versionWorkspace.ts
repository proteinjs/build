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
  const seams: VersionWorkspaceSeams = {
    registry: options.seams?.registry ?? new NpmPackageRegistry(),
    buildAndTest: options.seams?.buildAndTest ?? buildAndTest,
  };
  const dryRun = isDryRun();
  const planOnly = isPlanOnly();

  if (planOnly) {
    logger.info({
      message:
        'Plan-only mode enabled. Scan + commit-leaves + would-be bumps will be computed and logged; nothing will be written to disk, built, tested, published, committed, or pushed.',
    });
  } else if (dryRun) {
    logger.info({ message: 'Dry run mode enabled. Publish and push operations will be skipped.' });
  }
  const workspacePath = options.workspacePath ?? process.cwd();
  await evictGitLocks(workspacePath);

  // Opt-in pre-phase: merge feature-branch work into main per leaf repo before versioning (see
  // mergeToMain.ts). Default (no flag) is unchanged: version in place on each repo's current
  // branch. Repos this phase touches are left ON MAIN; feature branches are never modified.
  const mergeSpec = parseMergeToMainSpec(process.argv.slice(2), process.env.VERSION_WORKSPACE_MERGE_TO_MAIN);
  await mergeToMain(workspacePath, mergeSpec, planOnly);

  // Release-flow idempotency sweep: after clean merges, uncommitted package.json/lock can only be
  // crash residue from a prior interrupted versioning run (in-run failures revert their own
  // transient writes). Restore committed truth before the loop reads disk state — the re-run then
  // recomputes every bump from its registry baseline, healing the interruption without operator
  // surgery. Release mode = --merge-to-main; skip in preview/dry modes (which legitimately leave
  // writes).
  if (mergeSpec.enabled && !planOnly && !dryRun) {
    await revertLeftoverVersionState(workspacePath);
  }

  const workspaceRootDirty = await isRepoDirty(workspacePath);
  if (workspaceRootDirty) {
    logger.info({ message: `> Workspace root is dirty, will skip pull/push for root repo` });
  }
  if (dryRun || planOnly) {
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

  // Phase 0: scan every candidate package's unpushed commits up front. This
  // gives us a map of packages that have their own local changes to ship,
  // separate from the traditional "dependency bumped, cascade" trigger.
  const commitBumps = await scanCommitBumps(filteredPackageNames, packageMap);
  if (commitBumps.size === 0) {
    logger.info({ message: `> No packages have unpushed commits` });
  } else {
    const scanSummary = Array.from(commitBumps.entries())
      .map(([name, bump]) => `${cw.color(name)}:${bump}`)
      .join(', ');
    logger.info({ message: `> Packages with unpushed commits: ${scanSummary}` });
  }

  // Phase 1: identify commit-leaves — packages with unpushed commits whose
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
  // signals: own unpushed commits (from `commitBumps`) and dep-version
  // rewrites (from `applyDependencyVersionRewrites`). A package publishes
  // iff either signal fires. The effective bump is the max of (own-commit
  // bump) and (cascade → 'patch'). Topo order (deps-first) ensures leaves
  // publish before dependents that need to consume their new versions, and
  // any non-leaf commit-haver still gets its own-commit bump respected
  // rather than being demoted to 'patch' by the cascade.
  //
  // Versions this run saw the registry accept (or would accept, in plan/dry preview modes),
  // by package name. This — not in-memory package.json state — is what dependent ranges are
  // rewritten from: a range only ever points at a version that verifiably exists on the
  // registry (topo order guarantees the upstream entry lands before dependents read it).
  const acceptedVersions = new Map<string, string>();
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const skipBumpingPackageVersion = isInFixedVersionWorkspace(localPackage);
    const ownBump = skipBumpingPackageVersion ? undefined : commitBumps.get(packageName);
    const dependenciesChanged = await applyDependencyVersionRewrites(
      localPackage,
      packageMap,
      packageGraph,
      userSkippedPackages,
      acceptedVersions
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
 * Rewrite `localPackage`'s dependency-version fields in package.json to match the versions
 * its workspace-local deps had ACCEPTED BY THE REGISTRY this run (`acceptedVersions` — topo
 * order guarantees an upstream's acceptance lands before its dependents are processed).
 * Returns true if any dep version was rewritten.
 *
 * Ranges are rewritten from accepted versions ONLY — never from a dep's on-disk package.json.
 * A local record is not proof of a publishable version: rewriting a dependent to a
 * bumped-but-never-published dep version strands it on an uninstallable range (`npm install`
 * retries ETARGET for minutes before dying). A dep that didn't release this run keeps the
 * dependent's recorded range, which was itself written from an accepted version when the dep
 * last released.
 *
 * Pure rewrite — does NOT bump `localPackage`'s own version; the caller decides that by
 * combining this result with the commit-scan map (see `versionWorkspace`). Writing the
 * package.json to disk is left to the caller too, so we can apply the own-version bump in
 * the same write.
 */
async function applyDependencyVersionRewrites(
  localPackage: LocalPackage,
  packageMap: LocalPackageMap,
  packageGraph: any,
  userSkippedPackages: Set<string>,
  acceptedVersions: Map<string, string>
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

    const acceptedVersion = acceptedVersions.get(localDependency);
    if (!acceptedVersion) {
      const onDiskVersion = localDependencyPackage.packageJson.version as string;
      if (currentDependencyVersion.version !== onDiskVersion) {
        logger.info({
          message: `(${cw.color(localPackage.name)}) leaving dependency version of ${cw.color(localDependency)} at ${currentDependencyVersion.prefix ?? ''}${currentDependencyVersion.version} (its local record ${onDiskVersion} did not release this run; ranges only track registry-accepted versions)`,
        });
      }
      continue;
    }

    if (currentDependencyVersion.version == acceptedVersion) {
      continue;
    }

    const newDependencyVersion: DependencyVersion = {
      prefix: currentDependencyVersion.prefix,
      version: acceptedVersion,
    };
    setDependencyVersion(localDependency, currentDependencyVersion, newDependencyVersion, localPackage);
    dependenciesChanged = true;
  }

  return dependenciesChanged;
}

/**
 * Up-front scan: for each candidate package, classify the unpushed commits
 * in its own git repo into a semver bump level. Returns a map (only contains
 * entries for packages with classifiable unpushed commits). Packages with no
 * unpushed commits or missing upstream branches are absent from the map.
 *
 * This is the input to `computeCommitLeaves` and to the per-package bump-level
 * combine in the main loop.
 */
async function scanCommitBumps(packageNames: string[], packageMap: LocalPackageMap): Promise<Map<string, CommitBump>> {
  const result = new Map<string, CommitBump>();
  for (const packageName of packageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    const bump = await classifyUnpushedCommits(packageDir);
    if (bump) {
      result.set(packageName, bump);
    }
  }
  return result;
}

/**
 * A package is a "commit-leaf" if it has unpushed commits (i.e. appears in
 * `scanMap`) AND none of its direct workspace-local deps have unpushed
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

async function installWithRetry(localPackage: LocalPackage, packageDir: string) {
  const maxRetries = 10;
  const retryDelayMs = 90_000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await cmd('npm', ['install'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
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

  // RESUME WINDOW: the computed target can already be on the registry — a prior attempt was
  // accepted but the response was lost, or a run died between acceptance and the durable
  // record. Acceptance is what matters; re-publishing the same version can only collide.
  // Skip straight to recording.
  const publishedBefore = await registry.getPublishedVersions(localPackage);
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
      logger.info({
        message: `(${cw.color(localPackage.name)}) publish reported an error but the registry accepted ${target} — continuing to record`,
      });
      return;
    }
    throw error;
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

function shouldPublishPackage(localPackage: LocalPackage) {
  if (localPackage.packageJson.private) {
    return false;
  }

  const publishConfig = localPackage.packageJson.publishConfig;
  if (!publishConfig) {
    logger.info({
      message: `(${cw.color(localPackage.name)}) skipping publish – package missing publishConfig`,
    });
    return false;
  }

  const hasAccess = typeof publishConfig.access === 'string' && publishConfig.access.length > 0;
  const hasRegistry = typeof publishConfig.registry === 'string' && publishConfig.registry.length > 0;
  if (!hasAccess && !hasRegistry) {
    logger.info({
      message: `(${cw.color(localPackage.name)}) skipping publish – publishConfig requires an access or registry value`,
    });
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
  return new Promise((resolve) => {
    // `\x00` as record separator; each record is the full commit message body.
    exec('git log @{u}..HEAD --format=%B%x00', { cwd: dir }, (error, stdout) => {
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
