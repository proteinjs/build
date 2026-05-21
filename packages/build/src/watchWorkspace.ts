import * as path from 'path';
import { PackageUtil, WorkspaceMetadata, cmd, LogColorWrapper } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { primaryLogColor, secondaryLogColor } from './logColors';

/**
 * Collect node_modules/.bin directories from `fromDir` up to (and including) `untilDir`.
 * This mirrors the PATH that `npm run` provides, so a watch script's bins resolve when we
 * invoke it directly via `sh -c` instead of paying for a resident `npm run` process per package.
 */
const nodeModulesBinPaths = (fromDir: string, untilDir: string): string[] => {
  const binPaths: string[] = [];
  let current = path.resolve(fromDir);
  const stop = path.resolve(untilDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    binPaths.push(path.join(current, 'node_modules', '.bin'));
    if (current === stop) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return binPaths;
};

/**
 * Find watcher processes (`reflection-watch`) belonging to this workspace. Used to clean up
 * watchers orphaned by a previous `watch-workspace` run (e.g. one that was force-killed) —
 * leftover watchers would otherwise make every file change trigger duplicate builds.
 */
const findWorkspaceWatchers = async (workspacePath: string): Promise<number[]> => {
  let psStdout: string;
  try {
    const result = await cmd(
      'ps',
      ['-eo', 'pid=,command='],
      {},
      { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }
    );
    psStdout = result.stdout;
  } catch {
    return [];
  }

  const watcherSignature = '/node_modules/.bin/reflection-watch';
  const workspacePrefix = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
  const pids: number[] = [];
  for (const line of psStdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const command = match[2];
    // Never match ourselves; only match watchers rooted under this exact workspace.
    if (pid === process.pid) {
      continue;
    }
    if (command.includes(workspacePrefix) && command.includes(watcherSignature)) {
      pids.push(pid);
    }
  }
  return pids;
};

export const watchWorkspace = async (workspaceMetadata?: WorkspaceMetadata) => {
  const cw = new LogColorWrapper();
  const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('watch', secondaryLogColor) });
  const workspacePath = process.cwd();
  const { packageMap, sortedPackageNames } = workspaceMetadata
    ? workspaceMetadata
    : await PackageUtil.getWorkspaceMetadata(workspacePath);
  const skippedPackages = ['root'];
  const filteredPackageNames = sortedPackageNames.filter(
    (packageName) => !!packageMap[packageName].packageJson.scripts?.watch && !skippedPackages.includes(packageName)
  );

  // Kill watchers left behind by a previous run before spawning fresh ones, so a package is
  // never watched twice (which would double every build).
  const staleWatchers = await findWorkspaceWatchers(workspacePath);
  if (staleWatchers.length > 0) {
    logger.info({
      message: `> Cleaning up ${cw.color(`${staleWatchers.length}`, secondaryLogColor)} stale watcher${staleWatchers.length != 1 ? 's' : ''} from a previous run`,
    });
    for (const pid of staleWatchers) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process already exited; nothing to clean up.
      }
    }
  }

  logger.info({
    message: `> Watching ${cw.color(`${filteredPackageNames.length}`, secondaryLogColor)} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`,
  });
  const loggingStartDelay = 0;
  for (const packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    const loggingEnabledState = { loggingEnabled: false };
    setTimeout(() => (loggingEnabledState.loggingEnabled = true), loggingStartDelay);
    const logPrefix = `[${cw.color(packageName)}] `;
    let inMultiLineLog = false;
    const stdoutFilter = (log: string) => {
      if (log.includes('File change detected. Starting incremental compilation')) {
        return;
      }

      // eslint-disable-next-line no-control-regex
      let filteredOutput = log.replace(/\x1Bc|\x1B\[2J\x1B\[0;0H/g, ''); // char sequence for clearing terminal
      if (filteredOutput.includes('Watching for file changes.')) {
        filteredOutput = filteredOutput.replace(/^\n/, '');
      }

      if (filteredOutput.trim() == '') {
        return;
      }

      // Replace newline with newline+prefix under the following conditions:
      // 1. It is not at the start of the string (?<!^)
      // 2. It is not at the end of the string (?!$)
      // 3. It is not followed by another newline (?!\r?\n)
      filteredOutput = filteredOutput.replace(/(?<!^)(\r?\n)(?!\r?\n|$)/g, `$1${logPrefix}`);

      if (!inMultiLineLog) {
        filteredOutput = `${logPrefix}${filteredOutput}`;
      }

      if (filteredOutput.endsWith('\n') || filteredOutput.endsWith('\r\n')) {
        inMultiLineLog = false;
      } else {
        inMultiLineLog = true;
      }

      return filteredOutput;
    };
    const watchScript = localPackage.packageJson.scripts?.watch;
    if (!watchScript) {
      continue;
    }

    // Invoke the watch script directly instead of through `npm run`, which would leave a
    // resident npm process per package. `sh -c` exec-replaces itself with the script's
    // command, so no extra shell lingers either.
    const watchEnv = {
      ...process.env,
      PATH: [...nodeModulesBinPaths(packageDir, workspacePath), process.env.PATH].filter(Boolean).join(path.delimiter),
    };
    cmd(
      '/bin/sh',
      ['-c', watchScript],
      { cwd: packageDir, env: watchEnv },
      {
        omitLogs: {
          stdout: {
            filter: stdoutFilter,
          },
        },
      }
    );
  }
};
