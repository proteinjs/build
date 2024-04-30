import * as path from 'path'
import { LogColorWrapper, PackageUtil, cmd } from '@proteinjs/util-node'
import { Logger } from '@proteinjs/util'
import { primaryLogColor } from './logColors'

/**
 * Run a command in the directory of the specified package.
 * If running an npm command, this utility re-symlinks dependencies afterwards.
 * 
 * ie: `npx workspace-package @my/package npm i react`
 */
export const workspacePackageCommand = async () => {
  const packageName = process.argv[2]
  const command = process.argv[3];
  const args = process.argv.slice(4);
  const cw = new LogColorWrapper();
  const logger = new Logger(`workspace-package(${cw.color(packageName, primaryLogColor)}):${command}`);
  const workspacePath = process.cwd();
  const { packageMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  const localPackage = packageMap[packageName];
  if (!localPackage)
    throw new Error(`Package (${cw.color(packageName, primaryLogColor)}) does not exist in workspace: ${workspacePath}`)
  
  const packageDir = path.dirname(localPackage.filePath);
  await cmd(command, args, { cwd: packageDir }, { logPrefix: `[${cw.color(packageName, primaryLogColor)}] ` });
  if (command === 'npm')
    await PackageUtil.symlinkDependencies(localPackage, packageMap, logger);
}