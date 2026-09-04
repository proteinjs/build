import { parseArgsMap } from '@proteinjs/util-node';
import { PackageProcessRunner } from './PackageProcessRunner';
import { BuildWorkspaceArgs, WorkspaceBuilder } from './WorkspaceBuilder';

/**
 * Install and build workspace, in dependency order — incrementally (only what changed since
 * the last run) and concurrently (independent packages in parallel, bounded by the CPU count
 * or `BUILD_WORKSPACE_CONCURRENCY`). See `WorkspaceBuilder` for the skip rules.
 *
 * Linting (prettier --write + eslint --fix) runs on CI ONLY (CI=true, set by GitHub Actions) or
 * locally behind an explicit `--lint`, and only for packages whose build ran. A default local
 * lint --fix reformats files across the whole workspace and strands them unstaged on top of
 * unrelated work; CI commits its own lint fallout.
 *
 * Optional args:
 *
 * --force (ignore the install/build stamps: install and build everything)
 * --lint (force linting locally)
 * --no-install=@some/package,@another/package
 * --no-build=@some/package,@another/package
 * --no-lint=@some/package,@another/package (CI: skip linting these packages)
 * --skip=@some/package,@another/package
 *
 * Env: BUILD_WORKSPACE_CONCURRENCY=<n> caps the package processes in flight (default: CPU count).
 */
export async function buildWorkspace() {
  PackageProcessRunner.forwardSignals();
  const args = getArgs();
  // CI=true is set by GitHub Actions; locally, linting is opt-in via --lint.
  const ci = process.env.CI === 'true';
  const builder = new WorkspaceBuilder({
    workspacePath: process.cwd(),
    args,
    concurrency: WorkspaceBuilder.defaultConcurrency(),
    lintEnabled: ci || !!args.lint,
    ci,
  });
  await builder.run();
}

function getArgs() {
  const args: BuildWorkspaceArgs = {};
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
    } else if (argName == 'lint') {
      args.lint = true;
    } else if (argName == 'force') {
      args.force = true;
    }
  }

  return args;
}
