'use strict';
const fs = require('fs');
const path = require('path');
const { TestPractice, TS_JEST_FLOOR } = require('./practice');
const { workers } = require('./knobs');

/**
 * Builds the shared jest preset (DEV_INFRA_PLAN §13.6 centralization ruling: test config is
 * inherited, never repeated) — THE ONE CI TEST PRACTICE every repo we own carries (DECISIONS 1121,
 * 2026-11-07: "all of our n3xah and n3xa repos need to follow the same practice"; `land stage`
 * refuses a tip whose packages deviate, so a new repo or package follows by construction). The
 * practice's JUDGE ships from this package too — `@proteinjs/jest-preset/practice` (practice.js: a
 * pure read of a package's package.json + jest.config.js naming each deviation from P1–P3 by rule;
 * the land tool's law, `land practice <repo>` and the component template's suite all read that one
 * judge) — with ts-jest's floor as THE ONE NUMBER (TS_JEST_FLOOR there; this builder refuses below it,
 * the peer range states it):
 *
 *   P1 — every package's jest.config.js is `preset: '@proteinjs/jest-preset'` plus the package's OWN
 *        seams only (a moduleNameMapper, a setup file beyond the standard hooks, a testTimeout, roots),
 *        each seam with its named reason — never a second transform, never `preset: 'ts-jest'`, never
 *        a typed testEnvironment (jsdom stays the per-file docblock road), never a typed maxWorkers
 *        or workerIdleMemoryLimit (both are this preset's), never a config that mutates the process
 *        (a node flag is P3's declaration).
 *   P2 — the package's test script is exactly `jest --passWithNoTests` — never `--runInBand`, never a
 *        typed NODE_OPTIONS (a worker's heap is this preset's workerIdleMemoryLimit; an in-band run's
 *        heap is the CI step's env, never the script's; a node flag the suites need is P3's declaration).
 *   P3 — what a package needs of the RUN it DECLARES in its package.json, never flags: `"jestPreset": {…}`
 *        over a closed vocabulary (a key outside it is refused by name — a misspelled `inband` read as
 *        nothing would run the package with workers against its one database). `inBand: "<the reason>"`:
 *        the package runs one suite at a time — this builder sets `maxWorkers: 1`, and CI's JEST_WORKERS
 *        CANNOT override it (the knob dials the parallel packages; a declared package ignores it by
 *        construction); a package whose suites provision their own per-worker databases (thought-server's
 *        shape) is NOT in band. `nodeOptions: ["<node flag>", …], reason: "<why>"`: the suites need node
 *        started under a flag (thought-export: PptxGenJS's write() starts a dynamic import that node's
 *        vm refuses without --experimental-vm-modules) — this builder appends each flag to NODE_OPTIONS at
 *        config load, the env jest's forked workers inherit, and refuses an in-process run that lacks it,
 *        naming the command that carries it. A declaration without its reason is refused at config load
 *        (the reason is the record a later lift reads; lifting it is its own change with proof).
 *   P4 — CI sets JEST_WORKERS from the scope step (the runner's cores; a DB leg's database budget)
 *        and nothing else: no --maxWorkers / --runInBand in any step; a package's maxWorkers is this
 *        preset's — JEST_WORKERS when set, else the PHYSICAL CORES (knobs.js: half the logical count —
 *        DECISIONS 764: at jest's own cpus − 1 the jsdom legs ran 7–10× slower on the pool's hyperthreaded
 *        runner); a declared in-band package ignores the knob by P3.
 *
 * What the preset carries:
 * - Transpile-only ts-jest via the COMPILER option (`tsconfig: { isolatedModules: true }`
 *   inline-merged over the package tsconfig). This is the §13.8 categorical fix: full
 *   type-check held every dependency's d.ts graph in worker heap (1.4-2.6 GB/suite), tripping
 *   the worker-memory cap after nearly every heavy suite so each next suite re-paid the whole
 *   worker boot — the measured "31s per-suite floor". Type safety is NOT lost: each package's
 *   `tsc` build type-checks src AND test, and CI builds before testing.
 *   The compiler-option spelling (not ts-jest's own `isolatedModules` flag) is deliberate:
 *   ts-jest deprecated its flag in 29.3.0 in favor of the tsconfig option — which is also why
 *   the version floor below exists (older ts-jest ignores the tsconfig option and silently
 *   runs full type-check again).
 * - The worker/memory convergence knobs (see knobs.js): converged 1500MB worker cap,
 *   env-overridable; maxWorkers from JEST_WORKERS when CI exports it, else the physical cores (the
 *   local pressure-valve advisory a ceiling on either) — or 1, declared (P3).
 * - The declarations (P3): the in-band package's `maxWorkers: 1`; the declared node flags joined to
 *   NODE_OPTIONS for the workers, the in-process run refused by name when it lacks them.
 * - The standard setup hooks, probed from the consuming package's layout: `test/setup` as
 *   setupFiles and the cross-package emulator lock as globalSetup/globalTeardown, inherited
 *   when the standard files exist and omitted when they don't. Packages with a nonstandard
 *   lifecycle (flow-server's spannerTestDb run-scoped databases) override globalSetup/Teardown
 *   in their own config — config beats preset.
 *
 * The probe keys on process.cwd(): jest gives a preset module no consumer context, and every
 * house runner (`npm test`, test-workspace) invokes jest from the package root. Running jest
 * from anywhere else with this preset skips hook inheritance and the declarations — configs that
 * need hooks from odd invocation directories must declare them explicitly.
 */
class JestPresetBuilder {
  /** The declaration's key in the consuming package's package.json — the judge's spelling (practice.js), the one the land tool's law reads too. */
  static DECLARATION_KEY = TestPractice.DECLARATION_KEY;
  /** The in-band declaration under it: a non-empty string, the reason. */
  static IN_BAND_KEY = TestPractice.IN_BAND_KEY;
  /** The node-options declaration under it: a non-empty list of node flags, with its reason beside it under REASON_KEY. */
  static NODE_OPTIONS_KEY = TestPractice.NODE_OPTIONS_KEY;
  static REASON_KEY = TestPractice.REASON_KEY;
  /** The declaration's whole vocabulary — a key outside it is refused by name, never read as nothing (the judge names the same list). */
  static DECLARATION_KEYS = TestPractice.DECLARATION_KEYS;
  /**
   * jest's IN-PROCESS set under this preset: with workerIdleMemoryLimit set (always, here) @jest/core forks workers for
   * every run but these (testSchedulerHelper.js shouldRunInBand: `runInBand || detectOpenHandles` → true, otherwise
   * `!workerIdleMemoryLimit && …` → false). `--runInBand` and `-i` are one jest option.
   */
  static IN_PROCESS_FLAGS = ['--runInBand', '-i', '--detectOpenHandles'];
  /** ts-jest's floor — practice.js's TS_JEST_FLOOR, the one number (below it ts-jest ignores tsconfig.isolatedModules). */
  static TS_JEST_FLOOR = TS_JEST_FLOOR;

  /** TypeScript's floor for a Node16 / NodeNext package: ts-jest's transpile-only road for those module kinds reads JSDocParsingMode (5.3+). */
  static NODE_MODULES_TYPESCRIPT_FLOOR = '5.3.0';

  /** NODE_OPTIONS as each env carried it when a builder first read it — the flags the process STARTED with, before a declaration joined any. */
  static startingNodeOptions = new WeakMap();

  constructor({
    env = process.env,
    packageDir = process.cwd(),
    tsJestVersion,
    typescriptVersion,
    argv = process.argv,
    execArgv = process.execArgv,
  } = {}) {
    this.env = env;
    this.packageDir = packageDir;
    this.argv = argv;
    this.execArgv = execArgv;
    this.tsJestVersion = tsJestVersion ?? this.resolveTsJestVersion();
    this.typescriptVersion = typescriptVersion ?? null;
    if (!JestPresetBuilder.startingNodeOptions.has(env)) {
      JestPresetBuilder.startingNodeOptions.set(env, env.NODE_OPTIONS || '');
    }
  }

  build() {
    this.assertTsJestFloor();
    this.assertTypeScriptFloorForNodeModules();
    const declaration = this.declaration();
    this.applyNodeOptions(declaration);
    return {
      testEnvironment: 'node',
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
      testMatch: ['**/?(*.)+(spec|test).ts?(x)'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: true } }],
      },
      workerIdleMemoryLimit: this.env.JEST_WORKER_IDLE_MEMORY_LIMIT || '1500MB',
      ...this.workerPolicy(declaration),
      ...this.standardSetupHooks(),
    };
  }

  assertTsJestFloor() {
    if (JestPresetBuilder.compareVersions(this.tsJestVersion, JestPresetBuilder.TS_JEST_FLOOR) < 0) {
      throw new Error(
        `@proteinjs/jest-preset requires ts-jest >= ${JestPresetBuilder.TS_JEST_FLOOR} (found ${this.tsJestVersion}): older ts-jest ` +
          `ignores tsconfig.isolatedModules and silently falls back to full type-check — the exact ` +
          `worker-heap/boot-floor cost this preset exists to remove. Bump the package's ts-jest.`
      );
    }
  }

  /** `a` against `b` as dotted numbers: negative below, 0 equal, positive above (a prerelease suffix is read as its numbers). */
  static compareVersions(a, b) {
    const read = (v) =>
      String(v)
        .split('.')
        .map((n) => parseInt(n, 10) || 0);
    const [x, y] = [read(a), read(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d !== 0) {
        return d;
      }
    }
    return 0;
  }

  /**
   * THE NODE16 FLOOR (space-server, 2026-11-07): a package whose tsconfig compiles under `module: Node16` or `NodeNext`
   * takes ts-jest's own transpile-only road for those module kinds (its transpile-module port, needed for the implied
   * node format), which reads TypeScript's JSDocParsingMode — a 5.3 API; on 5.2.2 every suite died at globalSetup with
   * "Cannot read properties of undefined (reading 'ParseAll')". Named here at config load instead: the module kind,
   * the TypeScript found, the floor. A commonjs package rides ts.transpileModule and has no floor beyond ts-jest's.
   */
  assertTypeScriptFloorForNodeModules() {
    const moduleKind = this.tsconfigModule();
    if (!moduleKind || !/^(node16|nodenext)$/i.test(moduleKind)) {
      return;
    }
    const version = this.typescriptVersion ?? this.resolveTypeScriptVersion();
    if (version === null) {
      return;
    }
    if (JestPresetBuilder.compareVersions(version, JestPresetBuilder.NODE_MODULES_TYPESCRIPT_FLOOR) < 0) {
      throw new Error(
        `@proteinjs/jest-preset: this package compiles under module ${moduleKind} and ts-jest's transpile-only road for ` +
          `that module kind reads TypeScript ${JestPresetBuilder.NODE_MODULES_TYPESCRIPT_FLOOR}'s JSDocParsingMode — found TypeScript ${version} ` +
          `(every suite would die at load on "reading 'ParseAll'"). Move the package's typescript to >= ` +
          `${JestPresetBuilder.NODE_MODULES_TYPESCRIPT_FLOOR}, or its module to commonjs.`
      );
    }
  }

  /** The consuming package's tsconfig `compilerOptions.module`, or null (no tsconfig, or none declared). */
  tsconfigModule() {
    const tsconfigPath = path.join(this.packageDir, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) {
      return null;
    }
    try {
      const options = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8')).compilerOptions || {};
      return typeof options.module === 'string' ? options.module : null;
    } catch {
      return null;
    }
  }

  /** TypeScript's version as the CONSUMING package resolves it (the ts-jest resolution's twin), or null when it is not resolvable from there. */
  resolveTypeScriptVersion() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(require.resolve('typescript/package.json', { paths: [this.packageDir] })).version;
    } catch {
      return null;
    }
  }

  /**
   * P3 over P4: a declared in-band package is `maxWorkers: 1` whatever JEST_WORKERS says; otherwise the knob's count
   * (knobs.workers: JEST_WORKERS when set, else the physical cores, the local advisory a ceiling) — never jest's own
   * cpus − 1 default, never a typed number.
   */
  workerPolicy({ inBand }) {
    return inBand === null ? { maxWorkers: workers(undefined, this.env) } : { maxWorkers: 1 };
  }

  /**
   * THE NODE-OPTIONS DECLARATION (P3; thought-export, 2026-11-07 — PptxGenJS 4.0.1's write() starts a dynamic
   * `import('node:fs')` that node's vm refuses without --experimental-vm-modules), applied the one way for every
   * declaring package. Each declared flag not already in NODE_OPTIONS joins it here, at config load: jest forks every
   * test worker with this process's environment (jest-worker's ChildProcessWorker: `env: { ...process.env, … }`), so
   * the workers start under the flag while the product's node process never sees it. A node flag cannot be taken after
   * the fact, so an IN-PROCESS run (IN_PROCESS_FLAGS) that STARTED without a declared flag (its execArgv and the
   * NODE_OPTIONS it was launched with) is refused by name with the command that carries it — `land reds` and a lane's
   * `--runInBand` runs carry the declared flags in their env.
   */
  applyNodeOptions({ name, nodeOptions }) {
    if (nodeOptions === null) {
      return;
    }
    const tokens = (text) => (text || '').split(/\s+/).filter(Boolean);
    const started = new Set([...this.execArgv, ...tokens(JestPresetBuilder.startingNodeOptions.get(this.env))]);
    const inProcess = this.argv.filter((arg) => JestPresetBuilder.IN_PROCESS_FLAGS.includes(arg));
    const missingAtStart = nodeOptions.flags.filter((flag) => !started.has(flag));
    if (inProcess.length && missingAtStart.length) {
      const key = `${JestPresetBuilder.DECLARATION_KEY}.${JestPresetBuilder.NODE_OPTIONS_KEY}`;
      throw new Error(
        `@proteinjs/jest-preset: ${name} declares ${key} ${JSON.stringify(nodeOptions.flags)} (${nodeOptions.reason}) and this ` +
          `in-process jest run (${inProcess.join(' ')}) started without ${missingAtStart.join(' ')} — a node flag cannot be ` +
          `taken after the fact. Run \`NODE_OPTIONS='${missingAtStart.join(' ')}' npx jest ${inProcess.join(' ')} …\`, or drop ` +
          `${inProcess.join(' ')}: jest's workers start under the declared flags.`
      );
    }
    const present = new Set([...this.execArgv, ...tokens(this.env.NODE_OPTIONS)]);
    const joining = nodeOptions.flags.filter((flag) => !present.has(flag));
    if (joining.length) {
      this.env.NODE_OPTIONS = [...tokens(this.env.NODE_OPTIONS), ...joining].join(' ');
    }
  }

  /**
   * The consuming package's `jestPreset` declaration, read whole and refused by name at config load:
   * `{ name, inBand: <the reason> | null, nodeOptions: { flags, reason } | null }` — no package.json at the package
   * dir counts as none (the preset's own fixtures). The vocabulary is closed (DECLARATION_KEYS) because a key outside
   * it read as nothing is the silent failure: a misspelled `inband` would run the package with workers against its one
   * database. The in-band declaration carries its reason as its value; the node-options declaration carries its flags
   * and, beside them, `reason`; each reason is the record a later lift reads. A declared flag is one NODE_OPTIONS can
   * carry (node's process.allowedNodeEnvironmentFlags) — any other would kill every worker at spawn instead.
   */
  declaration() {
    const manifestPath = path.join(this.packageDir, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      return { name: this.packageDir, inBand: null, nodeOptions: null };
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const name = manifest.name || this.packageDir;
    const declared = manifest[JestPresetBuilder.DECLARATION_KEY];
    if (declared === undefined) {
      return { name, inBand: null, nodeOptions: null };
    }
    const { DECLARATION_KEY, IN_BAND_KEY, NODE_OPTIONS_KEY, REASON_KEY, DECLARATION_KEYS } = JestPresetBuilder;
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
      const unallowed = flags
        .map((flag) => flag.trim())
        .filter((flag) => !process.allowedNodeEnvironmentFlags.has(flag));
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
  }

  standardSetupHooks() {
    const hooks = {};
    if (this.testFileExists('setup.js') || this.testFileExists('setup.ts')) {
      hooks.setupFiles = ['<rootDir>/test/setup'];
    }
    if (this.testFileExists('emulatorLock.globalSetup.js')) {
      hooks.globalSetup = '<rootDir>/test/emulatorLock.globalSetup.js';
    }
    if (this.testFileExists('emulatorLock.globalTeardown.js')) {
      hooks.globalTeardown = '<rootDir>/test/emulatorLock.globalTeardown.js';
    }
    return hooks;
  }

  resolveTsJestVersion() {
    // Resolve from the CONSUMING package (cwd), not from this file: under symlink-workspace this
    // file's real path lives in the build repo, whose own node_modules would shadow the
    // consumer's ts-jest and let a too-old copy slip past the floor.
    let manifestPath;
    try {
      manifestPath = require.resolve('ts-jest/package.json', { paths: [this.packageDir] });
    } catch (resolutionError) {
      throw new Error(
        `@proteinjs/jest-preset: ts-jest is not resolvable from ${this.packageDir} — it is a peer ` +
          `dependency; install ts-jest >= ${JestPresetBuilder.TS_JEST_FLOOR} in the consuming package.`
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(manifestPath).version;
  }

  testFileExists(fileName) {
    return fs.existsSync(path.join(this.packageDir, 'test', fileName));
  }
}

module.exports = { JestPresetBuilder };
