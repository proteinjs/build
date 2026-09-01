import { LogColorWrapper, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { EstateReaper, EstateSweepReport } from './EstateReaper';
import { EstateRegistry } from './EstateRegistry';
import { WorktreeCleaner } from './WorktreeCleaner';
import { WorkspaceDoctor } from './WorkspaceDoctor';
import { primaryLogColor, secondaryLogColor } from './logColors';

const HELP = `reap-estates — sweep DEAD estates (RESOURCE_GOVERNANCE §B.2; PROCESS.md hygiene ruling, mechanized)

Sweeps the estate registry (~/.n3xa/estates/) on schedule and on demand. The safety rules are the
ruling's, mechanized — refusals are LISTED, never overridden, and there is no --force:

  - only REGISTERED estates are touched; a fresh heartbeat (< 36h TTL) spares the estate
  - never a serving instance: an answering port or a live cwd-verified pid spares it (surfaced, not killed —
    locally there are NO automatic kills, ever)
  - never unpushed git work: uncommitted non-lock dirt, stashes, or commits missing upstream
    (ancestry + patch-id equivalence) refuse the dir; mixed estates reap their clean parts and
    keep the record trimmed to the refusals
  - every reap is logged with what/why (stdout + ~/.n3xa/logs/reap.log)

Worktree lifecycle stays with clean-worktrees (no second owner): this command runs the same
WorktreeCleaner pass afterwards unless --no-worktrees.

Default is a DRY-RUN report. ie: \`npm run reap-estates\` (report), \`npm run reap-estates -- --apply\`

Optional args:

--apply                actually reap (kill nothing; delete dirs, stop+rm containers, prune registrations)
--owner=<label>        owner-scoped EXIT sweep: TTL waived and the estate's own cwd-verified pids are
                       killed — the owner reaping its own estate at lane exit (the one-liner lane
                       briefs mandate). Safety rules on dirs still apply.
--ttl=<hours>          dead-by-contract heartbeat TTL (default 36)
--no-worktrees         skip the delegated clean-worktrees pass
--root=/path           workspace root for the worktree pass (default: discovered from cwd)
--json                 machine-readable result on stdout
--help                 this text
`;

/** The `reap-estates` CLI — the scheduled/on-demand door over {@link EstateReaper}. */
export const reapEstates = async () => {
  const cw = new LogColorWrapper();
  const logger = new Logger({
    name: cw.color('workspace:', primaryLogColor) + cw.color('reap-estates', secondaryLogColor),
  });
  const argsMap = parseArgsMap(process.argv.slice(2));
  if (argsMap['help']) {
    console.log(HELP);
    return;
  }
  const apply = argsMap['apply'] === true;
  const owner = typeof argsMap['owner'] === 'string' ? (argsMap['owner'] as string) : undefined;
  const ttlHours = typeof argsMap['ttl'] === 'string' ? Number(argsMap['ttl']) : undefined;
  if (ttlHours !== undefined && (!Number.isFinite(ttlHours) || ttlHours <= 0)) {
    throw new Error(`--ttl must be a positive number of hours, got: ${argsMap['ttl']}`);
  }

  const reaper = new EstateReaper({ apply, owner, ttlMs: ttlHours !== undefined ? ttlHours * 3600_000 : undefined });
  const result = await reaper.sweep();

  let worktreeResult;
  if (argsMap['no-worktrees'] !== true) {
    try {
      const workspaceRoot =
        typeof argsMap['root'] === 'string'
          ? (argsMap['root'] as string)
          : await WorkspaceDoctor.findWorkspaceRoot(process.cwd());
      // Registered estates' dirs are the estate reaper's jurisdiction (heartbeats, pins, liveness
      // grammar) — the worktree pass must never sweep inside them (single owner per dir).
      const { estates } = await new EstateRegistry().list();
      const estateDirs: string[] = [];
      for (const estate of estates) {
        for (const dir of estate.dirs) {
          if (estateDirs.indexOf(dir) === -1) {
            estateDirs.push(dir);
          }
        }
      }
      worktreeResult = await new WorktreeCleaner({ workspaceRoot, apply, keep: estateDirs }).clean();
    } catch (error) {
      logger.warn({
        message: `> Worktree pass skipped: ${error instanceof Error ? error.message : error} (run clean-worktrees --root=... directly)`,
      });
    }
  }

  if (argsMap['json'] === true) {
    console.log(JSON.stringify({ estates: result, worktrees: worktreeResult }, null, 2));
  } else {
    printReport(result.reports, result.unreadable, apply, owner, logger, cw);
    if (worktreeResult) {
      const removable = worktreeResult.worktrees.filter((worktree) => worktree.verdict === 'safe' && !worktree.primary);
      logger.info({
        message: `> Worktree pass (clean-worktrees): ${removable.length} safe worktree${removable.length !== 1 ? 's' : ''}, ${EstateReaper.formatBytes(worktreeResult.reclaimedBytes)} ${apply ? 'reclaimed' : 'reclaimable'}`,
      });
    }
  }

  const failures = result.reports.filter((report) => report.verdict === 'failed').length;
  if (failures > 0) {
    process.exit(1);
  }
};

function printReport(
  reports: EstateSweepReport[],
  unreadable: string[],
  apply: boolean,
  owner: string | undefined,
  logger: Logger,
  cw: LogColorWrapper
) {
  const scope = owner ? ` (owner sweep: ${owner})` : '';
  logger.info({
    message: `> ${apply ? 'Sweep' : 'Dry-run sweep'}${scope}: ${reports.length} estate${reports.length !== 1 ? 's' : ''} considered`,
  });
  for (const report of reports) {
    const label =
      report.verdict === 'reaped'
        ? '[REAPED] '
        : report.verdict === 'partial'
          ? '[PARTIAL]'
          : report.verdict === 'failed'
            ? '[FAILED] '
            : '[SPARED] ';
    logger.info({
      message: `${label} ${cw.color(report.estate.id, secondaryLogColor)} (owner ${report.estate.owner}) — ${report.reason}`,
    });
    for (const act of report.acts) {
      logger.info({ message: `           act: ${act}${apply ? '' : ' (dry-run)'}` });
    }
    for (const refusal of report.refusals) {
      logger.warn({ message: `           refusal: ${refusal}` });
    }
  }
  for (const unreadablePath of unreadable) {
    logger.warn({ message: `> UNREADABLE estate file (never touched): ${unreadablePath}` });
  }
  const reclaimed = reports.reduce((sum, report) => sum + (report.reclaimedBytes ?? 0), 0);
  logger.info({
    message: `> ${apply ? 'Reclaimed' : 'Would reclaim'} ${EstateReaper.formatBytes(reclaimed)} across ${reports.filter((r) => r.verdict === 'reaped' || r.verdict === 'partial').length} estate(s); receipts in ~/.n3xa/logs/reap.log`,
  });
}
