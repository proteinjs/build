import * as path from 'path';
import { LocalPackageMap, LogColorWrapper, PackageUtil, cmd, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/util';
import { primaryLogColor, secondaryLogColor } from './logColors';

/**
 * Run a npm command against all packages in the workspace, in dependency order.
 *
 * ie: `npx workspace test --skip=@some/package,@another/package`
 *
 * Optional args:
 *
 * --skip=@some/package,@another/package
 */
export const workspaceCommand = async () => {
  const command = process.argv[2];
  const cw = new LogColorWrapper();
  const logger = new Logger(cw.color('workspace:', primaryLogColor) + cw.color(command, secondaryLogColor));
  const args = getArgs();
  const workspacePath = process.cwd();
  const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const skippedPackages = ['root'];
  const filteredPackageNames = sortedPackageNames.filter((packageName) => {
    return (
      hasScript(command, packageName, packageMap) &&
      !(args.skip && args.skip.includes(packageName)) &&
      !skippedPackages.includes(packageName)
    );
  });
  if (filteredPackageNames.length == 0) {
    logger.info(`> There are no packages with the \`${command}\` script in workspace (${workspacePath})`);
    return;
  }

  logger.info(
    `> Running \`npm run ${command}\` for ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`
  );
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    await cmd('npm', ['run', command], { cwd: packageDir }, { logPrefix: `[${cw.color(packageName)}] ` });
  }
  logger.info(
    `> Ran \`npm run ${command}\` for ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`
  );
};

type Args = {
  skip?: string[];
};

function getArgs() {
  const args: Args = {};
  const argsMap = parseArgsMap(process.argv.slice(3));
  for (const argName in argsMap) {
    const argValue = argsMap[argName];
    if (argName == 'skip' && typeof argValue === 'string') {
      args.skip = argValue.split(',');
    }
  }

  return args;
}

function hasScript(scriptName: string, packageName: string, packageMap: LocalPackageMap) {
  return !!packageMap[packageName].packageJson.scripts && !!packageMap[packageName].packageJson.scripts[scriptName];
}
