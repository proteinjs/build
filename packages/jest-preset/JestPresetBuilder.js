'use strict';
const fs = require('fs');
const path = require('path');
const { TestPractice, TS_JEST_FLOOR } = require('./practice');

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
 *        or workerIdleMemoryLimit (both are this preset's).
 *   P2 — the package's test script is exactly `jest --passWithNoTests` — never `--runInBand`, never a
 *        typed NODE_OPTIONS (a worker's heap is this preset's workerIdleMemoryLimit; an in-band run's
 *        heap is the CI step's env, never the script's).
 *   P3 — a package that must run one suite at a time DECLARES it, never flags it: package.json
 *        `"jestPreset": { "inBand": "<the reason: one Spanner CI database per run / …>" }`. This
 *        builder reads the declaration and sets `maxWorkers: 1`; CI's JEST_WORKERS CANNOT override a
 *        declared in-band — the knob dials the parallel packages, a declared package ignores it by
 *        construction. A declaration without its reason is refused at config load (the reason is the
 *        record a later lift reads; lifting it is its own change with proof). A package whose suites
 *        provision their own per-worker databases (thought-server's shape) is NOT in band.
 *   P4 — CI sets JEST_WORKERS from the scope step (the runner's cores; a DB leg's database budget)
 *        and nothing else: no --maxWorkers / --runInBand in any step; the DB-less packages take the
 *        runner's workers (jest's default when the knob is unset); a declared in-band package ignores
 *        the knob by P3.
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
 *   env-overridable; maxWorkers from JEST_WORKERS when CI exports it — or 1, declared (P3).
 * - The standard setup hooks, probed from the consuming package's layout: `test/setup` as
 *   setupFiles and the cross-package emulator lock as globalSetup/globalTeardown, inherited
 *   when the standard files exist and omitted when they don't. Packages with a nonstandard
 *   lifecycle (flow-server's spannerTestDb run-scoped databases) override globalSetup/Teardown
 *   in their own config — config beats preset.
 *
 * The probe keys on process.cwd(): jest gives a preset module no consumer context, and every
 * house runner (`npm test`, test-workspace) invokes jest from the package root. Running jest
 * from anywhere else with this preset skips hook inheritance and the declaration — configs that
 * need hooks from odd invocation directories must declare them explicitly.
 */
class JestPresetBuilder {
  /** The declaration's key in the consuming package's package.json — the judge's spelling (practice.js), the one the land tool's law reads too. */
  static DECLARATION_KEY = TestPractice.DECLARATION_KEY;
  /** The in-band declaration under it: a non-empty string, the reason. */
  static IN_BAND_KEY = TestPractice.IN_BAND_KEY;
  /** ts-jest's floor — practice.js's TS_JEST_FLOOR, the one number (below it ts-jest ignores tsconfig.isolatedModules). */
  static TS_JEST_FLOOR = TS_JEST_FLOOR;

  /** TypeScript's floor for a Node16 / NodeNext package: ts-jest's transpile-only road for those module kinds reads JSDocParsingMode (5.3+). */
  static NODE_MODULES_TYPESCRIPT_FLOOR = '5.3.0';

  constructor({ env = process.env, packageDir = process.cwd(), tsJestVersion, typescriptVersion } = {}) {
    this.env = env;
    this.packageDir = packageDir;
    this.tsJestVersion = tsJestVersion ?? this.resolveTsJestVersion();
    this.typescriptVersion = typescriptVersion ?? null;
  }

  build() {
    this.assertTsJestFloor();
    this.assertTypeScriptFloorForNodeModules();
    return {
      testEnvironment: 'node',
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
      testMatch: ['**/?(*.)+(spec|test).ts?(x)'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: true } }],
      },
      workerIdleMemoryLimit: this.env.JEST_WORKER_IDLE_MEMORY_LIMIT || '1500MB',
      ...this.workerPolicy(),
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

  /** P3 over P4: a declared in-band package is `maxWorkers: 1` whatever JEST_WORKERS says; otherwise the env knob. */
  workerPolicy() {
    return this.inBandDeclaration() === null ? this.maxWorkersFromEnv() : { maxWorkers: 1 };
  }

  maxWorkersFromEnv() {
    const raw = this.env.JEST_WORKERS;
    if (raw === undefined || raw === '') {
      return {};
    }
    const count = Number(raw);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`JEST_WORKERS must be a positive integer, got '${raw}'`);
    }
    return { maxWorkers: count };
  }

  /**
   * The consuming package's in-band declaration (its package.json `jestPreset.inBand`): the reason, or null when
   * the package declares none (no package.json at the package dir counts as none — the preset's own fixtures).
   * A declaration that is not a non-empty string is refused by name: a reason is what a later lift reads.
   */
  inBandDeclaration() {
    const manifestPath = path.join(this.packageDir, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const declaration = manifest[JestPresetBuilder.DECLARATION_KEY];
    if (declaration === undefined) {
      return null;
    }
    const key = `${JestPresetBuilder.DECLARATION_KEY}.${JestPresetBuilder.IN_BAND_KEY}`;
    const shaped = declaration && typeof declaration === 'object' && !Array.isArray(declaration);
    const reason = shaped ? declaration[JestPresetBuilder.IN_BAND_KEY] : undefined;
    if (shaped && reason === undefined) {
      return null;
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new Error(
        `@proteinjs/jest-preset: ${manifest.name || this.packageDir} declares ${key} without its reason — the declaration ` +
          `is the record of why this package runs one suite at a time (one Spanner CI database per run, the suites ` +
          `sharing one emulator database, …); write the reason as the value, never true or an empty string.`
      );
    }
    return reason.trim();
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
