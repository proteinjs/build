'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Builds the shared jest preset (DEV_INFRA_PLAN §13.6 centralization ruling: test config is
 * inherited, never repeated). Every repo's package jest config becomes
 * `preset: '@proteinjs/jest-preset'` plus its own overrides, each with a named reason.
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
 *   env-overridable; maxWorkers only when CI exports JEST_WORKERS.
 * - The standard setup hooks, probed from the consuming package's layout: `test/setup` as
 *   setupFiles and the cross-package emulator lock as globalSetup/globalTeardown, inherited
 *   when the standard files exist and omitted when they don't. Packages with a nonstandard
 *   lifecycle (flow-server's spannerTestDb run-scoped databases) override globalSetup/Teardown
 *   in their own config — config beats preset.
 *
 * The probe keys on process.cwd(): jest gives a preset module no consumer context, and every
 * house runner (`npm test`, test-workspace) invokes jest from the package root. Running jest
 * from anywhere else with this preset skips hook inheritance — configs that need hooks from
 * odd invocation directories must declare them explicitly.
 */
class JestPresetBuilder {
  constructor({ env = process.env, packageDir = process.cwd(), tsJestVersion } = {}) {
    this.env = env;
    this.packageDir = packageDir;
    this.tsJestVersion = tsJestVersion ?? this.resolveTsJestVersion();
  }

  build() {
    this.assertTsJestFloor();
    return {
      testEnvironment: 'node',
      moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
      testMatch: ['**/?(*.)+(spec|test).ts?(x)'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: true } }],
      },
      workerIdleMemoryLimit: this.env.JEST_WORKER_IDLE_MEMORY_LIMIT || '1500MB',
      ...this.maxWorkersFromEnv(),
      ...this.standardSetupHooks(),
    };
  }

  assertTsJestFloor() {
    const [major, minor] = this.tsJestVersion.split('.').map(Number);
    if (major < 29 || (major === 29 && minor < 3)) {
      throw new Error(
        `@proteinjs/jest-preset requires ts-jest >= 29.3.0 (found ${this.tsJestVersion}): older ts-jest ` +
          `ignores tsconfig.isolatedModules and silently falls back to full type-check — the exact ` +
          `worker-heap/boot-floor cost this preset exists to remove. Bump the package's ts-jest.`
      );
    }
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
          `dependency; install ts-jest >= 29.3.0 in the consuming package.`
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
