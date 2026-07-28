import { LogColorWrapper, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { WorkspaceDoctor, WorkspaceFinding } from './WorkspaceDoctor';
import { primaryLogColor, secondaryLogColor } from './logColors';

/**
 * Verify workspace coherence: workspace symlinks intact, declared deps installed, dists fresh.
 * Exits 1 with a loud, named report when incoherent — the boot-assertion contract (chain it in
 * front of a dev server start so stale code can never be served silently).
 *
 * ie: `npx verify-workspace --for=@n3xa/app-server,@n3xa/app-ui`
 *
 * Optional args:
 *
 * --for=@some/package,@another/package  scope to these packages + their transitive closures
 * --fix                                 apply remediations (install → re-symlink → build), in dependency order
 * --json                                machine-readable findings on stdout
 * --root=/path/to/workspace             override workspace root discovery (default: outermost
 *                                       ancestor of cwd with a package.json)
 */
export const verifyWorkspace = async () => {
  const cw = new LogColorWrapper();
  const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('verify', secondaryLogColor) });
  const args = getArgs();
  const workspacePath = args.root ?? (await WorkspaceDoctor.findWorkspaceRoot(process.cwd()));
  const doctor = new WorkspaceDoctor(workspacePath);

  let findings = await doctor.diagnose(args.for);
  if (findings.length > 0 && args.fix) {
    logger.info({ message: `> Fixing ${findings.length} finding${findings.length !== 1 ? 's' : ''}` });
    findings = await doctor.fix(findings, args.for);
  }

  if (args.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else if (findings.length === 0) {
    logger.info({
      message: `> Workspace coherent (${workspacePath}${args.for ? `, scoped to ${args.for.join(', ')}` : ''})`,
    });
  } else {
    for (const finding of findings) {
      logger.error({
        message: `[${cw.color(finding.packageName, secondaryLogColor)}] ${finding.kind}: ${finding.detail}\n    fix: ${finding.remediation}`,
      });
    }
    logger.error({
      message: `> Workspace INCOHERENT — ${findings.length} finding${findings.length !== 1 ? 's' : ''} (${workspacePath}). Run with --fix, or apply the per-finding fixes above.`,
    });
  }

  if (findings.length > 0) {
    process.exit(1);
  }
};

type Args = {
  for?: string[];
  fix?: boolean;
  json?: boolean;
  root?: string;
};

function getArgs() {
  const args: Args = {};
  const argsMap = parseArgsMap(process.argv.slice(2));
  for (const argName in argsMap) {
    const argValue = argsMap[argName];
    if (argName == 'for' && typeof argValue === 'string') {
      args.for = argValue.split(',');
    } else if (argName == 'fix') {
      args.fix = true;
    } else if (argName == 'json') {
      args.json = true;
    } else if (argName == 'root' && typeof argValue === 'string') {
      args.root = argValue;
    }
  }

  return args;
}

export type { WorkspaceFinding };
