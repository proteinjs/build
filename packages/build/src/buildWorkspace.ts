import * as path from 'path'
import { PackageUtil, cmd, parseArgsMap } from '@proteinjs/util-node'
import { Logger } from '@proteinjs/util'

/**
 * Install and build workspace, in dependency order.
 * 
 * Optional args:
 * 
 * --no-install=@some/package,@another/package
 * --no-build=@some/package,@another/package
 * --skip=@some/package,@another/package
 */
export async function buildWorkspace() {
  const logger = new Logger('workspace:build');
  const args = getArgs();
  const workspacePath = process.cwd();
  const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const filteredPackageNames = sortedPackageNames.filter(packageName => { 
    return !!packageMap[packageName].packageJson.scripts?.build &&
      !(args.skip && args.skip.includes(packageName));
  });

  logger.info(`> Installing and building ${filteredPackageNames.length} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`);
  logger.debug(`packageMap:\n${JSON.stringify(packageMap, null, 2)}`, true);
  logger.debug(`filteredPackageNames:\n${JSON.stringify(filteredPackageNames, null, 2)}`, true);
  for (let packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);

    if (!args.noInstall || !args.noInstall.includes(packageName)) {
      await cmd('npm', ['install'], { cwd: packageDir }, { logPrefix: `[${packageName}] ` });
      await PackageUtil.symlinkDependencies(localPackage, packageMap, logger);
      logger.info(`Installed ${packageName} (${packageDir})`);
    }

    if (!args.noBuild || !args.noBuild.includes(packageName)) {
      await cmd('npm', ['run', 'build'], { cwd: packageDir }, { logPrefix: `[${packageName}] ` });
      logger.info(`Built ${packageName} (${packageDir})`);
    }
  }

  logger.info(`> Installed and built ${filteredPackageNames.length} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`);
}

type Args = {
  noInstall?: string[],
  noBuild?: string[],
  skip?: string[],
}

function getArgs() {
  const args: Args = {};
  const argsMap = parseArgsMap(process.argv.slice(2));
  for (let argName in argsMap) {
    const argValue = argsMap[argName];
    if (argName == '--no-install' && typeof argValue === 'string')
      args.noInstall = argValue.split(',');
    else if (argName == '--no-build' && typeof argValue === 'string')
      args.noBuild = argValue.split(',');
    else if (argName == '--skip' && typeof argValue === 'string')
      args.skip = argValue.split(',');
  }

  return args;
}