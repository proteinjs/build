import { LogColorWrapper, PackageUtil, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/util';
import { primaryLogColor, secondaryLogColor } from './logColors';

/**
 * Symlink dependencies to local packages for each package in the workspace.
 *
 * ie: `npx symlink-workspace --skip=@some/package,@another/package`
 *
 * Optional args:
 *
 * --skip=@some/package,@another/package
 */
export const symlinkWorkspace = async () => {
  const cw = new LogColorWrapper();
  const logger = new Logger(cw.color('workspace:', primaryLogColor) + cw.color('symlink', secondaryLogColor));
  const args = getArgs();
  const workspacePath = process.cwd();
  const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const skippedPackages = ['root'];
  const filteredPackageNames = sortedPackageNames.filter(
    (packageName) => !(args.skip && args.skip.includes(packageName)) && !skippedPackages.includes(packageName)
  );
  if (filteredPackageNames.length == 0) {
    logger.info(`> There are no packages to symlink in workspace (${workspacePath})`);
    return;
  }

  logger.info(
    `> Symlinking ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`
  );
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    await PackageUtil.symlinkDependencies(localPackage, packageMap, logger);
  }
  logger.info(
    `> Symlinked ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`
  );
};

type Args = {
  skip?: string[];
};

function getArgs() {
  const args: Args = {};
  const argsMap = parseArgsMap(process.argv.slice(2));
  for (const argName in argsMap) {
    const argValue = argsMap[argName];
    if (argName == 'skip' && typeof argValue === 'string') args.skip = argValue.split(',');
  }

  return args;
}
