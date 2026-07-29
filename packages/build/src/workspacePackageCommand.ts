import * as path from 'path';
import { LogColorWrapper, PackageUtil, cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { primaryLogColor, secondaryLogColor } from './logColors';
import { ServePackageSupervisor } from './ServePackageSupervisor';

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
    // A watcher inside a running supervised child (webpack dev middleware) may have compiled
    // against node_modules mid-op and baked ENOENTs into its bundle — and the re-symlink
    // restores identical mtimes, so that watcher never re-fires on its own. File a hold- and
    // coherence-gated restart request with every live supervisor so serving state is rebuilt
    // from the settled workspace.
    const requested = await ServePackageSupervisor.requestWorkspaceRestarts(
      packageMap,
      `workspace-package(${packageName}) ${command} ${args.join(' ')}`
    );
    if (requested.length > 0) {
      logger.info({
        message: `Requested supervised restart of ${cw.color(requested.join(', '), secondaryLogColor)} (gated on holds + workspace coherence)`,
      });
    }
  }
};
