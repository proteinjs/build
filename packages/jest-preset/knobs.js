'use strict';
/**
 * Worker/memory convergence knobs (DEV_INFRA_PLAN §13.6/§13.8): package jest configs express
 * their DEFAULT worker count / worker-memory cap through these helpers, and CI overrides both
 * through env — one env contract for every repo, no per-repo flag soup.
 *
 * - `JEST_WORKERS`: overrides `workers(packageDefault)` (e.g. the linux-8core runner exports
 *   JEST_WORKERS=8 and flow-server's `workers(2)` default scales up without a code change).
 *   Packages that must stay serial regardless of runner (Spanner-emulator sweeps: the emulator's
 *   single-transaction limit) pin a literal `maxWorkers: 1` instead of using this helper —
 *   config literals beat the preset, so the env knob can never un-serialize them.
 * - `JEST_WORKER_IDLE_MEMORY_LIMIT`: overrides `workerIdleMemoryLimit(packageDefault)`; the
 *   preset's converged default is 1500MB (load-bearing against OOM on 7 GB runners — raise it
 *   only WITH a bigger runner, §13.8).
 *
 * Local pressure-valve advisory (RESOURCE_GOVERNANCE §B.3): under memory pressure the
 * estate-watchdog drops `~/.n3xa/advisories/jest-workers` (content: a worker count, i.e. `1`).
 * `workers()` honors it as a CEILING on the resolved count — the machine-output form of the
 * `-w=1` throttle practice. Env still wins outright (an explicit operator/CI choice), a stale
 * advisory (> 24h — a watchdog that stopped running) is ignored, and serial `maxWorkers: 1`
 * literals never pass through here at all.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ADVISORY_MAX_AGE_MS = 24 * 3600 * 1000;

/** The pressure valve's advisory worker count, or undefined (missing/stale/unparseable). */
const advisoryWorkers = () => {
  try {
    const home = process.env.N3XA_ESTATE_HOME || path.join(os.homedir(), '.n3xa');
    const advisoryPath = path.join(home, 'advisories', 'jest-workers');
    const stat = fs.statSync(advisoryPath);
    if (Date.now() - stat.mtimeMs > ADVISORY_MAX_AGE_MS) {
      return undefined;
    }
    const count = Number(fs.readFileSync(advisoryPath, 'utf-8').trim());
    return Number.isInteger(count) && count >= 1 ? count : undefined;
  } catch {
    return undefined;
  }
};

const workers = (packageDefault) => {
  const raw = process.env.JEST_WORKERS;
  if (raw !== undefined && raw !== '') {
    const count = Number(raw);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`JEST_WORKERS must be a positive integer, got '${raw}'`);
    }
    return count;
  }
  const advisory = advisoryWorkers();
  if (advisory === undefined) {
    return packageDefault;
  }
  // A ceiling, never a raise: numeric defaults clamp; percentage-string defaults (e.g. '50%')
  // resolve to multiple cores on any dev machine, so the advisory count stands in for them.
  return typeof packageDefault === 'number' ? Math.min(advisory, packageDefault) : advisory;
};

const workerIdleMemoryLimit = (packageDefault) => process.env.JEST_WORKER_IDLE_MEMORY_LIMIT || packageDefault;

module.exports = { workers, workerIdleMemoryLimit };
