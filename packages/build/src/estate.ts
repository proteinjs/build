import { LogColorWrapper, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { EstateRecord, EstateRefusedError, EstateRegistry } from './EstateRegistry';
import { EstateReaper } from './EstateReaper';
import { primaryLogColor, secondaryLogColor } from './logColors';

const HELP = `estate — the local estate registry (RESOURCE_GOVERNANCE §B.1)

An ESTATE is the unit lanes launch and forget: ports, dirs (scratch/worktrees/logs), containers,
pids, an owner label, and a liveness heartbeat. One JSON file per estate under ~/.n3xa/estates/.
Registered estates are inside the machinery's automatic-act boundary (reap-estates sweeps
dead-by-contract ones); unregistered things are, by definition, outside it.

Registration is ambient where possible (serve-package registers and heartbeats its own estate);
this CLI is the door for launch scripts and manual glue.

Commands:

  estate register --owner=<label> [--id=<id>] [--ports=3041,9010] [--dirs=/a,/b]
                  [--containers=spanner-x] [--pids=123] [--databases=<project>/<instance>/<db>,...]
                  [--pin] [--note=...]
      Register (same id re-registers). Under HARD pressure (estate-watchdog's refusal flag)
      registration is REFUSED with the real numbers — reap or park before launching.
      --databases names the real databases the estate owns (dropped with it by reap-estates
      inside its --db-fence; see reap-estates --help).
  estate heartbeat --id=<id>          refresh the liveness heartbeat (stale > 36h = dead-by-contract)
  estate list [--json]                the machine's estates: owner, ports, dirs, containers, heartbeat age
  estate unregister --id=<id>         exit reaps the estate (cleanup-as-contract)
  estate pin --id=<id>                never auto-reaped (durable pin)
  estate unpin --id=<id>
  estate --help

ie: \`npm run estate -- register --owner=lane-touchbars --ports=3041 --dirs=/tmp/claude-501/lane-touchbars\`
`;

/** The `estate` CLI — the operator/launch-script door over {@link EstateRegistry}. */
export const estate = async () => {
  const cw = new LogColorWrapper();
  const logger = new Logger({ name: cw.color('workspace:', primaryLogColor) + cw.color('estate', secondaryLogColor) });
  const argv = process.argv.slice(2);
  const command = argv.find((arg) => !arg.startsWith('--'));
  const argsMap = parseArgsMap(argv.filter((arg) => arg.startsWith('--')));
  if (argsMap['help'] || !command) {
    console.log(HELP);
    return;
  }
  const registry = new EstateRegistry();
  const stringArg = (name: string) => (typeof argsMap[name] === 'string' ? (argsMap[name] as string) : undefined);
  const listArg = (name: string) =>
    stringArg(name)
      ?.split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  const numberListArg = (name: string) =>
    listArg(name)?.map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--${name} must be a comma-separated list of positive integers, got: ${value}`);
      }
      return parsed;
    });
  const requireId = () => {
    const id = stringArg('id');
    if (!id) {
      throw new Error(`--id is required for '${command}'`);
    }
    return id;
  };

  switch (command) {
    case 'register': {
      const owner = stringArg('owner');
      if (!owner) {
        throw new Error('--owner is required (lane/session label)');
      }
      try {
        const record = await registry.register({
          id: stringArg('id'),
          owner,
          ports: numberListArg('ports'),
          dirs: listArg('dirs'),
          containers: listArg('containers'),
          pids: numberListArg('pids'),
          databases: listArg('databases'),
          pinned: argsMap['pin'] === true,
          note: stringArg('note'),
        });
        logger.info({ message: `> Registered estate ${record.id} (owner ${record.owner})` });
      } catch (error) {
        if (error instanceof EstateRefusedError) {
          logger.error({ message: `> REFUSED: ${error.message}` });
          process.exit(2);
        }
        throw error;
      }
      return;
    }
    case 'heartbeat': {
      const updated = await registry.heartbeat(requireId());
      if (!updated) {
        throw new Error(`no such estate: ${stringArg('id')}`);
      }
      return;
    }
    case 'unregister': {
      const removed = await registry.unregister(requireId());
      logger.info({ message: removed ? `> Unregistered ${stringArg('id')}` : `> No such estate: ${stringArg('id')}` });
      return;
    }
    case 'pin':
    case 'unpin': {
      const updated = await registry.setPinned(requireId(), command === 'pin');
      if (!updated) {
        throw new Error(`no such estate: ${stringArg('id')}`);
      }
      logger.info({ message: `> ${command === 'pin' ? 'Pinned' : 'Unpinned'} ${updated.id}` });
      return;
    }
    case 'list': {
      const { estates, unreadable } = await registry.list();
      const pressure = await registry.readPressure();
      if (argsMap['json']) {
        console.log(JSON.stringify({ estates, unreadable, pressure }, null, 2));
        return;
      }
      logger.info({
        message: `> ${estates.length} estate${estates.length !== 1 ? 's' : ''} registered${pressure ? ` — pressure ${pressure.level.toUpperCase()}${pressure.summary ? ` (${pressure.summary})` : ''}` : ''}`,
      });
      for (const record of estates) {
        console.log(formatEstateLine(record, cw));
      }
      for (const unreadablePath of unreadable) {
        logger.warn({ message: `> UNREADABLE estate file (never touched): ${unreadablePath}` });
      }
      return;
    }
    default:
      throw new Error(`unknown command '${command}' — see estate --help`);
  }
};

function formatEstateLine(record: EstateRecord, cw: LogColorWrapper): string {
  const heartbeatAge = EstateReaper.formatAge(Date.now() - record.heartbeatAt);
  const parts = [
    `${cw.color(record.id, secondaryLogColor)} (owner ${record.owner})`,
    record.pinned ? '[PINNED]' : undefined,
    record.ports.length ? `ports ${record.ports.join(',')}` : undefined,
    record.dirs.length ? `dirs ${record.dirs.join(', ')}` : undefined,
    record.containers.length ? `containers ${record.containers.join(',')}` : undefined,
    record.pids.length ? `pids ${record.pids.join(',')}` : undefined,
    record.databases?.length ? `databases ${record.databases.join(',')}` : undefined,
    `heartbeat ${heartbeatAge} ago`,
  ];
  return '  ' + parts.filter((part) => part !== undefined).join(' — ');
}
