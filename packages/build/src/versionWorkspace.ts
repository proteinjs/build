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
  if (dryRun) {
    logger.info({ message: `> Dry run: skipping pullWorkspace for (${workspacePath})` });
  } else {
    await pullWorkspace(workspacePath);
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
  await pushMetarepos(workspacePath);
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

async function pullWorkspace(workspacePath: string) {
  const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const filteredPackageNames = sortedPackageNames.filter((packageName) => {
    const localPackage = packageMap[packageName];
    return (
      !!localPackage.packageJson.scripts?.clean &&
      !!localPackage.packageJson.scripts?.build &&
      packageName != 'typescript-parser'
    );
  });

  logger.info({ message: `> Pulling workspace (${workspacePath})` });
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    await pull(localPackage);
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
      localPackage.packageJson.version = semver.inc(currentVersion, 'patch');
      logger.info({
        message: `(${cw.color(localPackage.name)}) bumping version from ${currentVersion} -> ${localPackage.packageJson.version}`,
      });
    }
    await Fs.writeFiles([{ path: localPackage.filePath, content: JSON.stringify(localPackage.packageJson, null, 2) }]);
    if (hasLintConfig(localPackage)) {
      const packageDir = path.dirname(localPackage.filePath);
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

  const highestVersion = semver.inc(lernaJson.version, 'patch');
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
    if (hasLintConfig(localPackage)) {
      const packageDir = path.dirname(localPackage.filePath);
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
    syncedFixedVersions = true;
  }

  if (syncedFixedVersions) {
    const lernaJsonPath = path.join(workspacePath, 'lerna.json');
    lernaJson.version = highestVersion;
    await Fs.writeFiles([{ path: lernaJsonPath, content: JSON.stringify(lernaJson, null, 2) }]);
  }

  return syncedFixedVersions ? highestVersion : false;
}

async function buildAndTest(localPackage: LocalPackage) {
  const packageDir = path.dirname(localPackage.filePath);
  logger.info({ message: `(${cw.color(localPackage.name)}) cleaning package` });
  await cmd('npm', ['run', 'clean'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info({ message: `(${cw.color(localPackage.name)}) cleaned package` });
  logger.info({ message: `(${cw.color(localPackage.name)}) installing latest dependency versions` });
  await cmd('npm', ['install'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info({ message: `(${cw.color(localPackage.name)}) installed latest dependency versions` });
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

async function pushMetarepos(dir: string) {
  const metarepoPaths = (await Fs.getFilePathsMatchingGlob(dir, '**/.gitmodules', ['**/node_modules/**', '**/dist/**']))
    .map((gitmodulesPath) => path.dirname(gitmodulesPath))
    .sort((a, b) => b.localeCompare(a));
  for (const metarepoPath of metarepoPaths) {
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

  if (dryRun) {
    logger.info({
      message: `(${cw.color(localPackage.name)}) Dry run: would publish version ${localPackage.packageJson.version}`,
    });
    return;
  }

  const publishConfig = localPackage.packageJson.publishConfig ?? {};
  const registry = getPublishRegistry(publishConfig);
  const tag = publishConfig.tag ?? 'latest';
  const access = publishConfig.access;
  const accessLogValue = access ?? 'n/a';
  const packageDir = path.dirname(localPackage.filePath);
  if (!dryRun) {
    await assertRegistryAuth(registry, localPackage);
  }

  logger.info({
    message: `(${cw.color(localPackage.name)}) publishing latest version (${localPackage.packageJson.version}) [access=${accessLogValue}, registry=${registry}]`,
  });
  const publishArgs = ['publish', '--tag', tag];
  if (access) {
    publishArgs.push('--access', access);
  }
  if (publishConfig.registry) {
    publishArgs.push('--registry', registry);
  }
  await cmd('npm', publishArgs, { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info({
    message: `(${cw.color(localPackage.name)}) published latest version (${localPackage.packageJson.version})`,
  });
}

const registryAuthCheckCache: { [registry: string]: boolean } = {};

async function assertRegistryAuth(registry: string, localPackage: LocalPackage) {
  if (!registry || registryAuthCheckCache[registry]) {
    return;
  }

  try {
    await cmd(
      'npm',
      ['whoami', '--registry', registry],
      { cwd: process.cwd() },
      { logPrefix: `[${cw.color(localPackage.name)}] ` }
    );
    registryAuthCheckCache[registry] = true;
  } catch (error) {
    throw new Error(
      `Failed npm authentication check for registry (${registry}) while publishing ${localPackage.name}. Ensure credentials in .npmrc are valid. \nOriginal error: ${error}`
    );
  }
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
