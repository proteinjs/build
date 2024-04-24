import * as path from 'path'
import { exec } from 'child_process'
import { LocalPackage, LocalPackageMap, PackageUtil, cmd, Fs } from '@proteinjs/util-node'
import { Logger } from '@proteinjs/util'
import { Commit } from './Github'

const logger = new Logger('workspace:version');

export async function versionWorkspace() {
  const workspacePath = process.cwd();
  await pullWorkspace(workspacePath);
  const { packageMap, packageGraph, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const filteredPackageNames = sortedPackageNames.filter(packageName => {
    const localPackage = packageMap[packageName];
    return !!localPackage.packageJson.scripts?.clean
      && !!localPackage.packageJson.scripts?.build 
      && packageName != 'typescript-parser'
    ;
  });

  logger.info(`> Versioning workspace (${workspacePath})`);
  for (let packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const dependenciesChanged = await bumpDependencies(localPackage, packageMap, packageGraph);
    if (!dependenciesChanged)
      continue;

    await buildAndTest(localPackage);
    await push(localPackage);
    if (!localPackage.packageJson.private && localPackage.packageJson.publishConfig?.access === 'public')
      await publish(localPackage);
  }

  await pushMetarepos(workspacePath);
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

  await pushMetarepo(workspacePath);
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
      throw new Error(`Package (${localPackage.name}) has dependency on ${localDependency}, but cannot find version in ${localPackage.name}'s package.json`);

    if (currentDependencyVersion.isLocalPath)
      continue;

    if (currentDependencyVersion?.version == localDependencyVersion)
      continue;

    const newDependencyVersion: DependencyVersion = { prefix: currentDependencyVersion.prefix, version: localDependencyVersion };
    setDependencyVersion(localDependency, currentDependencyVersion, newDependencyVersion, localPackage);
    dependenciesChanged = true;
  }

  if (dependenciesChanged) {
    const bumpPatchVersion = (version: string) => version.replace(/(\d+)\.(\d+)\.(\d+)$/, (_, major, minor, patch) => `${major}.${minor}.${parseInt(patch, 10) + 1}`);
    const currentVersion = localPackage.packageJson.version;
    localPackage.packageJson.version = bumpPatchVersion(currentVersion);
    logger.info(`(${localPackage.name}) bumping version from ${currentVersion} -> ${localPackage.packageJson.version}`);
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
  logger.info(`(${localPackage.name}) updating dependency version of ${dependencyPackageName} (${currentRawVersion} -> ${newRawVersion})`);
}

async function buildAndTest(localPackage: LocalPackage) {
  const packageDir = path.dirname(localPackage.filePath);
  const packageLockPath = path.resolve(packageDir, 'package-lock.json');
  await Fs.deleteFolder(packageLockPath);
  await cmd('npm', ['install'], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
  logger.info(`(${localPackage.name}) installed latest dependency versions (${packageDir})`);
  await cmd('npm', ['run', 'build'], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
  logger.info(`(${localPackage.name}) built version ${localPackage.packageJson.version} (${packageDir})`);
  if (localPackage.packageJson.scripts?.test) {
    await cmd('npm', ['run', 'test'], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
    logger.info(`(${localPackage.name}) tested version ${localPackage.packageJson.version} (${packageDir})`);
  }
}

async function pull(localPackage: LocalPackage) {
  const packageDir = path.dirname(localPackage.filePath);
  await cmd('git', ['pull'], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
  logger.info(`(${localPackage.name}) pulled latest changes`);
}

async function push(localPackage: LocalPackage): Promise<Commit> {
  const packageDir = path.dirname(localPackage.filePath);
  await cmd('git', ['add', '.'], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
  await cmd('git', ['commit', '-m', `chore(version): bumping dependency versions for ${localPackage.name} [skip ci]`], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
  await cmd('git', ['push'], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
  logger.info(`(${localPackage.name}) pushed latest version (${localPackage.packageJson.version})`);
  const latestCommitSha = await getLatestCommitSha(packageDir);
  const repoInfo = await getRepoInfo(packageDir);
  const commit = { sha: latestCommitSha, ...repoInfo };
  const tagName = `${localPackage.name}@${localPackage.packageJson.version}`;
  await cmd('git', ['tag', '-a', tagName, '-m', `Release ${tagName}`], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
  await cmd('git', ['push', 'origin', tagName], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
  logger.info(`(${localPackage.name}) pushed tag (${tagName})`);
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
  await cmd('git', ['add', '.'], { cwd: dir }, { logPrefix: `[workspace] ` });
  await cmd('git', ['commit', '-m', `chore(version): bumping submodule versions [skip ci]`], { cwd: dir }, { logPrefix: `[workspace] ` });
  await cmd('git', ['push'], { cwd: dir }, { logPrefix: `[workspace] ` });
  logger.info(`(workspace) pushed metarepo (${dir})`);
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
    logger.info(`Preventing publish of private package: ${localPackage.name}`);
    return;
  }

  if (!localPackage.name.startsWith('@proteinjs/')) {
    logger.warn(`Preventing publish of non-proteinjs package: ${localPackage.name}`);
    return;
  }

  const packageDir = path.dirname(localPackage.filePath);
  await cmd('npm', ['set', `//registry.npmjs.org/:_authToken=${getNpmToken()}`], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
  await cmd('npm', ['publish', '--tag', 'latest', '--access', 'public'], { cwd: packageDir }, { logPrefix: `[${localPackage.name}] ` });
  logger.info(`(${localPackage.name}) published latest version (${localPackage.packageJson.version})`);
}

function getNpmToken() {
  if (process.env.NPM_TOKEN)
    return process.env.NPM_TOKEN;

  throw new Error(`NPM_TOKEN env variable not set`);
}