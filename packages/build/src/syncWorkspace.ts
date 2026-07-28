import * as path from 'path';
import * as fs from 'fs/promises';
import { LogColorWrapper, parseArgsMap, cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { WorkspaceDoctor } from './WorkspaceDoctor';
import { primaryLogColor, secondaryLogColor } from './logColors';

/**
 * Pull workspace repos and land the tree COHERENT: pull → doctor --fix (install pulled
 * dependency additions, restore symlinks, rebuild stale dists). The doctor's diagnosis is
 * self-truing — pulls update src mtimes (stale dist) and package.json deps (missing install) —
 * so no changed-file bookkeeping is needed.
 *
 * ie: `npx sync-workspace --repos=chat,flow`
 *
 * Optional args:
 *
 * --repos=chat,flow   pull only these repos (dir names under packages/); default: all submodules
 */
export const syncWorkspace = async () => {
  const cw = new LogColorWrapper();
  const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('sync', secondaryLogColor) });
  const args = getArgs();
  const workspacePath = await WorkspaceDoctor.findWorkspaceRoot(process.cwd());

  if (args.repos && args.repos.length > 0) {
    for (const repo of args.repos) {
      const repoPath = path.join(workspacePath, 'packages', repo);
      try {
        await fs.access(path.join(repoPath, '.git'));
      } catch {
        throw new Error(`Repo (${repo}) does not exist at ${repoPath}`);
      }
      logger.info({ message: `> Pulling ${cw.color(repo, secondaryLogColor)}` });
      await cmd('git', ['pull'], { cwd: repoPath }, { logPrefix: `[${repo}] ` });
      // Nested submodules (e.g. proteinjs is itself a metarepo) ride their own branch tips.
      await cmd(
        'git',
        ['submodule', 'foreach', '--recursive', 'git', 'pull'],
        { cwd: repoPath },
        { logPrefix: `[${repo}] ` }
      );
    }
  } else {
    logger.info({ message: `> Pulling all workspace repos` });
    await cmd('git', ['submodule', 'foreach', '--recursive', 'git', 'pull'], { cwd: workspacePath });
  }

  logger.info({ message: `> Verifying + fixing workspace coherence` });
  const doctor = new WorkspaceDoctor(workspacePath);
  const findings = await doctor.diagnose();
  if (findings.length === 0) {
    logger.info({ message: `> Workspace coherent — nothing to fix` });
    return;
  }
  const remaining = await doctor.fix(findings);
  if (remaining.length > 0) {
    for (const finding of remaining) {
      logger.error({
        message: `[${cw.color(finding.packageName, secondaryLogColor)}] ${finding.kind}: ${finding.detail}\n    fix: ${finding.remediation}`,
      });
    }
    logger.error({ message: `> ${remaining.length} finding(s) could not be auto-fixed` });
    process.exit(1);
  }
  logger.info({ message: `> Workspace coherent (fixed ${findings.length} finding(s))` });
};

type Args = {
  repos?: string[];
};

function getArgs() {
  const args: Args = {};
  const argsMap = parseArgsMap(process.argv.slice(2));
  for (const argName in argsMap) {
    const argValue = argsMap[argName];
    if (argName == 'repos' && typeof argValue === 'string') {
      args.repos = argValue.split(',');
    }
  }

  return args;
}
