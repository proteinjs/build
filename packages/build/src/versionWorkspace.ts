import * as path from 'path';
import { exec } from 'child_process';
import { LocalPackage, LocalPackageMap, PackageUtil, cmd, Fs, LogColorWrapper } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import semver from 'semver';
import { Commit } from './Github';
import { primaryLogColor, secondaryLogColor } from './logColors';
import { hasLintConfig } from './lintWorkspace';

const cw = new LogColorWrapper();
const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('version', secondaryLogColor) });
const fixedVersionWorkspacesToVersion: { [workspacePath: string]: boolean } = {};

export async function versionWorkspace() {
  const dryRun = isDryRun();

  if (dryRun) {
    logger.info({ message: 'Dry run mode enabled. Publish and push operations will be skipped.' });
  }
  const workspacePath = process.cwd();
  await evictGitLocks(workspacePath);
  const workspaceRootDirty = await isRepoDirty(workspacePath);
  if (workspaceRootDirty) {
    logger.info({ message: `> Workspace root is dirty, will skip pull/push for root repo` });
  }
  if (dryRun) {
    logger.info({ message: `> Dry run: skipping pullWorkspace for (${workspacePath})` });
  } else {
    await pullWorkspace(workspacePath, workspaceRootDirty);
  }

  const { packageMap, packageGraph, sortedPackageNames, workspaceToPackageMap } =
    await PackageUtil.getWorkspaceMetadata(workspacePath);
  const skippedPackages = ['root', 'typescript-parser'];
  const filteredPackageNames = sortedPackageNames.filter((packageName) => {
    const localPackage = packageMap[packageName];
    return (
      !!localPackage.packageJson.scripts?.clean &&
      !!localPackage.packageJson.scripts?.build &&
      !skippedPackages.includes(packageName)
    );
  });

  logger.info({ message: `> Versioning workspace (${workspacePath})` });
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const skipBumpingPackageVersion = isInFixedVersionWorkspace(localPackage);
    const dependenciesChanged = await bumpDependencies(
      localPackage,
      packageMap,
      packageGraph,
      skipBumpingPackageVersion
    );
    if (!dependenciesChanged) {
      continue;
    }

    await buildAndTest(localPackage);
    if (isInFixedVersionWorkspace(localPackage) && localPackage.workspace) {
      fixedVersionWorkspacesToVersion[localPackage.workspace.path] = true;
      logger.info({
        message: `(${cw.color(packageName)}) skipping version push for package in a fixed-version workspace`,
      });
      continue;
    }

    if (shouldPublishPackage(localPackage)) {
      await publish(localPackage);
    }

    await pushAndTag(localPackage);
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
    await cmd('git', ['rebase', `origin/${branch}`], { cwd: repoRoot }, { logPrefix: `[${cw.color(repoName)}] ` });
    logger.info({ message: `(${cw.color(repoName)}) pulled latest changes` });
  }

  logger.info({ message: `> Finished pulling workspace (${workspacePath})` });
}

async function bumpDependencies(
  localPackage: LocalPackage,
  packageMap: LocalPackageMap,
  packageGraph: any,
  skipBumpingPackageVersion = false
) {
  const localDependencies = packageGraph.successors(localPackage.name);
  if (!localDependencies || localDependencies.length == 0) {
    return false;
  }

  let dependenciesChanged = false;
  for (const localDependency of localDependencies) {
    const localDependencyPackage = packageMap[localDependency];
    const localDependencyVersion = localDependencyPackage.packageJson.version as string;
    const currentDependencyVersion = getDependencyVersion(localDependency, localPackage);
    if (!currentDependencyVersion) {
      throw new Error(
        `Package (${cw.color(localPackage.name)}) has dependency on ${localDependency}, but cannot find version in ${cw.color(localPackage.name)}'s package.json`
      );
    }

    if (currentDependencyVersion.isLocalPath) {
      continue;
    }

    if (currentDependencyVersion?.version == localDependencyVersion) {
      continue;
    }

    const newDependencyVersion: DependencyVersion = {
      prefix: currentDependencyVersion.prefix,
      version: localDependencyVersion,
    };
    setDependencyVersion(localDependency, currentDependencyVersion, newDependencyVersion, localPackage);
    dependenciesChanged = true;
  }

  if (dependenciesChanged) {
    if (!skipBumpingPackageVersion) {
      const currentVersion = localPackage.packageJson.version;
      const packageDir = path.dirname(localPackage.filePath);
      const bump = (await hasFeatureCommits(packageDir)) ? 'minor' : 'patch';
      localPackage.packageJson.version = semver.inc(currentVersion, bump);
      logger.info({
        message: `(${cw.color(localPackage.name)}) bumping version (${bump}) from ${currentVersion} -> ${localPackage.packageJson.version}`,
      });
    }
    await Fs.writeFiles([{ path: localPackage.filePath, content: JSON.stringify(localPackage.packageJson, null, 2) }]);
  }

  return dependenciesChanged;
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

async function syncFixedVersions(workspacePath: string, localPackages: LocalPackage[]): Promise<string | false> {
  const lernaJson = localPackages[0].workspace?.lernaJson;
  if (!lernaJson) {
    throw new Error(`Cannot find lerna.json for workspace: ${workspacePath}`);
  }

  const bump = (await hasFeatureCommits(workspacePath)) ? 'minor' : 'patch';
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

async function pushAndTag(localPackage: LocalPackage): Promise<Commit | undefined> {
  const dryRun = isDryRun();

  if (dryRun) {
    logger.info({
      message: `(${cw.color(localPackage.name)}) Dry run: skipping git add/commit/push/tag for version ${localPackage.packageJson.version}`,
    });
    return undefined;
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
  const latestCommitSha = await getLatestCommitSha(packageDir);
  const repoInfo = await getRepoInfo(packageDir);
  const commit = { sha: latestCommitSha, ...repoInfo };
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
  return commit;
}

async function pushAndTagFixedVersionRepo(
  dir: string,
  version: string | false,
  skipTagging = false,
  skipCi = true
): Promise<Commit | undefined> {
  const dryRun = isDryRun();

  if (dryRun) {
    const repoName = path.basename(dir.endsWith(path.sep) ? dir.slice(0, -1) : dir);
    logger.info({
      message: `(${cw.color(repoName)}) Dry run: skipping git add/commit/push${version ? ` for version ${version}` : ''}`,
    });
    return undefined;
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
  const latestCommitSha = await getLatestCommitSha(dir);
  const repoInfo = await getRepoInfo(dir);
  const commit = { sha: latestCommitSha, ...repoInfo };
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

  return commit;
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

async function getLatestCommitSha(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec('git rev-parse HEAD', { cwd: dir }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

type RepoInfo = {
  owner: string;
  repo: string;
};

async function getRepoInfo(dir: string): Promise<RepoInfo> {
  return new Promise((resolve, reject) => {
    exec('git remote -v', { cwd: dir }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.startsWith('origin')) {
          // eslint-disable-next-line no-useless-escape
          const match = line.match(/github\.com[:\/](.+?)\/(.+?)\.git/);
          if (match) {
            const [_, owner, repo] = match;
            resolve({ owner, repo });
            return;
          }
        }
      }

      reject(new Error('Origin remote not found or is not a GitHub repository'));
    });
  });
}

async function publish(localPackage: LocalPackage) {
  const dryRun = isDryRun();
  if (localPackage.packageJson.private) {
    logger.info({ message: `Preventing publish of private package: ${cw.color(localPackage.name)}` });
    return;
  }

  const publishConfig = localPackage.packageJson.publishConfig ?? {};
  const registry = getPublishRegistry(publishConfig); // uses publishConfig.registry or falls back to npmjs
  const tag = publishConfig.tag ?? 'latest';
  const access = publishConfig.access;
  const packageDir = path.dirname(localPackage.filePath);

  await assertRegistryAuth(registry, localPackage);
  if (dryRun) {
    logger.info({
      message: `(${cw.color(localPackage.name)}) Dry run: would publish version ${localPackage.packageJson.version}`,
    });
    return;
  }

  logger.info({
    message: `(${cw.color(localPackage.name)}) publishing latest version (${localPackage.packageJson.version}) [registry=${registry}]`,
  });

  // Use publishConfig as the source of truth
  const args = ['publish', '--tag', tag, ...(await npmUserconfigArgs(packageDir))];
  // Only include --access when publishing to the public npm registry
  try {
    const host = new URL(registry).hostname;
    if (host.endsWith('npmjs.org') && access) {
      args.push('--access', access);
    }
  } catch {
    /* ignore malformed URL */
  }

  await retryOnNetworkError(
    () => cmd('npm', args, { cwd: packageDir, env: { ...process.env } }, { logPrefix: `[${cw.color(localPackage.name)}] ` }),
    localPackage.name,
    3,
    15_000
  );

  logger.info({ message: `(${cw.color(localPackage.name)}) published ${localPackage.packageJson.version}` });
}

const registryAuthCheckCache: { [registry: string]: boolean } = {};

async function npmUserconfigArgs(packageDir: string): Promise<string[]> {
  const rc = path.join(packageDir, '.npmrc');
  return (await Fs.exists(rc)) ? ['--userconfig', rc] : [];
}

async function assertRegistryAuth(registry: string, localPackage: LocalPackage) {
  if (!registry || registryAuthCheckCache[registry]) {
    return;
  }
  const packageDir = path.dirname(localPackage.filePath);
  await cmd(
    'npm',
    ['whoami', '--registry', registry, ...(await npmUserconfigArgs(packageDir))],
    { cwd: packageDir, env: { ...process.env } },
    { logPrefix: `[${cw.color(localPackage.name)}] ` }
  );
  registryAuthCheckCache[registry] = true;
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

function getPublishRegistry(publishConfig: { registry?: string }) {
  if (publishConfig.registry) {
    return publishConfig.registry;
  }

  return 'https://registry.npmjs.org/';
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

async function hasFeatureCommits(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec('git log @{u}..HEAD --oneline', { cwd: dir }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(false);
        return;
      }
      const hasFeature = stdout.split('\n').some((line) => /^[a-f0-9]+\s+feat[\s(:]/i.test(line));
      resolve(hasFeature);
    });
  });
}

export async function evictGitLocks(workspacePath: string) {
  const gitDir = path.join(workspacePath, '.git');
  const lockFiles = await Fs.getFilePathsMatchingGlob(gitDir, '**/*.lock');
  if (lockFiles.length === 0) {
    return;
  }

  logger.info({ message: `> Evicting ${lockFiles.length} git lock file(s) from workspace` });
  await Fs.deleteFiles(lockFiles);
  logger.info({ message: `> Evicted git lock files` });
}

function isNetworkError(error: any): boolean {
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  return (
    /ECONNRESET/i.test(output) || /ETIMEDOUT/i.test(output) || /ENOTFOUND/i.test(output) ||
    /EAI_AGAIN/i.test(output) || /ECONNREFUSED/i.test(output) || /socket hang up/i.test(output) ||
    /network/i.test(output)
  );
}

async function retryOnNetworkError(
  fn: () => Promise<any>,
  label: string,
  maxRetries = 3,
  retryDelayMs = 15_000
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fn();
      return;
    } catch (error: any) {
      if (!isNetworkError(error) || attempt === maxRetries) {
        throw error;
      }
      logger.info({
        message: `(${cw.color(label)}) network error, retrying (attempt ${attempt}/${maxRetries}, next retry in ${retryDelayMs / 1000}s)`,
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
