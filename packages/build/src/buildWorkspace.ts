import * as path from 'path';
import { LogColorWrapper, PackageUtil, cmd, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/util';
import { primaryLogColor, secondaryLogColor } from './logColors';
import { hasLintConfig } from './lintWorkspace';

/**
 * Install and build workspace, in dependency order.
 *
 * Optional args:
 *
 * --no-install=@some/package,@another/package
 * --no-build=@some/package,@another/package
 * --no-lint=@some/package,@another/package
 * --skip=@some/package,@another/package
 */
export async function buildWorkspace() {
  const cw = new LogColorWrapper();
  const logger = new Logger(cw.color('workspace:', primaryLogColor) + cw.color('build', secondaryLogColor));
  const args = getArgs();
  const workspacePath = process.cwd();
  const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const skippedPackages = ['root'];
  const filteredPackageNames = sortedPackageNames.filter((packageName) => {
    return (
      !!packageMap[packageName].packageJson.scripts?.build &&
      !(args.skip && args.skip.includes(packageName)) &&
      !skippedPackages.includes(packageName)
    );
  });

  logger.info(
    `> Installing, building, and linting ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`
  );
  logger.debug(`packageMap:\n${JSON.stringify(packageMap, null, 2)}`, true);
  logger.debug(`filteredPackageNames:\n${JSON.stringify(filteredPackageNames, null, 2)}`, true);
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);

    if (!args.noInstall || !args.noInstall.includes(packageName)) {
      await cmd('npm', ['install'], { cwd: packageDir }, { logPrefix: `[${cw.color(packageName)}] ` });
      await PackageUtil.symlinkDependencies(localPackage, packageMap, logger);
      logger.info(`Installed ${cw.color(packageName)} (${packageDir})`);
    }

    if (!args.noBuild || !args.noBuild.includes(packageName)) {
      await cmd('npm', ['run', 'build'], { cwd: packageDir }, { logPrefix: `[${cw.color(packageName)}] ` });
      logger.info(`Built ${cw.color(packageName)} (${packageDir})`);
    }

    if (hasLintConfig(packageMap, packageName) && (!args.noLint || !args.noLint.includes(packageName))) {
      await cmd('npx', ['prettier', '.', '--write'], { cwd: packageDir }, { logPrefix: `[${cw.color(packageName)}] ` });
      await cmd('npx', ['eslint', '.', '--fix'], { cwd: packageDir }, { logPrefix: `[${cw.color(packageName)}] ` });
      logger.info(`Linted ${cw.color(packageName)} (${packageDir})`);
    }
  }

  logger.info(
    `> Installed, built, and linted ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`
  );
}

type Args = {
  noInstall?: string[];
  noBuild?: string[];
  noLint?: string[];
  skip?: string[];
};

function getArgs() {
  const args: Args = {};
  const argsMap = parseArgsMap(process.argv.slice(2));
  for (const argName in argsMap) {
    const argValue = argsMap[argName];
    if (argName == 'no-install' && typeof argValue === 'string') {
      args.noInstall = argValue.split(',');
    } else if (argName == 'no-build' && typeof argValue === 'string') {
      args.noBuild = argValue.split(',');
    } else if (argName == 'no-lint' && typeof argValue === 'string') {
      args.noLint = argValue.split(',');
    } else if (argName == 'skip' && typeof argValue === 'string') {
      args.skip = argValue.split(',');
    }
  }

  return args;
}
