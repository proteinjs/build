import * as path from 'path';
import { PackageUtil, cmd, WorkspaceMetadata } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';

export const cleanWorkspace = async (workspaceMetadata?: WorkspaceMetadata) => {
  const logger = new Logger({ name: 'workspace:clean' });
  const workspacePath = process.cwd();
  const { packageMap, sortedPackageNames } = workspaceMetadata
    ? workspaceMetadata
    : await PackageUtil.getWorkspaceMetadata(workspacePath);
  const skippedPackages = ['root'];
  const filteredPackageNames = sortedPackageNames.filter(
    (packageName) => !!packageMap[packageName].packageJson.scripts?.clean && !skippedPackages.includes(packageName)
  );

  logger.info({
    message: `> Cleaning ${filteredPackageNames.length} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`,
  });
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    await cmd('npm', ['run', 'clean'], { cwd: packageDir });
  }
  logger.info({
    message: `> Finished cleaning ${filteredPackageNames.length} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`,
  });
};
