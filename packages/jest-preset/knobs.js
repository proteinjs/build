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
 */

const workers = (packageDefault) => {
  const raw = process.env.JEST_WORKERS;
  if (raw === undefined || raw === '') {
    return packageDefault;
  }
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`JEST_WORKERS must be a positive integer, got '${raw}'`);
  }
  return count;
};

const workerIdleMemoryLimit = (packageDefault) => process.env.JEST_WORKER_IDLE_MEMORY_LIMIT || packageDefault;

module.exports = { workers, workerIdleMemoryLimit };
