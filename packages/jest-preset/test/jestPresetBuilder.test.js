'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JestPresetBuilder } = require('../JestPresetBuilder');
const { workers, workerIdleMemoryLimit } = require('../knobs');

/**
 * Pins the shared preset's load-bearing behavior (DEV_INFRA_PLAN §13.6-§13.8):
 * - transpile-only ts-jest via the COMPILER option (tsconfig.isolatedModules), the §13.8 fix
 *   that removes the type-check heap that churned workers;
 * - the worker/memory convergence knobs (env-overridable per-package defaults);
 * - the ts-jest version floor (>=29.3.0 — older ts-jest ignores tsconfig.isolatedModules and
 *   silently falls back to full type-check);
 * - the standard setup-hook probe (inherited when the consumer has the standard files,
 *   absent otherwise).
 */

// A ts-jest version new enough for the floor; tests inject it so they don't depend on
// what happens to be installed next to the preset.
const TS_JEST_OK = '29.4.5';

const buildAt = (packageDir, env = {}) => new JestPresetBuilder({ env, packageDir, tsJestVersion: TS_JEST_OK }).build();

const makePackageDir = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jest-preset-test-'));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), '// fixture\n');
  }
  return dir;
};

describe('transpile-only transform', () => {
  test('yields ts-jest with tsconfig.isolatedModules: true (the compiler option, not the deprecated ts-jest flag)', () => {
    const preset = buildAt(makePackageDir([]));
    expect(preset.transform).toEqual({
      '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: true } }],
    });
  });

  test('base shape: node environment, ts-first extensions, ts?(x) testMatch', () => {
    const preset = buildAt(makePackageDir([]));
    expect(preset.testEnvironment).toBe('node');
    expect(preset.moduleFileExtensions).toEqual(['ts', 'tsx', 'js', 'jsx', 'json', 'node']);
    expect(preset.testMatch).toEqual(['**/?(*.)+(spec|test).ts?(x)']);
  });
});

describe('worker/memory convergence knobs', () => {
  test('workerIdleMemoryLimit defaults to the converged 1500MB cap', () => {
    const preset = buildAt(makePackageDir([]));
    expect(preset.workerIdleMemoryLimit).toBe('1500MB');
  });

  test('JEST_WORKER_IDLE_MEMORY_LIMIT overrides the cap (the big-runner headroom knob)', () => {
    const preset = buildAt(makePackageDir([]), { JEST_WORKER_IDLE_MEMORY_LIMIT: '4GB' });
    expect(preset.workerIdleMemoryLimit).toBe('4GB');
  });

  test('maxWorkers is absent unless JEST_WORKERS is set (jest default / package config decides)', () => {
    const preset = buildAt(makePackageDir([]));
    expect(preset).not.toHaveProperty('maxWorkers');
  });

  test('JEST_WORKERS sets maxWorkers on the preset', () => {
    const preset = buildAt(makePackageDir([]), { JEST_WORKERS: '8' });
    expect(preset.maxWorkers).toBe(8);
  });

  test('workers(default) helper: package default when env is unset, env value when set', () => {
    const savedWorkers = process.env.JEST_WORKERS;
    delete process.env.JEST_WORKERS;
    try {
      expect(workers(2)).toBe(2);
      process.env.JEST_WORKERS = '8';
      expect(workers(2)).toBe(8);
    } finally {
      if (savedWorkers === undefined) {
        delete process.env.JEST_WORKERS;
      } else {
        process.env.JEST_WORKERS = savedWorkers;
      }
    }
  });

  test('workers(default) rejects a garbage JEST_WORKERS loudly', () => {
    const savedWorkers = process.env.JEST_WORKERS;
    process.env.JEST_WORKERS = 'lots';
    try {
      expect(() => workers(2)).toThrow(/JEST_WORKERS/);
    } finally {
      if (savedWorkers === undefined) {
        delete process.env.JEST_WORKERS;
      } else {
        process.env.JEST_WORKERS = savedWorkers;
      }
    }
  });

  test('workerIdleMemoryLimit(default) helper honors the env override', () => {
    const saved = process.env.JEST_WORKER_IDLE_MEMORY_LIMIT;
    delete process.env.JEST_WORKER_IDLE_MEMORY_LIMIT;
    try {
      expect(workerIdleMemoryLimit('1500MB')).toBe('1500MB');
      process.env.JEST_WORKER_IDLE_MEMORY_LIMIT = '4GB';
      expect(workerIdleMemoryLimit('1500MB')).toBe('4GB');
    } finally {
      if (saved === undefined) {
        delete process.env.JEST_WORKER_IDLE_MEMORY_LIMIT;
      } else {
        process.env.JEST_WORKER_IDLE_MEMORY_LIMIT = saved;
      }
    }
  });
});

describe('ts-jest version floor', () => {
  test('refuses ts-jest older than 29.3.0 (tsconfig.isolatedModules unhonored there = silent full type-check)', () => {
    expect(() =>
      new JestPresetBuilder({ env: {}, packageDir: makePackageDir([]), tsJestVersion: '29.1.1' }).build()
    ).toThrow(/ts-jest >= ?29\.3\.0/);
  });

  test('accepts 29.3.0 and newer', () => {
    for (const version of ['29.3.0', '29.4.5']) {
      expect(() =>
        new JestPresetBuilder({ env: {}, packageDir: makePackageDir([]), tsJestVersion: version }).build()
      ).not.toThrow();
    }
  });
});

describe('standard setup hooks (probed from the consuming package)', () => {
  test('inherits setupFiles + emulator-lock global hooks when the standard files exist', () => {
    const dir = makePackageDir([
      'test/setup.js',
      'test/emulatorLock.globalSetup.js',
      'test/emulatorLock.globalTeardown.js',
    ]);
    const preset = buildAt(dir);
    expect(preset.setupFiles).toEqual(['<rootDir>/test/setup']);
    expect(preset.globalSetup).toBe('<rootDir>/test/emulatorLock.globalSetup.js');
    expect(preset.globalTeardown).toBe('<rootDir>/test/emulatorLock.globalTeardown.js');
  });

  test('detects a TypeScript test/setup.ts too', () => {
    const preset = buildAt(makePackageDir(['test/setup.ts']));
    expect(preset.setupFiles).toEqual(['<rootDir>/test/setup']);
  });

  test('omits hook keys entirely for packages without the standard files (no phantom hooks)', () => {
    const preset = buildAt(makePackageDir([]));
    expect(preset).not.toHaveProperty('setupFiles');
    expect(preset).not.toHaveProperty('globalSetup');
    expect(preset).not.toHaveProperty('globalTeardown');
  });
});

describe('jest-preset entry', () => {
  test('the module jest resolves is the built preset for THIS process (cwd probe + real ts-jest)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const entry = require('../jest-preset.js');
    expect(entry.transform).toEqual({
      '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: true } }],
    });
    expect(entry.workerIdleMemoryLimit).toBeDefined();
  });
});
