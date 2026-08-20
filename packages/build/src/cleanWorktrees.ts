import * as path from 'path';
import { LogColorWrapper, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { WorktreeCleaner, CleanWorktreesResult, WorktreeReport, KEEP_MARKER_FILENAME } from './WorktreeCleaner';
import { WorkspaceDoctor } from './WorkspaceDoctor';
import { primaryLogColor, secondaryLogColor } from './logColors';

const HELP = `clean-worktrees — worktree lifecycle sweep (PROCESS.md "Temp and workspace hygiene", ruled 2026-08-20)

Worktree cleanup is part of the RELEASE PROCESS: a lane/leg worktree is reclaimable the moment its
commits are train-visible (commits live in the repo's shared object store — deleting a worktree never
deletes commits). Train close-out runs this sweep + prune across touched repos.

This CLI is the operator door over the shared WorktreeCleaner core. The n3xa dev skill's workspace
model inherits the same lifecycle: its workspace-management tooling (the product door) runs the SAME
classifier against the workspaces/worktrees the skill manages.

Enumerate -> classify -> remove -> prune -> report:
  safe     tip commit verified in the object store, no uncommitted non-lockfile dirt, not pinned.
           Lockfile-only dirt counts as clean (local lock regens are never shipped).
  pinned   never removed: primary checkouts, git-locked worktrees, uncommitted real dirt, a live
           process holding paths inside (lsof), --keep paths, or a ${KEEP_MARKER_FILENAME} marker file.
  unknown  reported, never touched: broken registrations, git failures, or an unavailable
           process-hold snapshot.

Default is a DRY-RUN report with measured sizes. Reclaim totals are measured (du), never estimated.

ie: \`npm run clean-worktrees\` (report), \`npm run clean-worktrees -- --apply\` (remove + prune)

Optional args:

--apply                       actually remove safe worktrees and prune registrations (default: dry-run)
--keep=/path/a,/path/b        pin these worktree paths for this run (durable pin: drop a
                              ${KEEP_MARKER_FILENAME} file at the worktree root)
--scan=/path/a,/path/b        roots to scan for worktree checkouts besides the workspace itself.
                              Default: the session scratchpad root (/tmp/claude-<uid>); an explicit
                              --scan REPLACES the default (--scan= scans the workspace only)
--root=/path/to/workspace     override workspace root discovery (default: outermost ancestor of cwd
                              with a package.json)
--json                        machine-readable result on stdout
--help                        this text
`;

/**
 * The metarepo CLI door over {@link WorktreeCleaner}: enumerate -> classify -> remove -> prune ->
 * report. See HELP for the lifecycle contract; dev-skill tooling consumes the same core directly.
 */
export const cleanWorktrees = async () => {
  const cw = new LogColorWrapper();
  const logger = new Logger({
    name: cw.color('workspace:', primaryLogColor) + cw.color('clean-worktrees', secondaryLogColor),
  });
  const args = getArgs();
  if (args.help) {
    console.log(HELP);
    return;
  }

  const workspaceRoot = args.root ?? (await WorkspaceDoctor.findWorkspaceRoot(process.cwd()));
  // An explicit --scan replaces the session-scratchpad default (so isolated runs are possible).
  const scanRoots = args.scan ?? defaultScanRoots();
  const cleaner = new WorktreeCleaner({
    workspaceRoot,
    scanRoots,
    keep: args.keep,
    apply: args.apply,
  });
  const result = await cleaner.clean();

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result, workspaceRoot, logger, cw);
  }

  const failures = result.pruneErrors.length + result.worktrees.filter((worktree) => worktree.removed === false).length;
  if (failures > 0) {
    process.exit(1);
  }
};

type Args = {
  apply?: boolean;
  keep?: string[];
  scan?: string[];
  root?: string;
  json?: boolean;
  help?: boolean;
};

function getArgs() {
  const args: Args = {};
  const argsMap = parseArgsMap(process.argv.slice(2));
  for (const argName in argsMap) {
    const argValue = argsMap[argName];
    if (argName == 'apply') {
      args.apply = true;
    } else if (argName == 'keep' && typeof argValue === 'string') {
      args.keep = argValue.split(',');
    } else if (argName == 'scan' && typeof argValue === 'string') {
      args.scan = argValue.split(',').filter((scanPath) => scanPath.length > 0);
    } else if (argName == 'root' && typeof argValue === 'string') {
      args.root = argValue;
    } else if (argName == 'json') {
      args.json = true;
    } else if (argName == 'help') {
      args.help = true;
    }
  }

  return args;
}

/** The session-scratchpad convention root (/tmp/claude-<uid>), when this platform has one. */
function defaultScanRoots(): string[] {
  if (typeof process.getuid !== 'function') {
    return [];
  }
  return [path.join('/tmp', `claude-${process.getuid()}`)];
}

function printReport(result: CleanWorktreesResult, workspaceRoot: string, logger: Logger, cw: LogColorWrapper) {
  const primaries = result.worktrees.filter((worktree) => worktree.primary);
  const linked = result.worktrees.filter((worktree) => !worktree.primary);
  logger.info({
    message: `> Scanned ${workspaceRoot}: ${linked.length} linked worktree${linked.length !== 1 ? 's' : ''} (${primaries.length} primary checkout${primaries.length !== 1 ? 's' : ''} skipped)`,
  });

  for (const worktree of linked) {
    const label = worktree.verdict === 'safe' ? '[SAFE]   ' : worktree.verdict === 'pinned' ? '[PINNED] ' : '[UNKNOWN]';
    const branch = worktree.branch ? `branch ${worktree.branch}` : 'detached';
    const size = worktree.sizeBytes !== undefined ? formatBytes(worktree.sizeBytes) : 'size unmeasured';
    const outcome =
      worktree.removed === true
        ? ' [removed]'
        : worktree.removed === false
          ? ` [REMOVE FAILED: ${worktree.removeError}]`
          : '';
    logger.info({
      message: `${label} ${cw.color(worktree.path, secondaryLogColor)} (${branch}, ${size}) — ${worktree.reason}${outcome}`,
    });
  }

  const removable = linked.filter((worktree) => worktree.verdict === 'safe' && !worktree.pruneOnly);
  const unmeasuredNote = result.unmeasuredRemovals > 0 ? ` (+${result.unmeasuredRemovals} of unmeasured size)` : '';
  if (result.apply) {
    const removed = removable.filter((worktree) => worktree.removed === true);
    logger.info({
      message: `> Reclaimed ${formatBytes(result.reclaimedBytes)} (measured) across ${removed.length} removed worktree${removed.length !== 1 ? 's' : ''}${unmeasuredNote}. Pruned ${result.reposPruned.length} repo${result.reposPruned.length !== 1 ? 's' : ''}.`,
    });
    for (const pruneError of result.pruneErrors) {
      logger.error({ message: `> Prune failed for ${pruneError.gitDir}: ${pruneError.error}` });
    }
  } else {
    logger.info({
      message: `> Dry-run: would reclaim ${formatBytes(result.reclaimedBytes)} (measured) across ${removable.length} worktree${removable.length !== 1 ? 's' : ''}${unmeasuredNote}. Run with --apply to remove + prune.`,
    });
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.ceil(bytes / 1024)} KB`;
}

export type { CleanWorktreesResult, WorktreeReport };
