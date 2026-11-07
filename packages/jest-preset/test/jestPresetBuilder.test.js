'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JestPresetBuilder } = require('../JestPresetBuilder');
const { workers, workerIdleMemoryLimit, declaration, nodeOptions } = require('../knobs');

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

  test('JEST_WORKERS unset: maxWorkers is the physical cores (knobs.workers — half the logical count), never jest’s cpus − 1', () => {
    const spy = jest.spyOn(os, 'availableParallelism').mockReturnValue(8);
    try {
      expect(buildAt(makePackageDir([])).maxWorkers).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  test('the pressure-valve advisory caps the preset’s count too (the local valve lives in the preset); JEST_WORKERS still wins', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jest-preset-advisory-'));
    fs.mkdirSync(path.join(home, 'advisories'), { recursive: true });
    fs.writeFileSync(path.join(home, 'advisories', 'jest-workers'), '1\n');
    const spy = jest.spyOn(os, 'availableParallelism').mockReturnValue(8);
    try {
      expect(buildAt(makePackageDir([]), { N3XA_ESTATE_HOME: home }).maxWorkers).toBe(1);
      expect(buildAt(makePackageDir([]), { N3XA_ESTATE_HOME: home, JEST_WORKERS: '6' }).maxWorkers).toBe(6);
    } finally {
      spy.mockRestore();
    }
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

/**
 * THE IN-BAND DECLARATION (DECISIONS 1121, P3): a package that must run one suite at a time DECLARES it in its
 * package.json — `"jestPreset": { "inBand": "<the reason>" }` — never by a `--runInBand` flag in its test script.
 * The preset reads the declaration and sets `maxWorkers: 1`; CI's JEST_WORKERS cannot override a declared in-band
 * (the knob is the parallel packages' dial, and a declared package ignores it by construction). A declaration
 * without its reason is refused at config load: the reason is the record a later lift reads.
 */
const makePackageDirWith = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jest-preset-test-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
};
const manifest = (extra = {}) => JSON.stringify({ name: '@fixture/server', version: '1.0.0', ...extra }, null, 2);

describe('the in-band declaration (package.json jestPreset.inBand)', () => {
  test('a declared in-band package runs one suite at a time: maxWorkers 1 from the preset', () => {
    const dir = makePackageDirWith({
      'package.json': manifest({ jestPreset: { inBand: 'one Spanner CI database per run (the LEGS budget: 1)' } }),
    });
    expect(buildAt(dir).maxWorkers).toBe(1);
  });

  test("CI's JEST_WORKERS cannot override a declared in-band: the declaration wins", () => {
    const dir = makePackageDirWith({
      'package.json': manifest({ jestPreset: { inBand: 'the suites share one emulator database' } }),
    });
    expect(buildAt(dir, { JEST_WORKERS: '8' }).maxWorkers).toBe(1);
  });

  test('no declaration: maxWorkers is the env knob’s count when set, the physical cores when unset', () => {
    const dir = makePackageDirWith({ 'package.json': manifest() });
    const spy = jest.spyOn(os, 'availableParallelism').mockReturnValue(8);
    try {
      expect(buildAt(dir).maxWorkers).toBe(4);
    } finally {
      spy.mockRestore();
    }
    expect(buildAt(dir, { JEST_WORKERS: '8' }).maxWorkers).toBe(8);
    expect(buildAt(makePackageDir([]), { JEST_WORKERS: '3' }).maxWorkers).toBe(3);
  });

  test('a declaration without its reason is refused at config load, naming the key; a jestPreset that is no object is refused as that', () => {
    for (const jestPreset of [{ inBand: true }, { inBand: '' }, { inBand: '   ' }, { inBand: 1 }]) {
      const dir = makePackageDirWith({ 'package.json': manifest({ jestPreset }) });
      expect(() => buildAt(dir)).toThrow(/jestPreset\.inBand without its reason/);
    }
    for (const jestPreset of ['inBand', ['inBand'], 1]) {
      const dir = makePackageDirWith({ 'package.json': manifest({ jestPreset }) });
      expect(() => buildAt(dir)).toThrow(/jestPreset is not an object/);
    }
  });

  test('the declaration’s spelling is the wire the land tool’s law reads (one spelling, two readers)', () => {
    expect(JestPresetBuilder.DECLARATION_KEY).toBe('jestPreset');
    expect(JestPresetBuilder.IN_BAND_KEY).toBe('inBand');
  });
});

/**
 * THE NODE-OPTIONS DECLARATION (DECISIONS 1121 P3; thought-export, 2026-11-07): a package whose suites need a node
 * flag DECLARES it — `"jestPreset": { "nodeOptions": ["--experimental-vm-modules"], "reason": "<why>" }` — never a
 * typed NODE_OPTIONS in its script (P2) and never a config of its own that mutates the environment (a second
 * mechanism beside the preset, which the next package copies). The builder applies it the one way: each declared flag
 * the process did not start with joins NODE_OPTIONS at config load, the env jest's forked workers inherit; an
 * in-process run (--runInBand / -i / --detectOpenHandles — jest's in-process set under this preset) that lacks a
 * declared flag is refused by name with the command that carries it, because a node flag cannot be taken after the
 * fact. The declaration's vocabulary is closed: a key outside it is refused, never read as nothing.
 */
describe('the node-options declaration (package.json jestPreset.nodeOptions with its reason)', () => {
  const VM = '--experimental-vm-modules';
  const REASON = 'pptxgenjs 4.0.1 dynamic-imports node:fs';
  const declared = (extra = {}) =>
    makePackageDirWith({ 'package.json': manifest({ jestPreset: { nodeOptions: [VM], reason: REASON, ...extra } }) });
  const buildWith = (dir, { env = {}, argv = ['node', 'jest'], execArgv = [] } = {}) =>
    new JestPresetBuilder({ env, packageDir: dir, tsJestVersion: TS_JEST_OK, argv, execArgv }).build();

  test('a declared flag joins NODE_OPTIONS at config load — the env the forked workers inherit — after what was there; no declaration leaves the env alone', () => {
    const empty = {};
    buildWith(declared(), { env: empty });
    expect(empty.NODE_OPTIONS).toBe(VM);
    const heap = { NODE_OPTIONS: '--max-old-space-size=3072' };
    buildWith(declared(), { env: heap });
    expect(heap.NODE_OPTIONS).toBe(`--max-old-space-size=3072 ${VM}`);
    const undeclared = { NODE_OPTIONS: '--max-old-space-size=3072' };
    buildWith(makePackageDirWith({ 'package.json': manifest() }), { env: undeclared });
    expect(undeclared.NODE_OPTIONS).toBe('--max-old-space-size=3072');
  });

  test('a flag the process started with (NODE_OPTIONS or execArgv) is not appended again; a second build in the same process appends nothing more', () => {
    const carried = { NODE_OPTIONS: VM };
    buildWith(declared(), { env: carried });
    expect(carried.NODE_OPTIONS).toBe(VM);
    const viaExecArgv = {};
    buildWith(declared(), { env: viaExecArgv, execArgv: [VM] });
    expect(viaExecArgv).not.toHaveProperty('NODE_OPTIONS');
    const twice = {};
    const dir = declared();
    buildWith(dir, { env: twice });
    buildWith(dir, { env: twice });
    expect(twice.NODE_OPTIONS).toBe(VM);
  });

  test('an in-process run (--runInBand / -i / --detectOpenHandles) that lacks a declared flag is refused by name, with the command that carries it; carried, or a workers run, it stands', () => {
    for (const flag of ['--runInBand', '-i', '--detectOpenHandles']) {
      expect(() => buildWith(declared(), { argv: ['node', 'jest', flag, 'test/PptxWriter.test.ts'] })).toThrow(
        new RegExp(`jestPreset\\.nodeOptions.*${VM}.*\\(${flag}\\).*NODE_OPTIONS='${VM}' npx jest ${flag}`)
      );
    }
    expect(() =>
      buildWith(declared(), { env: { NODE_OPTIONS: VM }, argv: ['node', 'jest', '--runInBand'] })
    ).not.toThrow();
    expect(() => buildWith(declared(), { execArgv: [VM], argv: ['node', 'jest', '-i'] })).not.toThrow();
    expect(() => buildWith(declared(), { argv: ['node', 'jest', 'test/PptxWriter.test.ts'] })).not.toThrow();
  });

  test('flags without their reason, a reason without flags, flags that are not a list of node flags, a flag NODE_OPTIONS cannot carry — each refused by name at config load', () => {
    const refused = (jestPreset, pattern) =>
      expect(() => buildWith(makePackageDirWith({ 'package.json': manifest({ jestPreset }) }))).toThrow(pattern);
    refused({ nodeOptions: [VM] }, /jestPreset\.nodeOptions without its reason/);
    refused({ nodeOptions: [VM], reason: '  ' }, /jestPreset\.nodeOptions without its reason/);
    refused({ reason: 'a reason beside no flags' }, /jestPreset\.reason without jestPreset\.nodeOptions/);
    refused({ nodeOptions: VM, reason: 'r' }, /jestPreset\.nodeOptions is not a list of node flags/);
    refused({ nodeOptions: [], reason: 'r' }, /jestPreset\.nodeOptions is not a list of node flags/);
    refused(
      { nodeOptions: ['experimental-vm-modules'], reason: 'r' },
      /jestPreset\.nodeOptions is not a list of node flags/
    );
    refused({ nodeOptions: ['--version'], reason: 'r' }, /--version.*NODE_OPTIONS cannot carry/);
  });

  test('a key outside the declaration’s vocabulary is refused by name — a misspelled inBand would otherwise run with workers against one database', () => {
    const dir = makePackageDirWith({ 'package.json': manifest({ jestPreset: { inband: 'one database' } }) });
    expect(() => buildWith(dir)).toThrow(/jestPreset\.inband/);
  });

  test('both declarations together: one worker, started under the flags', () => {
    const env = {};
    const preset = buildWith(declared({ inBand: 'one Spanner CI database per run' }), { env });
    expect(preset.maxWorkers).toBe(1);
    expect(env.NODE_OPTIONS).toBe(VM);
  });

  test('the declaration’s spellings and jest’s in-process set are the builder’s constants (the judge reads the same spellings)', () => {
    expect(JestPresetBuilder.NODE_OPTIONS_KEY).toBe('nodeOptions');
    expect(JestPresetBuilder.REASON_KEY).toBe('reason');
    expect(JestPresetBuilder.IN_PROCESS_FLAGS).toEqual(['--runInBand', '-i', '--detectOpenHandles']);
  });

  test('ONE reader of the declaration — knobs.declaration(packageDir) / knobs.nodeOptions(packageDir): the builder’s own read and the land tool’s (`land reds` starts node under the declared flags) read the same function; a declaration without its reason is refused there by name', () => {
    const dir = declared();
    expect(nodeOptions(dir)).toEqual({ flags: [VM], reason: REASON });
    expect(declaration(dir)).toEqual({
      name: '@fixture/server',
      inBand: null,
      nodeOptions: { flags: [VM], reason: REASON },
    });
    expect(new JestPresetBuilder({ env: {}, packageDir: dir, tsJestVersion: TS_JEST_OK }).declaration()).toEqual(
      declaration(dir)
    );
    // none declared, and no package.json at all (the preset's own fixtures): null — nothing to start node under
    expect(nodeOptions(makePackageDirWith({ 'package.json': manifest() }))).toBeNull();
    expect(
      nodeOptions(makePackageDirWith({ 'package.json': manifest({ jestPreset: { inBand: 'one database' } }) }))
    ).toBeNull();
    expect(nodeOptions(makePackageDir([]))).toBeNull();
    // the reader refuses what the builder refuses — the one read, the one refusal
    expect(() => nodeOptions(declared({ reason: '' }))).toThrow(/declares jestPreset\.nodeOptions without its reason/);
    expect(() =>
      nodeOptions(makePackageDirWith({ 'package.json': manifest({ jestPreset: { inband: 'x' } }) }))
    ).toThrow(/jestPreset\.inband — no key the preset reads/);
  });
});

/**
 * THE NODE16 FLOOR (space-server, 2026-11-07): a package that compiles under `module: Node16` / `NodeNext` takes
 * ts-jest's own transpile-only road for those module kinds, which reads TypeScript's JSDocParsingMode — a 5.3 API;
 * on 5.2.2 every suite died at globalSetup with the cryptic "Cannot read properties of undefined (reading
 * 'ParseAll')". The preset names the pair at config load instead: the module kind, the TypeScript found, the floor.
 * A commonjs package on 5.2.2 is untouched (ts.transpileModule's road).
 */
describe('the TypeScript floor for Node16 / NodeNext packages (ts-jest’s transpile-only road reads a 5.3 API)', () => {
  const withTsconfig = (module, typescriptVersion) =>
    new JestPresetBuilder({
      env: {},
      packageDir: makePackageDirWith({
        'tsconfig.json': JSON.stringify({ compilerOptions: { module, moduleResolution: module.toLowerCase() } }),
      }),
      tsJestVersion: TS_JEST_OK,
      typescriptVersion,
    });

  test('a Node16 package on TypeScript 5.2.2 is refused by name: the module kind, the version found, the floor', () => {
    expect(() => withTsconfig('Node16', '5.2.2').build()).toThrow(/module Node16.*TypeScript 5\.2\.2.*5\.3\.0/);
    expect(() => withTsconfig('NodeNext', '5.2.2').build()).toThrow(/module NodeNext/);
  });

  test('a Node16 package on TypeScript 5.3.3 builds; a commonjs package on 5.2.2 builds', () => {
    expect(() => withTsconfig('Node16', '5.3.3').build()).not.toThrow();
    expect(() => withTsconfig('commonjs', '5.2.2').build()).not.toThrow();
    expect(() => withTsconfig('CommonJS', '5.2.2').build()).not.toThrow();
  });

  test('no tsconfig at the package dir (the preset’s own fixtures): no floor read, the build stands', () => {
    expect(() =>
      new JestPresetBuilder({
        env: {},
        packageDir: makePackageDir([]),
        tsJestVersion: TS_JEST_OK,
        typescriptVersion: '5.2.2',
      }).build()
    ).not.toThrow();
  });
});
