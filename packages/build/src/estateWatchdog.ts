import { LogColorWrapper, parseArgsMap } from '@proteinjs/util-node';
import { Logger } from '@proteinjs/logger';
import { PressureValve } from './PressureValve';
import { primaryLogColor, secondaryLogColor } from './logColors';

const HELP = `estate-watchdog — the local pressure valve (RESOURCE_GOVERNANCE §B.3)

Single-shot watermark evaluation (launchd runs it every 15 minutes; run it by hand anytime):

  SOFT  (disk < 40 GiB free, or memory ≥ 80%): run the reaper's dead-by-contract sweep + write
        the pressure note (~/.n3xa/PRESSURE.md) the coordinator's next turn surfaces. Memory
        pressure also drops the jest-workers advisory (-w=1) the jest preset reads.
  HARD  (disk < 15 GiB free, or memory ≥ 92% sustained): additionally flip the refusal flag —
        \`estate register\` refuses NEW estates with the real numbers. Existing estates are never
        killed; locally there are NO automatic kills, ever (D-3) — surfacing only.

Watermarks are config, not code: ~/.n3xa/valves.json overrides the defaults
({"diskSoftFreeGb":40,"diskHardFreeGb":15,"memSoftPct":80,"memHardPct":92}).

Optional args:

--probe          evaluate + report only: no sweep, no files written (the automatic probe half)
--no-sweep       write pressure state/advisories/note but skip the reaper sweep
--json           machine-readable evaluation on stdout
--help           this text
`;

/** The `estate-watchdog` CLI — the scheduled door over {@link PressureValve}. */
export const estateWatchdog = async () => {
  const cw = new LogColorWrapper();
  const logger = new Logger({
    name: cw.color('workspace:', primaryLogColor) + cw.color('estate-watchdog', secondaryLogColor),
  });
  const argsMap = parseArgsMap(process.argv.slice(2));
  if (argsMap['help']) {
    console.log(HELP);
    return;
  }
  const probeOnly = argsMap['probe'] === true;
  const valve = new PressureValve({
    apply: !probeOnly,
    sweepOnPressure: probeOnly ? false : argsMap['no-sweep'] !== true,
  });
  const evaluation = await valve.evaluate();
  if (argsMap['json'] === true) {
    console.log(JSON.stringify(evaluation, null, 2));
    return;
  }
  const { pressure } = evaluation;
  logger.info({
    message: `> Pressure ${pressure.level.toUpperCase()} — disk ${pressure.disk.freeGb.toFixed(1)}/${pressure.disk.totalGb.toFixed(0)} GiB free, memory ${pressure.memory.usedPct.toFixed(0)}% used, load1 ${pressure.load1?.toFixed(2)}`,
  });
  for (const act of evaluation.acts) {
    logger.info({ message: `> act: ${act}` });
  }
  if (evaluation.sweep) {
    for (const report of evaluation.sweep.reports) {
      logger.info({ message: `> sweep ${report.verdict}: ${report.estate.id} — ${report.reason}` });
    }
  }
};
