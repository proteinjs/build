import { LogColorWrapper, PackageUtil, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
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
  const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('symlink', secondaryLogColor) });
  const args = getArgs();
  const workspacePath = process.cwd();
  const { packageMap, packagePathMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
  // Iterate the PATH-KEYED discovery map — every discovered package.json, one entry each.
  // Root-named consumers symlink like everyone else: every workspace root is named `root`
  // (metarepo root, app root, nested lerna roots), so both the old name-keyed iteration
  // (same-named packages collide to one entry) and the old blanket `root` skip left those
  // consumers holding stale registry copies of workspace packages indefinitely. Symlinking
  // is independent per-package fs work, so dependency order is irrelevant; sort by path for
  // deterministic logs. The name-keyed map is still what resolves each package's declared
  // dependency NAMES to workspace members.
  const packagesToLink = Object.keys(packagePathMap)
    .sort()
    .map((packageJsonPath) => packagePathMap[packageJsonPath])
    .filter((localPackage) => !(args.skip && args.skip.includes(localPackage.name)));
  if (packagesToLink.length == 0) {
    logger.info({ message: `> There are no packages to symlink in workspace (${workspacePath})` });
    return;
  }

  logger.info({
    message: `> Symlinking ${cw.color(`${packagesToLink.length}`, secondaryLogColor)} package${packagesToLink.length != 1 ? 's' : ''} in workspace (${workspacePath})`,
  });
  for (const localPackage of packagesToLink) {
    await PackageUtil.symlinkDependencies(localPackage, packageMap);
  }
  logger.info({
    message: `> Symlinked ${cw.color(`${packagesToLink.length}`, secondaryLogColor)} package${packagesToLink.length != 1 ? 's' : ''} in workspace (${workspacePath})`,
  });
};

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
