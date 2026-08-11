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
 * Pulls run `git pull --rebase --autostash`: builds churn package-lock.json files in working
 * trees, and a plain rebase pull refuses over any unstaged change — each affected repo then
 * silently stays stale while the sweep continues. Autostash carries local changes across the
 * rebase and restores them after, so lockfile noise can never strand a repo. Repos that still
 * fail to pull (detached HEAD, divergence, network) are collected and reported together at the
 * end — one wedged repo does not stop the rest of the sweep — and sync exits nonzero without
 * running the doctor, since a half-pulled tree should not be certified coherent.
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
    }
    logger.info({ message: `> Pulling ${args.repos.map((r) => cw.color(r, secondaryLogColor)).join(', ')}` });
  } else {
    logger.info({ message: `> Pulling all workspace repos` });
  }

  const failures = await pullWorkspaceRepos(workspacePath, args.repos);
  if (failures.length > 0) {
    for (const failure of failures) {
      logger.error({
        message: `[${cw.color(failure.repoPath, secondaryLogColor)}] pull failed:\n${failure.detail}`,
      });
    }
    logger.error({ message: `> ${failures.length} repo(s) failed to pull — resolve and re-run sync-workspace` });
    process.exit(1);
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

export type PullFailure = {
  /** Workspace-relative repo path (e.g. `packages/util`, `packages/proteinjs/packages/util`). */
  repoPath: string;
  /** The git error, stderr-first — what a human needs to resolve the wedge. */
  detail: string;
};

/**
 * Pull a repo set to its branch tips: each named repo (or every workspace submodule when none
 * are named) plus its nested submodules, recursively. Returns per-repo failures instead of
 * throwing so one wedged repo cannot strand the rest of the sweep unpulled.
 */
export const pullWorkspaceRepos = async (workspacePath: string, repos?: string[]): Promise<PullFailure[]> => {
  const failures: PullFailure[] = [];
  const pullOne = async (repoPath: string) => {
    const display = path.relative(workspacePath, repoPath) || '.';
    try {
      await cmd('git', ['pull', '--rebase', '--autostash'], { cwd: repoPath }, { logPrefix: `[${display}] ` });
    } catch (e) {
      const err = e as Error & { stderr?: string };
      failures.push({ repoPath: display, detail: (err.stderr?.trim() || err.message).trim() });
    }
  };

  const roots =
    repos && repos.length > 0 ? repos.map((repo) => path.join(workspacePath, 'packages', repo)) : [workspacePath];
  for (const root of roots) {
    // The workspace root itself is not pulled in all-repos mode (same scope as before); a named
    // repo is pulled directly. Parents pull before their nested submodules are enumerated, so
    // the sweep sees each repo's post-pull submodule set.
    if (root !== workspacePath) {
      await pullOne(root);
    }
    for (const submodulePath of await listInitializedSubmodules(root)) {
      await pullOne(submodulePath);
    }
  }
  return failures;
};

/** Initialized submodule paths under repoPath, recursive — uninitialized (`-` prefixed) entries
 * have no checkout to pull and are skipped, matching `git submodule foreach` scope. */
const listInitializedSubmodules = async (repoPath: string): Promise<string[]> => {
  const result = await cmd(
    'git',
    ['submodule', 'status', '--recursive'],
    { cwd: repoPath },
    { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }
  );
  const paths: string[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim() || line.startsWith('-')) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      paths.push(path.join(repoPath, parts[1]));
    }
  }
  return paths;
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
