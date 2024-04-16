import * as path from 'path'
import { PackageUtil, WorkspaceMetadata, cmd } from '@proteinjs/util-node'
import { Logger } from '@proteinjs/util'

export async function buildWorkspace(workspaceMetadata?: WorkspaceMetadata) {
  const logger = new Logger('buildWorkspace');
  const workspacePath = process.cwd();
  logger.info(`> Building workspace (${workspacePath})`);
  const { packageMap, sortedPackageNames } = workspaceMetadata ? workspaceMetadata : await PackageUtil.getWorkspaceMetadata(workspacePath);
  const filteredPackageNames = sortedPackageNames.filter(packageName => !!packageMap[packageName].packageJson.scripts?.build);
  logger.debug(`packageMap:\n${JSON.stringify(packageMap, null, 2)}`, true);
  logger.debug(`filteredPackageNames:\n${JSON.stringify(filteredPackageNames, null, 2)}`, true);

  logger.info(`> Installing and building ${filteredPackageNames.length} package${filteredPackageNames.length != 1 ? 's' : ''}`);
  for (let packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    await cmd('npm', ['install'], { cwd: packageDir });
    // await PackageUtil.symlinkDependencies(localPackage, packageMap, logger);
    logger.info(`Installed ${packageName} (${packageDir})`);

    if (packageName != 'typescript-parser') {
      await cmd('npm', ['run', 'build'], { cwd: packageDir });
      logger.info(`Built ${packageName} (${packageDir})`);
    }
  }

  logger.info(`> Built workspace (${workspacePath})`);
}