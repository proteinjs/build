import * as path from 'path'
import { PackageUtil, WorkspaceMetadata, cmd, LogColorWrapper } from '@proteinjs/util-node'
import { Logger } from '@proteinjs/util'
import { primaryLogColor, secondaryLogColor } from './logColors';

export const watchWorkspace = async (workspaceMetadata?: WorkspaceMetadata) => {
  const cw = new LogColorWrapper();
  const logger = new Logger(cw.color('workspace:', primaryLogColor) + cw.color('watch', secondaryLogColor));
  const workspacePath = process.cwd();
  const { packageMap, sortedPackageNames } = workspaceMetadata ? workspaceMetadata : await PackageUtil.getWorkspaceMetadata(workspacePath);
  const filteredPackageNames = sortedPackageNames.filter(packageName => !!packageMap[packageName].packageJson.scripts?.watch);

  logger.info(`> Watching ${filteredPackageNames.length} package${filteredPackageNames.length != 1 ? 's' : ''} in workspace (${workspacePath})`);
  const loggingStartDelay = 0;
  for (let packageName of filteredPackageNames) {
    const localPackage = packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    const loggingEnabledState = { loggingEnabled: false };
    setTimeout(() => loggingEnabledState.loggingEnabled = true, loggingStartDelay);
    const logPrefix = `[${cw.color(packageName)}] `;
    let inMultiLineLog = false;
    const stdoutFilter = (log: string) => {
      if (log.includes('File change detected. Starting incremental compilation'))
        return;
  
      let filteredOutput = log.replace(/\x1Bc|\x1B\[2J\x1B\[0;0H/g, ''); // char sequence for clearing terminal
      if (filteredOutput.includes('Watching for file changes.'))
        filteredOutput = filteredOutput.replace(/^\n/, '');

      if (filteredOutput.trim() == '')
        return;

      // Replace newline with newline+prefix under the following conditions:
      // 1. It is not at the start of the string (?<!^)
      // 2. It is not at the end of the string (?!$)
      // 3. It is not followed by another newline (?!\r?\n)
      filteredOutput = filteredOutput.replace(/(?<!^)(\r?\n)(?!\r?\n|$)/g, `$1${logPrefix}`);

      if (!inMultiLineLog)
        filteredOutput = `${logPrefix}${filteredOutput}`;

      if (filteredOutput.endsWith('\n') || filteredOutput.endsWith('\r\n'))
        inMultiLineLog = false;
      else
        inMultiLineLog = true;
  
      return filteredOutput;
    };
    cmd('npm', ['run', 'watch'], { cwd: packageDir }, { 
      omitLogs: { 
        stdout: {
          filter: stdoutFilter,
        }
      }, 
    });
  }
}