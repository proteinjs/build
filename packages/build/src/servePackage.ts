import * as readline from 'readline';
import { LogColorWrapper, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { ServePackageSupervisor } from './ServePackageSupervisor';
import { primaryLogColor, secondaryLogColor } from './logColors';

/**
 * Supervise a package's dev process: restart it when its transitive workspace closure's dists
 * change, deferring while holds are active (see ServePackageSupervisor for the holds protocol).
 *
 * ie: `SERVER_PORT=3002 npx serve-package @n3xa/app-server -- node dist/generated/index.js`
 *
 * The command after `--` runs in the package's directory with the caller's env passed through
 * verbatim (ports/db names stay the caller's concern), plus SERVE_PACKAGE_IPC pointing at the
 * supervisor's control dir. Force a restart anytime with `rs` + enter, or
 * `kill -USR2 $(cat <packageDir>/.serve-package/pid)`.
 *
 * Optional args (before `--`):
 *
 * --poll=2000       dist mtime poll interval (ms)
 * --quiet=1500      quiet period after the last dist change before restarting (ms)
 * --grace=10000     SIGTERM→SIGKILL grace when stopping the child (ms)
 * --root=/path      override workspace root discovery (default: outermost ancestor of cwd
 *                   with a package.json)
 */
export const servePackage = async () => {
  const cw = new LogColorWrapper();
  const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('serve', secondaryLogColor) });
  const args = getArgs();
  if (!args.packageName || args.command.length === 0) {
    logger.error({
      message: `Usage: serve-package <packageName> [--poll=ms] [--quiet=ms] [--grace=ms] [--root=path] -- <command...>`,
    });
    process.exit(1);
  }
  const supervisor = new ServePackageSupervisor({
    packageName: args.packageName,
    command: args.command,
    workspacePath: args.root,
    pollMs: args.poll,
    quietMs: args.quiet,
    graceMs: args.grace,
    onChildExit: (code) => process.exit(code),
  });

  // Process wiring lives here so the supervisor class stays a pure, testable mechanism.
  process.on('SIGUSR2', () => void supervisor.restart('SIGUSR2'));
  const shutdown = () => void supervisor.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim() === 'rs') {
      void supervisor.restart('rs');
    }
  });

  await supervisor.start();
};

type Args = {
  packageName?: string;
  command: string[];
  poll?: number;
  quiet?: number;
  grace?: number;
  root?: string;
};

function getArgs() {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  const args: Args = { command };
  const positional = own.filter((a) => !a.startsWith('--'));
  args.packageName = positional[0];
  const argsMap = parseArgsMap(own.filter((a) => a.startsWith('--')));
  for (const argName in argsMap) {
    const argValue = argsMap[argName];
    if (argName == 'poll' && typeof argValue === 'string') {
      args.poll = parseMs('poll', argValue);
    } else if (argName == 'quiet' && typeof argValue === 'string') {
      args.quiet = parseMs('quiet', argValue);
    } else if (argName == 'grace' && typeof argValue === 'string') {
      args.grace = parseMs('grace', argValue);
    } else if (argName == 'root' && typeof argValue === 'string') {
      args.root = argValue;
    }
  }

  return args;
}

/** A typo like `--poll=2s` would otherwise become NaN and a ~1ms hot loop. */
function parseMs(argName: string, argValue: string): number {
  const ms = Number(argValue);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`--${argName} must be a positive number of milliseconds, got: ${argValue}`);
  }
  return ms;
}
