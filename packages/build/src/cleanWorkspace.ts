import * as path from 'path'
import { PackageUtil, cmd, WorkspaceMetadata } from '@proteinjs/util-node'
import { Logger } from '@proteinjs/util'

export const cleanWorkspace = async (workspaceMetadata?: WorkspaceMetadata) => {
  const logger = new Logger('cleanWorkspace');
  const workspacePath = process.cwd();
  const { packageMap, sortedPackageNames } = workspaceMetadata ? workspaceMetadata : await PackageUtil.getWorkspaceMetadata(workspacePath);
  const filteredPackageNames = sortedPackageNames.filter(packageName => !!packageMap[packageName].packageJson.scripts?.clean);

  logger.info(`> Cleaning ${filteredPackageNames.length} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`);
  for (let packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    await cmd('npm', ['run', 'clean'], { cwd: packageDir });
  }
  logger.info(`> Finished cleaning ${filteredPackageNames.length} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`);
}