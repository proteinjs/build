import { ArgsMap, LogColorWrapper, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { EstateReaper, EstateReaperOptions, EstateSweepReport, ReapEstatesResult } from './EstateReaper';
import { EstateDatabaseSweep } from './EstateDatabaseSweep';
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
--db-fence=<project>/<instance>/<prefix>
                       enable the DATABASE class (DEV_ESTATES.md §3.3): a reaped estate's \`databases\`
                       (rows record <project>/<instance>/<database>) drop with it, and fenced databases
                       that NO registered estate names drop once older than --db-orphan-days. Never a
                       name outside the prefix, never a database a row names (pins protect it), never
                       an unaged one. Without a fence the class is inert and says so. The client is
                       borrowed from the estates' own app installs; the credential is GCP_SA_KEY from
                       the environment (source ~/.zshrc) — nothing about it is ever printed.
                       ie: --db-fence=n3xa-app/n3xa-dev/est-
--db-orphan-days=<n>   the orphan horizon in days (default 7)
--db-client-from=<dir>[,<dir>]
                       durable dirs to borrow @google-cloud/spanner from, tried after the cwd and the
                       registered estates' own dirs — the scheduled job's cwd has no app install, and
                       once the estates that would lend the client are reaped the orphan sweep would
                       otherwise be inert in the very case it exists for.
                       ie: --db-client-from=/Users/<you>/repos/farm/n3xa2/packages/app/packages/server
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
  const options = reapEstatesOptions(argsMap);
  const apply = !!options.apply;
  const owner = options.owner;
  const reaper = new EstateReaper(options);
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
    printDatabases(result, logger);
    if (worktreeResult) {
      const removable = worktreeResult.worktrees.filter((worktree) => worktree.verdict === 'safe' && !worktree.primary);
      logger.info({
        message: `> Worktree pass (clean-worktrees): ${removable.length} safe worktree${removable.length !== 1 ? 's' : ''}, ${EstateReaper.formatBytes(worktreeResult.reclaimedBytes)} ${apply ? 'reclaimed' : 'reclaimable'}`,
      });
    }
  }

  const failures = result.reports.filter((report) => report.verdict === 'failed').length;
  if (failures > 0 || (result.databases?.refusals.length ?? 0) > 0) {
    process.exit(1);
  }
};

/** The CLI flags as the reaper's options — the one place the flag surface maps onto {@link EstateReaperOptions}. */
export function reapEstatesOptions(argsMap: ArgsMap): EstateReaperOptions {
  const stringArg = (name: string) => (typeof argsMap[name] === 'string' ? (argsMap[name] as string) : undefined);
  const ttlHours = stringArg('ttl') !== undefined ? Number(stringArg('ttl')) : undefined;
  if (ttlHours !== undefined && (!Number.isFinite(ttlHours) || ttlHours <= 0)) {
    throw new Error(`--ttl must be a positive number of hours, got: ${argsMap['ttl']}`);
  }
  const fenceArg = stringArg('db-fence');
  const fence = fenceArg !== undefined ? EstateDatabaseSweep.parseFence(fenceArg) : undefined;
  const orphanDays = stringArg('db-orphan-days') !== undefined ? Number(stringArg('db-orphan-days')) : undefined;
  if (orphanDays !== undefined && (!Number.isFinite(orphanDays) || orphanDays <= 0)) {
    throw new Error(`--db-orphan-days must be a positive number of days, got: ${argsMap['db-orphan-days']}`);
  }
  if (orphanDays !== undefined && !fence) {
    throw new Error('--db-orphan-days needs --db-fence=<project>/<instance>/<prefix>');
  }
  const clientFrom = stringArg('db-client-from')
    ?.split(',')
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
  if (clientFrom !== undefined && !fence) {
    throw new Error('--db-client-from needs --db-fence=<project>/<instance>/<prefix>');
  }
  return {
    apply: argsMap['apply'] === true,
    owner: stringArg('owner'),
    ttlMs: ttlHours !== undefined ? ttlHours * 3600_000 : undefined,
    databases: fence
      ? {
          fence,
          orphanAfterMs: orphanDays !== undefined ? orphanDays * 24 * 3600_000 : undefined,
          resolvePaths: clientFrom,
        }
      : undefined,
  };
}

function printDatabases(result: ReapEstatesResult, logger: Logger) {
  const databases = result.databases;
  if (!databases) {
    return;
  }
  if (databases.skipped) {
    logger.warn({ message: `> Databases: ${databases.skipped}` });
    return;
  }
  logger.info({
    message: `> Databases (orphan sweep): ${databases.acts.length} ${result.apply ? 'dropped' : 'to drop'}, ${databases.kept.length} kept`,
  });
  for (const act of databases.acts) {
    logger.info({ message: `           act: ${act}${result.apply ? '' : ' (dry-run)'}` });
  }
  for (const kept of databases.kept) {
    logger.info({ message: `           kept: ${kept}` });
  }
  for (const refusal of databases.refusals) {
    logger.warn({ message: `           refusal: ${refusal}` });
  }
}

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
