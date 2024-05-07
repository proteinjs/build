import * as path from 'path'
import { exec } from 'child_process'
import { LocalPackage, LocalPackageMap, PackageUtil, cmd, Fs, LogColorWrapper } from '@proteinjs/util-node'
import { Logger } from '@proteinjs/util'
import semver from 'semver'
import { Commit } from './Github'
import { primaryLogColor, secondaryLogColor } from './logColors'

const cw = new LogColorWrapper();
const logger = new Logger(cw.color('workspace:', primaryLogColor) + cw.color('version', secondaryLogColor));
const fixedVersionWorkspacesToVersion: {[workspacePath: string]: boolean} = {};

export async function versionWorkspace() {
  // fail fast if npm token is not available
  getNpmToken();

  const workspacePath = process.cwd();
  await pullWorkspace(workspacePath);
  const { packageMap, packageGraph, sortedPackageNames, workspaceToPackageMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const skippedPackages = ['root', 'typescript-parser'];
  const filteredPackageNames = sortedPackageNames.filter(packageName => {
    const localPackage = packageMap[packageName];
    return !!localPackage.packageJson.scripts?.clean
      && !!localPackage.packageJson.scripts?.build 
      && !skippedPackages.includes(packageName)
    ;
  });

  logger.info(`> Versioning workspace (${workspacePath})`);
  for (let packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const dependenciesChanged = await bumpDependencies(localPackage, packageMap, packageGraph);
    if (!dependenciesChanged)
      continue;

    await buildAndTest(localPackage);
    if (localPackage.workspace && localPackage.workspace.lernaJson && localPackage.workspace.lernaJson.version !== 'independent') {
      fixedVersionWorkspacesToVersion[localPackage.workspace.path] = true;
      logger.info(`(${cw.color(packageName)}) skipping version push for package in a fixed-version workspace`);
      continue;
    }

    await pushAndTag(localPackage);
    if (!localPackage.packageJson.private && localPackage.packageJson.publishConfig?.access === 'public')
      await publish(localPackage);
  }

  await syncFixedVersionWorkspaces(Object.keys(fixedVersionWorkspacesToVersion), packageMap, workspaceToPackageMap);
  await pushMetarepos(workspacePath);
  await symlinkWorkspace(workspacePath, filteredPackageNames, packageMap);
  logger.info(`> Finished versioning workspace (${workspacePath})`);
}

async function pullWorkspace(workspacePath: string) {
  const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const filteredPackageNames = sortedPackageNames.filter(packageName => {
    const localPackage = packageMap[packageName];
    return !!localPackage.packageJson.scripts?.clean
      && !!localPackage.packageJson.scripts?.build 
      && packageName != 'typescript-parser'
    ;
  });

  logger.info(`> Pulling workspace (${workspacePath})`);
  for (let packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    await pull(localPackage);
  }

  logger.info(`> Finished pulling workspace (${workspacePath})`);
}

async function bumpDependencies(localPackage: LocalPackage, packageMap: LocalPackageMap, packageGraph: any) {
  const localDependencies = packageGraph.successors(localPackage.name);
  if (!localDependencies || localDependencies.length == 0)
    return false;

  let dependenciesChanged = false;
  for (let localDependency of localDependencies) {
    const localDependencyPackage = packageMap[localDependency];
    const localDependencyVersion = localDependencyPackage.packageJson.version as string;
    const currentDependencyVersion = getDependencyVersion(localDependency, localPackage);
    if (!currentDependencyVersion)
      throw new Error(`Package (${cw.color(localPackage.name)}) has dependency on ${localDependency}, but cannot find version in ${cw.color(localPackage.name)}'s package.json`);

    if (currentDependencyVersion.isLocalPath)
      continue;

    if (currentDependencyVersion?.version == localDependencyVersion)
      continue;

    const newDependencyVersion: DependencyVersion = { prefix: currentDependencyVersion.prefix, version: localDependencyVersion };
    setDependencyVersion(localDependency, currentDependencyVersion, newDependencyVersion, localPackage);
    dependenciesChanged = true;
  }

  if (dependenciesChanged) {
    const currentVersion = localPackage.packageJson.version;
    localPackage.packageJson.version = semver.inc(currentVersion, 'patch');
    logger.info(`(${cw.color(localPackage.name)}) bumping version from ${currentVersion} -> ${localPackage.packageJson.version}`);
    await Fs.writeFiles([{ path: localPackage.filePath, content: JSON.stringify(localPackage.packageJson, null, 2) }]);
  }

  return dependenciesChanged;
}

type DependencyVersion = { prefix?: string, version: string, isLocalPath?: boolean }

function getDependencyVersion(dependencyPackageName: string, localPackage: LocalPackage): DependencyVersion|undefined {
  let currentRawDependencyVersion = localPackage.packageJson.dependencies ? localPackage.packageJson.dependencies[dependencyPackageName] : undefined;
  if (!currentRawDependencyVersion)
    currentRawDependencyVersion = localPackage.packageJson.devDependencies ? localPackage.packageJson.devDependencies[dependencyPackageName] : undefined;

  if (!currentRawDependencyVersion)
    return undefined;

  if (currentRawDependencyVersion.startsWith('file:') || currentRawDependencyVersion.startsWith('.'))
    return { version: currentRawDependencyVersion, isLocalPath: true };

  const match = currentRawDependencyVersion.match(/^([~^]?)(\d+\.\d+\.\d+)/);
  return { prefix: match[1], version: match[2] };
}

function setDependencyVersion(dependencyPackageName: string, currentVersion: DependencyVersion, newVersion: DependencyVersion, localPackage: LocalPackage) {
  const newRawVersion = newVersion.prefix ? newVersion.prefix + newVersion.version : newVersion.version;
  if (localPackage.packageJson.dependencies && localPackage.packageJson.dependencies[dependencyPackageName])
    localPackage.packageJson.dependencies[dependencyPackageName] = newRawVersion;
  else
    localPackage.packageJson.devDependencies[dependencyPackageName] = newRawVersion;

  const currentRawVersion = currentVersion.prefix ? currentVersion.prefix + currentVersion.version : currentVersion.version;
  logger.info(`(${cw.color(localPackage.name)}) updating dependency version of ${cw.color(dependencyPackageName)} (${currentRawVersion} -> ${newRawVersion})`);
}

async function syncFixedVersionWorkspaces(fixedVersionWorkspacePaths: string[], packageMap: LocalPackageMap, workspaceToPackageMap: {[workspacePath: string]: string[]}) {
  if (fixedVersionWorkspacePaths.length == 0)
    return;

  logger.info(`> Syncing fixed-version workspaces`);
  for (let workspacePath of fixedVersionWorkspacePaths) {
    const workspacePackages = workspaceToPackageMap[workspacePath]
      .filter(packageName => packageName != 'typescript-parser')
      .map(packageName => packageMap[packageName])
    ;
    if (workspacePackages.length == 0)
      continue;

    const syncedVersion = await syncFixedVersions(workspacePath, workspacePackages);
    if (!syncedVersion)
      continue;

    await pushAndTagFixedVersionRepo(workspacePath, syncedVersion);
  }

  logger.info(`> Synced fixed-version workspaces`);
}

async function syncFixedVersions(workspacePath: string, localPackages: LocalPackage[]): Promise<string|false> {
  let highestVersion: string|undefined;
  for (let localPackage of localPackages) {
    if (!highestVersion) {
      highestVersion = localPackage.packageJson.version;
      continue;
    }

    if (semver.gt(localPackage.packageJson.version, highestVersion))
      highestVersion = localPackage.packageJson.version;
  }

  if (!highestVersion)
    throw new Error(`Unable to find version for packages`);

  let syncedFixedVersions = false;
  for (let localPackage of localPackages) {
    const currentVersion = localPackage.packageJson.version;
    if (currentVersion === highestVersion)
      continue;

    localPackage.packageJson.version = highestVersion;
    logger.info(`(${cw.color(localPackage.name)}) bumping version from ${currentVersion} -> ${localPackage.packageJson.version}`);
    await Fs.writeFiles([{ path: localPackage.filePath, content: JSON.stringify(localPackage.packageJson, null, 2) }]);
    syncedFixedVersions = true;
  }

  if (syncedFixedVersions) {
    const lernaJson = localPackages[0].workspace?.lernaJson;
    if (!lernaJson)
      throw new Error(`Cannot find lerna.json for workspace: ${workspacePath}`);

    const lernaJsonPath = path.join(workspacePath, 'lerna.json');
    lernaJson.version = highestVersion;
    await Fs.writeFiles([{ path: lernaJsonPath, content: JSON.stringify(lernaJson, null, 2) }]);
  }

  return syncedFixedVersions ? highestVersion : false;
}

async function buildAndTest(localPackage: LocalPackage) {
  const packageDir = path.dirname(localPackage.filePath);
  logger.info(`(${cw.color(localPackage.name)}) cleaning package`);
  await cmd('npm', ['run', 'clean'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info(`(${cw.color(localPackage.name)}) cleaned package`);
  logger.info(`(${cw.color(localPackage.name)}) installing latest dependency versions`);
  await cmd('npm', ['install'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info(`(${cw.color(localPackage.name)}) installed latest dependency versions`);
  logger.info(`(${cw.color(localPackage.name)}) building version ${localPackage.packageJson.version}`);
  await cmd('npm', ['run', 'build'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info(`(${cw.color(localPackage.name)}) built version ${localPackage.packageJson.version} (${packageDir})`);
  if (localPackage.packageJson.scripts?.test) {
    logger.info(`(${cw.color(localPackage.name)}) testing version ${localPackage.packageJson.version}`);
    await cmd('npm', ['run', 'test'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
    logger.info(`(${cw.color(localPackage.name)}) tested version ${localPackage.packageJson.version}`);
  }
}

async function pull(localPackage: LocalPackage) {
  const packageDir = path.dirname(localPackage.filePath);
  logger.info(`(${cw.color(localPackage.name)}) pulling latest changes`);
  await cmd('git', ['pull'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info(`(${cw.color(localPackage.name)}) pulled latest changes`);
}

async function pushAndTag(localPackage: LocalPackage): Promise<Commit> {
  const packageDir = path.dirname(localPackage.filePath);
  logger.info(`(${cw.color(localPackage.name)}) pushing latest version (${localPackage.packageJson.version})`);
  await cmd('git', ['add', '.'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  await cmd('git', ['commit', '-m', `chore(version): bumping dependency versions for ${localPackage.name} [skip ci]`], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  await cmd('git', ['push'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info(`(${cw.color(localPackage.name)}) pushed latest version (${localPackage.packageJson.version})`);
  const latestCommitSha = await getLatestCommitSha(packageDir);
  const repoInfo = await getRepoInfo(packageDir);
  const commit = { sha: latestCommitSha, ...repoInfo };
  const tagName = `${localPackage.name}@${localPackage.packageJson.version}`;
  logger.info(`(${cw.color(localPackage.name)}) pushing tag (${tagName})`);
  await cmd('git', ['tag', '-a', tagName, '-m', `Release ${tagName}`], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  await cmd('git', ['push', 'origin', tagName], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info(`(${cw.color(localPackage.name)}) pushed tag (${tagName})`);
  return commit;
}

async function pushAndTagFixedVersionRepo(dir: string, version: string): Promise<Commit> {
  const repoName = path.basename(dir.endsWith(path.sep) ? dir.slice(0, -1) : dir);
  logger.info(`(${cw.color(repoName)}) pushing latest version (${version})`);
  await cmd('git', ['add', '.'], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  await cmd('git', ['commit', '-m', `chore(version): bumping dependency versions [skip ci]`], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  await cmd('git', ['push'], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  logger.info(`(${cw.color(repoName)}) pushed latest version (${version})`);
  const latestCommitSha = await getLatestCommitSha(dir);
  const repoInfo = await getRepoInfo(dir);
  const commit = { sha: latestCommitSha, ...repoInfo };
  const tagName = `v${version}`;
  logger.info(`(${cw.color(repoName)}) pushing tag (${tagName})`);
  await cmd('git', ['tag', '-a', tagName, '-m', `Release ${tagName}`], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  await cmd('git', ['push', 'origin', tagName], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  logger.info(`(${cw.color(repoName)}) pushed tag (${tagName})`);
  return commit;
}

async function pushMetarepos(dir: string) {
  const metarepoPaths = (await Fs.getFilePathsMatchingGlob(dir, '**/.gitmodules', ['**/node_modules/**', '**/dist/**']))
    .map(gitmodulesPath => path.dirname(gitmodulesPath))
    .sort((a, b) => b.localeCompare(a))
  ;
  for (let metarepoPath of metarepoPaths)
    await pushMetarepo(metarepoPath);
}

async function pushMetarepo(dir: string) {
  const repoName = path.basename(dir.endsWith(path.sep) ? dir.slice(0, -1) : dir);
  logger.info(`(${cw.color(repoName)}) pushing metarepo (${dir})`);
  await cmd('git', ['add', '.'], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  await cmd('git', ['commit', '-m', `chore(version): bumping submodule versions [skip ci]`], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  await cmd('git', ['pull'], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  await cmd('git', ['push'], { cwd: dir }, { logPrefix: `[${cw.color(repoName)}] ` });
  logger.info(`(${cw.color(repoName)}) pushed metarepo (${dir})`);
}

async function symlinkWorkspace(workspacePath: string, packageNames: string[], packageMap: LocalPackageMap) {
  logger.info(`> Symlinking local dependencies in workspace (${workspacePath})`);
  for (let packageName of packageNames) {
    const localPackage = packageMap[packageName];
    await PackageUtil.symlinkDependencies(localPackage, packageMap, logger);
  }

  logger.info(`> Symlinked local dependencies in workspace (${workspacePath})`);
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
};

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
};

async function publish(localPackage: LocalPackage) {
  if (localPackage.packageJson.private) {
    logger.info(`Preventing publish of private package: ${cw.color(localPackage.name)}`);
    return;
  }

  if (!localPackage.name.startsWith('@proteinjs/')) {
    logger.warn(`Preventing publish of non-proteinjs package: ${cw.color(localPackage.name)}`);
    return;
  }

  const packageDir = path.dirname(localPackage.filePath);
  logger.info(`(${cw.color(localPackage.name)}) publishing latest version (${localPackage.packageJson.version})`);
  await cmd('npm', ['set', `//registry.npmjs.org/:_authToken=${getNpmToken()}`], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  await cmd('npm', ['publish', '--tag', 'latest', '--access', 'public'], { cwd: packageDir }, { logPrefix: `[${cw.color(localPackage.name)}] ` });
  logger.info(`(${cw.color(localPackage.name)}) published latest version (${localPackage.packageJson.version})`);
}

function getNpmToken() {
  if (process.env.NPM_TOKEN)
    return process.env.NPM_TOKEN;

  throw new Error(`NPM_TOKEN env variable not set`);
}