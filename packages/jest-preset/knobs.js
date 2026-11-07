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
const { TestPractice } = require('./practice');

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

/**
 * THE DECLARATION'S ONE READER (DECISIONS 1121 P3): the consuming package's package.json `jestPreset`, read whole and
 * refused by name — `{ name, inBand: <the reason> | null, nodeOptions: { flags, reason } | null }`; no package.json at
 * the dir counts as none (the preset's own fixtures). Every consumer of the declaration reads it HERE: the builder at
 * config load (JestPresetBuilder — maxWorkers 1 for a declared in-band; the declared flags joined to NODE_OPTIONS for
 * the workers jest forks, an in-process run that lacks them refused), and the metarepo's land tool before an in-band
 * run it makes itself (`land reds` runs `npm test -- --runInBand`, which has no worker to inherit the flags: node must
 * START under them — PackageVerifier reads `nodeOptions(packageDir)` through the package's own installed preset and
 * carries the flags as that run's NODE_OPTIONS, never parsing package.json a second time). The vocabulary is closed
 * (TestPractice.DECLARATION_KEYS) because a key outside it read as nothing is the silent failure: a misspelled
 * `inband` would run the package with workers against its one database. The in-band declaration carries its reason
 * as its value; the node-options declaration carries its flags and, beside them, `reason`; each reason is the record
 * a later lift reads. A declared flag is one NODE_OPTIONS can carry (node's process.allowedNodeEnvironmentFlags) —
 * any other would kill every worker at spawn.
 */
const declaration = (packageDir) => {
  const manifestPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    return { name: packageDir, inBand: null, nodeOptions: null };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const name = manifest.name || packageDir;
  const declared = manifest[TestPractice.DECLARATION_KEY];
  if (declared === undefined) {
    return { name, inBand: null, nodeOptions: null };
  }
  const { DECLARATION_KEY, IN_BAND_KEY, NODE_OPTIONS_KEY, REASON_KEY, DECLARATION_KEYS } = TestPractice;
  const key = (k) => `${DECLARATION_KEY}.${k}`;
  const refuse = (text) => {
    throw new Error(`@proteinjs/jest-preset: ${name} ${text}`);
  };
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    refuse(
      `declares ${DECLARATION_KEY} but ${DECLARATION_KEY} is not an object (the declaration: { "${IN_BAND_KEY}": "<the reason>" }, ` +
        `{ "${NODE_OPTIONS_KEY}": ["<node flag>", …], "${REASON_KEY}": "<the reason>" }, or both).`
    );
  }
  const unknown = Object.keys(declared).filter((k) => !DECLARATION_KEYS.includes(k));
  if (unknown.length) {
    refuse(
      `declares ${unknown.map(key).join(', ')} — no key the preset reads (the declaration's keys: ${DECLARATION_KEYS.join(', ')}); ` +
        `a key read as nothing would run this package as if it declared nothing.`
    );
  }
  const inBand = declared[IN_BAND_KEY];
  if (inBand !== undefined && (typeof inBand !== 'string' || !inBand.trim())) {
    refuse(
      `declares ${key(IN_BAND_KEY)} without its reason — the declaration is the record of why this package runs one suite at a ` +
        `time (one Spanner CI database per run, the suites sharing one emulator database, …); write the reason as the value, ` +
        `never true or an empty string.`
    );
  }
  const flags = declared[NODE_OPTIONS_KEY];
  const reason = declared[REASON_KEY];
  if (flags === undefined && reason !== undefined) {
    refuse(
      `declares ${key(REASON_KEY)} without ${key(NODE_OPTIONS_KEY)} — the reason belongs beside the flags it explains (the ` +
        `in-band declaration carries its reason as its value).`
    );
  }
  if (flags !== undefined) {
    const isFlag = (flag) => typeof flag === 'string' && /^-\S+$/.test(flag.trim());
    if (!Array.isArray(flags) || !flags.length || !flags.every(isFlag)) {
      refuse(
        `declares ${key(NODE_OPTIONS_KEY)} but ${key(NODE_OPTIONS_KEY)} is not a list of node flags ` +
          `(["--experimental-vm-modules"] — the flags jest's workers start under).`
      );
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      refuse(
        `declares ${key(NODE_OPTIONS_KEY)} without its reason — ${key(REASON_KEY)} is the record of why this package's workers ` +
          `need the flags (the library, the import, the line); write it as a non-empty string.`
      );
    }
    const unallowed = flags.map((flag) => flag.trim()).filter((flag) => !process.allowedNodeEnvironmentFlags.has(flag));
    if (unallowed.length) {
      refuse(
        `declares ${key(NODE_OPTIONS_KEY)} ${unallowed.join(' ')} — a flag NODE_OPTIONS cannot carry (node's ` +
          `process.allowedNodeEnvironmentFlags); every worker would die at spawn.`
      );
    }
  }
  return {
    name,
    inBand: inBand === undefined ? null : inBand.trim(),
    nodeOptions: flags === undefined ? null : { flags: flags.map((flag) => flag.trim()), reason: reason.trim() },
  };
};

/** The node flags `packageDir`'s jest workers start under — its declaration's `{ flags, reason }` — or null when it declares none. */
const nodeOptions = (packageDir) => declaration(packageDir).nodeOptions;

module.exports = { workers, workerIdleMemoryLimit, testTimeoutForBackend, declaration, nodeOptions };
