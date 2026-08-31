import { LogColorWrapper, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { DockerGuardian } from './DockerGuardian';
import { primaryLogColor, secondaryLogColor } from './logColors';

const HELP = `docker-repair — Docker guardianship (RESOURCE_GOVERNANCE §B.4)

The wedge-kill-relaunch repair as ONE scripted, logged act — still OWNER-GATED per the
machine-services single-owner rule: the PROBE runs freely; without --yes a wedged daemon gets a
printed plan and exit 2, never an act. With --yes (the owner's go): quit Docker Desktop cleanly
(exact-name kill only if the quit times out), relaunch, wait for the engine, verify the shared
standing set (starting exited members). Every step prints and lands in ~/.n3xa/logs/.

The standing set (redis cluster nodes, mariadb, spanner-emulator) is config, not code:
~/.n3xa/docker-standing-set.json (JSON string array of container names).

Optional args:

--yes                       the owner's go for the repair acts on a wedged daemon
--apply-restart-policies    D-6: \`docker update --restart unless-stopped\` on the standing set —
                            services self-heal across daemon bounces instead of stranding Exited
--standing=a,b,c            override the standing set for this run
--save-standing=a,b,c       write the standing set config file
--json                      machine-readable result on stdout
--help                      this text

ie: \`npm run docker-repair\` (probe + plan), \`npm run docker-repair -- --yes\` (repair, after the owner's go)
`;

/** The `docker-repair` CLI — the gated door over {@link DockerGuardian}. */
export const dockerRepair = async () => {
  const cw = new LogColorWrapper();
  const logger = new Logger({
    name: cw.color('workspace:', primaryLogColor) + cw.color('docker-repair', secondaryLogColor),
  });
  const argsMap = parseArgsMap(process.argv.slice(2));
  if (argsMap['help']) {
    console.log(HELP);
    return;
  }
  const listArg = (name: string) =>
    typeof argsMap[name] === 'string'
      ? (argsMap[name] as string)
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : undefined;

  const guardian = new DockerGuardian({ standingSet: listArg('standing') });
  const saveStanding = listArg('save-standing');
  if (saveStanding) {
    await guardian.saveStandingSet(saveStanding);
    logger.info({ message: `> Standing set saved (${saveStanding.length} containers): ${guardian.standingSetPath()}` });
  }

  const result =
    argsMap['apply-restart-policies'] === true
      ? await guardian.applyRestartPolicies()
      : await guardian.repair(argsMap['yes'] === true);

  if (argsMap['json'] === true) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    logger.info({ message: `> Probe: ${result.probe.healthy ? 'healthy' : 'WEDGED'} — ${result.probe.detail}` });
    for (const step of result.steps) {
      const line = `> ${step.ok ? 'ok' : 'FAIL'}: ${step.step}${step.detail ? ` — ${step.detail}` : ''}`;
      if (step.ok) {
        logger.info({ message: line });
      } else {
        logger.error({ message: line });
      }
    }
    if (result.receiptPath) {
      logger.info({ message: `> Receipt: ${result.receiptPath}` });
    }
  }

  if (!result.probe.healthy && !result.acted) {
    process.exit(2); // gated: wedged, plan printed, no act without --yes
  }
  if (result.steps.some((step) => !step.ok)) {
    process.exit(1);
  }
};
