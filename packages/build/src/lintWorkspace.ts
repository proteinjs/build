import * as path from 'path';
import { LogColorWrapper, PackageUtil, cmd, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/util';
import { primaryLogColor, secondaryLogColor } from './logColors';

/**
 * Lint workspace, in dependency order.
 *
 * Optional args:
 *
 * --skip=@some/package,@another/package
 */
export async function lintWorkspace() {
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
    `> Linting ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`
  );
  logger.debug(`packageMap:\n${JSON.stringify(packageMap, null, 2)}`, true);
  logger.debug(`filteredPackageNames:\n${JSON.stringify(filteredPackageNames, null, 2)}`, true);
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);

    await cmd('npx', ['prettier', '.', '--write'], { cwd: packageDir }, { logPrefix: `[${cw.color(packageName)}] ` });
    await cmd('npx', ['eslint', '.', '--fix'], { cwd: packageDir }, { logPrefix: `[${cw.color(packageName)}] ` });
    logger.info(`Linted ${cw.color(packageName)} (${packageDir})`);
  }

  logger.info(
    `> Linted ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`
  );
}

type Args = {
  skip?: string[];
};

function getArgs() {
  const args: Args = {};
  const argsMap = parseArgsMap(process.argv.slice(2));
  for (const argName in argsMap) {
    const argValue = argsMap[argName];
    if (argName == 'skip' && typeof argValue === 'string') {
      args.skip = argValue.split(',');
    }
  }

  return args;
}
