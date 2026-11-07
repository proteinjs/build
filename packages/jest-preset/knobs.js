'use strict';
/**
 * Worker/memory convergence knobs (DEV_INFRA_PLAN §13.6/§13.8; DECISIONS 1121 P4): the preset resolves the worker
 * count and the worker-memory cap through these helpers, and CI overrides both through env — one env contract for
 * every repo, no per-repo flag soup.
 *
 * - `JEST_WORKERS`: the count when CI exports it (the scope step: the runner's cores, a DB leg's database budget).
 *   UNSET, the count is THE PHYSICAL CORES — max(1, floor(os.availableParallelism() / 2)) — never jest's own default
 *   (the logical count − 1): on the pool's hyperthreaded e2-standard-8 (8 logical, 4 physical) jest's 7 workers ran
 *   the jsdom sweeps 7–10× slower than local and tripped reloadScrollAnchor's clocks (DECISIONS 764's measurement; the
 *   fix then was a typed `--maxWorkers=4` on one repo's step, which the one practice replaces with this default — one
 *   owner, every repo, no typed number anywhere; a Mac reads the same way: 14 logical → 7). The preset hands this
 *   count to every package that declares no in-band (JestPresetBuilder.workerPolicy). A package that must stay serial
 *   regardless of runner DECLARES it in its package.json (`"jestPreset": { "inBand": "<the reason>" }`, DECISIONS
 *   1121 P3): the preset reads the declaration and sets `maxWorkers: 1`, and this knob can never un-serialize it —
 *   never a literal `maxWorkers` in the config, never `--runInBand` in the script. The `packageDefault` argument is
 *   the pre-practice road (a config's `maxWorkers: workers(2)`): P1 types no maxWorkers, so the preset passes none; it
 *   stays for the configs not yet adopted.
 * - `JEST_WORKER_IDLE_MEMORY_LIMIT`: overrides `workerIdleMemoryLimit(packageDefault)`; the
 *   preset's converged default is 1500MB (load-bearing against OOM on 7 GB runners — raise it
 *   only WITH a bigger runner, §13.8).
 *
 * Local pressure-valve advisory (RESOURCE_GOVERNANCE §B.3): under memory pressure the
 * estate-watchdog drops `~/.n3xa/advisories/jest-workers` (content: a worker count, i.e. `1`).
 * `workers()` honors it as a CEILING on the resolved count — the machine-output form of the
 * `-w=1` throttle practice — so it caps the physical-cores default of every preset package too. Env still wins
 * outright (an explicit operator/CI choice), a stale advisory (> 24h — a watchdog that stopped running) is ignored,
 * and a declared in-band's `maxWorkers: 1` never passes through here at all.
 *
 * The per-test clock of a package whose tests drive a backend is a knob too:
 * `testTimeoutForBackend(opDeadlineMs)` derives it from the database driver's own per-operation
 * deadline (its doc below) — never a number typed by hand in the package config.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ADVISORY_MAX_AGE_MS = 24 * 3600 * 1000;

/** The pressure valve's advisory worker count, or undefined (missing/stale/unparseable); the estate home from `env`. */
const advisoryWorkers = (env) => {
  try {
    const home = env.N3XA_ESTATE_HOME || path.join(os.homedir(), '.n3xa');
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

/** The physical cores: half the logical count (os.availableParallelism — a hyperthreaded core counts twice there; Node 18.14+), at least 1. */
const physicalCores = () => Math.max(1, Math.floor(os.availableParallelism() / 2));

/**
 * The worker count: `env.JEST_WORKERS` when set (a positive integer, else refused by name); otherwise the package
 * default when one is given (the pre-practice road), else the physical cores — the advisory a ceiling on either.
 * `env` is process.env unless the caller hands its own (the preset's builder hands the env it was built with).
 */
const workers = (packageDefault, env = process.env) => {
  const raw = env.JEST_WORKERS;
  if (raw !== undefined && raw !== '') {
    const count = Number(raw);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`JEST_WORKERS must be a positive integer, got '${raw}'`);
    }
    return count;
  }
  const resolved = packageDefault === undefined ? physicalCores() : packageDefault;
  const advisory = advisoryWorkers(env);
  if (advisory === undefined) {
    return resolved;
  }
  // A ceiling, never a raise: numeric counts clamp; percentage-string defaults (e.g. '50%')
  // resolve to multiple cores on any dev machine, so the advisory count stands in for them.
  return typeof resolved === 'number' ? Math.min(advisory, resolved) : advisory;
};

const workerIdleMemoryLimit = (packageDefault) => process.env.JEST_WORKER_IDLE_MEMORY_LIMIT || packageDefault;

/**
 * The per-test clock (jest's `testTimeout`) for a package whose tests drive a backend through a
 * database driver that enforces its own per-operation deadline: TWO operation deadlines — one for
 * the test's own work at an operation's worst latency, one for a single stalled operation the
 * driver still tolerates before it fails the op — so a stalled operation ends as the driver's
 * NAMED failure (which op, which deadline) and never as jest's bare timeout, which reports nothing
 * but the number. A clock at or below the driver's deadline is exactly the flake: jest kills the
 * test first and the cause is lost. Pass the driver's deadline as the driver reports it (its
 * accessor or exported constant), never a copy of the number.
 */
const testTimeoutForBackend = (opDeadlineMs) => {
  if (typeof opDeadlineMs !== 'number' || !Number.isFinite(opDeadlineMs) || opDeadlineMs <= 0) {
    throw new Error(
      `testTimeoutForBackend takes the database driver's operation deadline in ms (a positive number), got '${opDeadlineMs}'`
    );
  }
  return 2 * opDeadlineMs;
};

module.exports = { workers, workerIdleMemoryLimit, testTimeoutForBackend };
