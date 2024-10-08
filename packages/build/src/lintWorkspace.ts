import * as path from 'path';
import * as fs from 'fs';
import { LocalPackage, LogColorWrapper, PackageUtil, cmd, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
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
  const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('lint', secondaryLogColor) });
  const args = getArgs();
  const workspacePath = process.cwd();
  const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const skippedPackages = ['root'];
  const filteredPackageNames = sortedPackageNames.filter((packageName) => {
    return (
      hasLintConfig(packageMap[packageName]) &&
      !(args.skip && args.skip.includes(packageName)) &&
      !skippedPackages.includes(packageName)
    );
  });

  logger.info({
    message: `> Linting ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`,
  });
  logger.debug({ message: `packageMap:`, obj: packageMap });
  logger.debug({ message: `filteredPackageNames:`, obj: filteredPackageNames });
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);

    await cmd('npx', ['prettier', '.', '--write'], { cwd: packageDir }, { logPrefix: `[${cw.color(packageName)}] ` });
    await cmd('npx', ['eslint', '.', '--fix'], { cwd: packageDir }, { logPrefix: `[${cw.color(packageName)}] ` });
    logger.info({ message: `Linted ${cw.color(packageName)} (${packageDir})` });
  }

  logger.info({
    message: `> Linted ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`,
  });
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

export const hasLintConfig = (localPackage: LocalPackage): boolean => {
  const directoryPath = path.dirname(localPackage.filePath);

  const getFilesInDirectory = (directoryPath: string): string[] => {
    try {
      return fs.readdirSync(directoryPath).map((file) => path.basename(file));
    } catch (err) {
      console.error(`Error reading directory ${directoryPath}:`, err);
      return [];
    }
  };

  const files = getFilesInDirectory(directoryPath);

  const prettierConfigs = [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.yml',
    '.prettierrc.yaml',
    '.prettierrc.js',
    '.prettierrc.cjs',
    'prettier.config.js',
    'prettier.config.cjs',
  ];

  const eslintConfigs = [
    '.eslintrc',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    '.eslintrc.js',
    '.eslintrc.cjs',
    'eslint.config.js',
  ];

  const hasPrettier = files.some((file) => prettierConfigs.includes(file));
  const hasEslint = files.some((file) => eslintConfigs.includes(file));

  return hasPrettier && hasEslint;
};
