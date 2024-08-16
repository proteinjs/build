import * as path from 'path';
import { LogColorWrapper, PackageUtil, cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { primaryLogColor, secondaryLogColor } from './logColors';

/**
 * Run a command in the directory of the specified package.
 * If running an npm command, this utility re-symlinks dependencies afterwards.
 *
 * ie: `npx workspace-package @my/package npm i react`
 */
export const workspacePackageCommand = async () => {
  const packageName = process.argv[2];
  const command = process.argv[3];
  const args = process.argv.slice(4);
  const cw = new LogColorWrapper();
  const logger = new Logger({
    name: `${cw.color('workspace-package(', primaryLogColor)}${cw.color(packageName, secondaryLogColor)}${cw.color(')', primaryLogColor)}`,
  });
  const workspacePath = process.cwd();
  const { packageMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const localPackage = packageMap[packageName];
  if (!localPackage) {
    throw new Error(
      `Package (${cw.color(packageName, secondaryLogColor)}) does not exist in workspace: ${workspacePath}`
    );
  }

  const packageDir = path.dirname(localPackage.filePath);
  logger.info({ message: `Running command: ${cw.color(`${command} ${args.join(' ')}`, secondaryLogColor)}` });
  await cmd(command, args, { cwd: packageDir }, { logPrefix: `[${cw.color(packageName, secondaryLogColor)}] ` });
  logger.info({ message: `Finished running command: ${cw.color(`${command} ${args.join(' ')}`, secondaryLogColor)}` });
  if (command === 'npm') {
    logger.info({ message: `Symlinking local dependencies` });
    const { packageMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
    const localPackage = packageMap[packageName];
    await PackageUtil.symlinkDependencies(localPackage, packageMap);
    logger.info({ message: `Symlinked local dependencies` });
  }
};
