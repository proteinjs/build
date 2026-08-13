import * as path from 'path';
import * as fs from 'fs/promises';
import { LogColorWrapper, PackageUtil, parseArgsMap, cmd } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { WorkspaceDoctor, WorkspaceFinding } from './WorkspaceDoctor';
import { PullFailure, assertWorkspaceReposExist, visitWorkspaceRepos } from './syncWorkspace';
import { materializeDependencies } from './materializeDependencies';
import { primaryLogColor, secondaryLogColor } from './logColors';

/**
 * Fast-forward workspace repos to their upstreams without judging local work: fetch every repo,
 * `merge --ff-only` the ones strictly behind, and REPORT the rest. Local commits are session
 * intent — an agent's in-flight lane, a branch parked mid-thought — so a diverged or ahead repo
 * is never rebased, reset, or treated as an error: it gets a report line and the sweep moves on.
 * Detached-HEAD and no-upstream repos are likewise reported and left untouched. Only command
 * failures (network, a refused fetch or merge) fail the run.
 *
 * Fast-forwards can land dependency changes; each fast-forwarded repo's old..new diff is scanned
 * for package.json / package-lock.json and the owning packages get npm install + re-symlink, so
 * pulled manifest changes are materialized even when node_modules already has a (stale) entry —
 * the doctor only checks entry EXISTENCE, so a version bump would otherwise slip through. The
 * run finishes with the verify-workspace --fix gate (diagnose → fix → re-diagnose): exit 0
 * certifies the tree coherent AND every repo either at its upstream tip or intentionally
 * elsewhere.
 *
 * ie: `npx pull-forward --repos=chat,flow`
 *
 * Optional args:
 *
 * --repos=chat,flow   pull only these repos (dir names under packages/); default: all submodules
 * --root=/path        workspace root override; default: resolved upward from cwd
 */
export const pullForward = async () => {
  const cw = new LogColorWrapper();
  const logger = new Logger({
    name: cw.color('workspace:', primaryLogColor) + cw.color('pull-forward', secondaryLogColor),
  });
  const args = getArgs();
  const workspacePath = args.root ? path.resolve(args.root) : await WorkspaceDoctor.findWorkspaceRoot(process.cwd());

  if (args.repos && args.repos.length > 0) {
    await assertWorkspaceReposExist(workspacePath, args.repos);
    logger.info({
      message: `> Pulling forward ${args.repos.map((r) => cw.color(r, secondaryLogColor)).join(', ')}`,
    });
  } else {
    logger.info({ message: `> Pulling forward all workspace repos` });
  }

  const report = await pullForwardWorkspace(workspacePath, args.repos);
  logSummary(logger, cw, report);
  if (!report.ok) {
    process.exit(1);
  }
};

export type RepoPullResult =
  | {
      /** Workspace-relative repo path (e.g. `packages/util`). */
      repoPath: string;
      status: 'fast-forwarded';
      oldHead: string;
      newHead: string;
    }
  | { repoPath: string; status: 'ahead' | 'diverged'; ahead: number; behind: number }
  | { repoPath: string; status: 'up-to-date' | 'detached' | 'no-upstream' };

export type InstallFailure = {
  packageName: string;
  /** The npm/symlink error, stderr-first — what a human needs to resolve it. */
  detail: string;
};

export type PullForwardReport = {
  /** True iff no pull failures, no install failures, and no remaining doctor findings. */
  ok: boolean;
  repos: RepoPullResult[];
  pullFailures: PullFailure[];
  /** Packages whose manifests moved in a fast-forward, reinstalled + re-symlinked. */
  installedPackages: string[];
  installFailures: InstallFailure[];
  findingsFixed: number;
  remainingFindings: WorkspaceFinding[];
};

/**
 * Fast-forward a repo set (each named repo plus its nested submodules, or every workspace
 * submodule when none are named), materialize manifest changes the fast-forwards landed, then
 * run the doctor gate. Collects failures instead of throwing so one wedged repo or package
 * cannot strand the rest of the sweep; `ok` is the single exit-code signal.
 */
export const pullForwardWorkspace = async (workspacePath: string, repos?: string[]): Promise<PullForwardReport> => {
  const repoResults: RepoPullResult[] = [];
  const pullFailures: PullFailure[] = [];
  await visitWorkspaceRepos(workspacePath, repos, async (repoPath) => {
    const { result, failure } = await pullForwardRepo(workspacePath, repoPath);
    if (result) {
      repoResults.push(result);
    }
    if (failure) {
      pullFailures.push(failure);
    }
  });

  const { installedPackages, installFailures } = await installChangedManifests(workspacePath, repoResults);

  const doctor = new WorkspaceDoctor(workspacePath);
  const findings = await doctor.diagnose();
  const remainingFindings = findings.length === 0 ? [] : await doctor.fix(findings);

  return {
    ok: pullFailures.length === 0 && installFailures.length === 0 && remainingFindings.length === 0,
    repos: repoResults,
    pullFailures,
    installedPackages,
    installFailures,
    findingsFixed: findings.length - remainingFindings.length,
    remainingFindings,
  };
};

/**
 * Classify one repo against its upstream and fast-forward only the strictly-behind case.
 * Classification (detached, no-upstream, ahead/diverged counts) never mutates. Every git failure
 * — a broken repo that cannot even classify, a refused fetch or merge — comes back as a
 * `PullFailure`, never a throw: this is the per-repo seam the sweep collects at, so one wedged
 * repo cannot crash the run and lose the other repos' results.
 */
const pullForwardRepo = async (
  workspacePath: string,
  repoPath: string
): Promise<{ result?: RepoPullResult; failure?: PullFailure }> => {
  const display = path.relative(workspacePath, repoPath) || '.';
  const git = (args: string[], log?: boolean) =>
    cmd(
      'git',
      args,
      { cwd: repoPath },
      log ? { logPrefix: `[${display}] ` } : { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }
    );

  try {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (branch === 'HEAD') {
      return { result: { repoPath: display, status: 'detached' } };
    }
    try {
      await git(['rev-parse', '--abbrev-ref', '@{u}']);
    } catch {
      return { result: { repoPath: display, status: 'no-upstream' } };
    }

    await git(['fetch'], true);
    const counts = (await git(['rev-list', '--left-right', '--count', '@{u}...HEAD'])).stdout.trim();
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    if (ahead > 0) {
      return { result: { repoPath: display, status: behind > 0 ? 'diverged' : 'ahead', ahead, behind } };
    }
    if (behind === 0) {
      return { result: { repoPath: display, status: 'up-to-date' } };
    }
    const oldHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    // --autostash: builds churn package-lock.json in working trees, and an ff merge refuses when
    // the incoming commits touch a locally-dirty file (CI release commits touch the same
    // lockfiles) — same failure class and same remedy as sync-workspace's rebase pull.
    await git(['merge', '--ff-only', '--autostash', '@{u}'], true);
    const newHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    return { result: { repoPath: display, status: 'fast-forwarded', oldHead, newHead } };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    return { failure: { repoPath: display, detail: (err.stderr?.trim() || err.message).trim() } };
  }
};

/**
 * npm install + re-symlink every workspace package whose package.json or package-lock.json
 * changed in a fast-forward. Deduped by package dir; dependency order is irrelevant here
 * (installs are per-package and symlinks only point at the live tree).
 */
const installChangedManifests = async (
  workspacePath: string,
  repoResults: RepoPullResult[]
): Promise<{ installedPackages: string[]; installFailures: InstallFailure[] }> => {
  const installedPackages: string[] = [];
  const installFailures: InstallFailure[] = [];
  const changedPackageDirs = new Set<string>();
  for (const repo of repoResults) {
    if (repo.status !== 'fast-forwarded') {
      continue;
    }
    const repoAbsPath = path.join(workspacePath, repo.repoPath);
    const diff = await cmd(
      'git',
      ['diff', '--name-only', `${repo.oldHead}..${repo.newHead}`],
      { cwd: repoAbsPath },
      { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }
    );
    for (const file of diff.stdout.split('\n')) {
      const basename = path.basename(file.trim());
      if (basename !== 'package.json' && basename !== 'package-lock.json') {
        continue;
      }
      // realpath both here and at lookup below: any segment of the workspace path may itself be
      // a symlink (e.g. macOS /var -> /private/var), and dir identity is the match key.
      try {
        changedPackageDirs.add(await fs.realpath(path.join(repoAbsPath, path.dirname(file.trim()))));
      } catch {
        // manifest deleted along with its dir — nothing to install
      }
    }
  }
  if (changedPackageDirs.size === 0) {
    return { installedPackages, installFailures };
  }

  const metadata = await PackageUtil.getWorkspaceMetadata(workspacePath);
  for (const packageName of metadata.sortedPackageNames) {
    const localPackage = metadata.packageMap[packageName];
    const packageDir = path.dirname(localPackage.filePath);
    if (!changedPackageDirs.has(await fs.realpath(packageDir))) {
      continue;
    }
    try {
      await materializeDependencies(packageDir, { logPrefix: `[${packageName}] ` });
      await PackageUtil.symlinkDependencies(localPackage, metadata.packageMap);
      installedPackages.push(packageName);
    } catch (e) {
      const err = e as Error & { stderr?: string };
      installFailures.push({ packageName, detail: (err.stderr?.trim() || err.message).trim() });
    }
  }
  return { installedPackages, installFailures };
};

const logSummary = (logger: Logger, cw: LogColorWrapper, report: PullForwardReport) => {
  for (const repo of report.repos) {
    if (repo.status === 'fast-forwarded') {
      logger.info({
        message: `> Fast-forwarded ${cw.color(repo.repoPath, secondaryLogColor)} (${repo.oldHead.slice(0, 7)}..${repo.newHead.slice(0, 7)})`,
      });
    } else if (repo.status === 'ahead' || repo.status === 'diverged') {
      logger.info({
        message: `> Left untouched ${cw.color(repo.repoPath, secondaryLogColor)}: ${repo.status} (ahead ${repo.ahead}, behind ${repo.behind})`,
      });
    } else if (repo.status !== 'up-to-date') {
      logger.info({ message: `> Left untouched ${cw.color(repo.repoPath, secondaryLogColor)}: ${repo.status}` });
    }
  }
  if (report.installedPackages.length > 0) {
    logger.info({
      message: `> Reinstalled ${report.installedPackages.map((p) => cw.color(p, secondaryLogColor)).join(', ')}`,
    });
  }
  for (const failure of report.pullFailures) {
    logger.error({ message: `[${cw.color(failure.repoPath, secondaryLogColor)}] pull failed:\n${failure.detail}` });
  }
  for (const failure of report.installFailures) {
    logger.error({
      message: `[${cw.color(failure.packageName, secondaryLogColor)}] install failed:\n${failure.detail}`,
    });
  }
  for (const finding of report.remainingFindings) {
    logger.error({
      message: `[${cw.color(finding.packageName, secondaryLogColor)}] ${finding.kind}: ${finding.detail}\n    fix: ${finding.remediation}`,
    });
  }
  if (report.ok) {
    logger.info({
      message: `> Workspace coherent${report.findingsFixed > 0 ? ` (fixed ${report.findingsFixed} finding(s))` : ''}`,
    });
  } else {
    logger.error({
      message: `> pull-forward failed: ${report.pullFailures.length} pull failure(s), ${report.installFailures.length} install failure(s), ${report.remainingFindings.length} unfixed finding(s)`,
    });
  }
};

type Args = {
  repos?: string[];
  root?: string;
};

function getArgs() {
  const args: Args = {};
  const argsMap = parseArgsMap(process.argv.slice(2));
  for (const argName in argsMap) {
    const argValue = argsMap[argName];
    if (argName == 'repos' && typeof argValue === 'string') {
      args.repos = argValue.split(',');
    } else if (argName == 'root' && typeof argValue === 'string') {
      args.root = argValue;
    }
  }

  return args;
}
