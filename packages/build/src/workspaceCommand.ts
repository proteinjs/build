import * as path from 'path'
import { LocalPackageMap, PackageUtil, cmd } from '@proteinjs/util-node'
import { Logger } from '@proteinjs/util'

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
  const command = process.argv[2]
  const logger = new Logger(`workspace:${command}`);
  const workspacePath = process.cwd();
  const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const filteredPackageNames = sortedPackageNames.filter(packageName => hasScript(command, packageName, packageMap));

  logger.info(`> Running \`npm run ${command}\` for ${filteredPackageNames.length} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`);
  for (let packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    await cmd('npm', ['run', command], { cwd: packageDir }, { logPrefix: `[${packageName}] ` });
  }
  logger.info(`> Ran \`npm run ${command}\` for ${filteredPackageNames.length} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`);
}

function hasScript(scriptName: string, packageName: string, packageMap: LocalPackageMap) {
  return !!packageMap[packageName].packageJson.scripts && !!packageMap[packageName].packageJson.scripts[scriptName];
}