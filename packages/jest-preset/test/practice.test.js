'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const { TestPractice, TS_JEST_FLOOR } = require('../practice');
const { JestPresetBuilder } = require('../JestPresetBuilder');

/**
 * THE ONE CI TEST PRACTICE's judge (DECISIONS 1121; practice.js — `@proteinjs/jest-preset/practice`): a pure read of a
 * package's package.json + jest.config.js naming each deviation by rule — P1 the config is the house preset plus the
 * package's own seams, P2 the script is exactly `jest --passWithNoTests`, P3 an in-band declaration carries its reason.
 * One judge for every reader (the land tool's law, the template's suite, `land practice`), so it is pinned here, at the
 * owner, rule by rule and layout by layout; and ts-jest's floor is ONE number — the builder refuses below it, the peer
 * range states it.
 */
const PRACTICE_CONFIG = `'use strict';
// the house preset plus this package's own seams
module.exports = {
  preset: '@proteinjs/jest-preset',
  // discovery pinned to test/
  roots: ['<rootDir>/test'],
  testEnvironmentOptions: { url: 'http://localhost/?kb=today' },
  moduleNameMapper: {
    // a comment that says transform: and maxWorkers: in prose
    '^react$': '<rootDir>/node_modules/react',
    '\\\\.(png|svg)$': '<rootDir>/test/fileMock.js',
  },
  setupFilesAfterEnv: ['<rootDir>/test/settle.ts'],
  testTimeout: 120000,
};
`;
const manifest = (extra = {}) => ({
  name: '@fixture/ui',
  version: '1.0.0',
  scripts: { build: 'tsc', test: TestPractice.SCRIPT },
  ...extra,
});
const judge = (manifest, config = PRACTICE_CONFIG) => TestPractice.judge({ manifest, config });
const rules = (found) => found.map((d) => d.rule);
const p1 = (found) => found.filter((d) => d.rule === 'P1').map((d) => d.detail);

describe('the judge: a pure read of package.json + jest.config.js, one rule at a time', () => {
  test('a package the law does not reach: no jest in its test script and no jest.config.js (node:test, or untested)', () => {
    expect(judge({ name: 'x', scripts: { test: 'node --test scripts/a.test.mjs' } }, null)).toEqual([]);
    expect(judge({ name: 'x', scripts: { build: 'tsc' } }, null)).toEqual([]);
    expect(judge({ name: 'x' }, null)).toEqual([]);
  });

  test('the practice shape passes: the preset line, the package’s own seams, strings and comments that mention the preset’s keys', () => {
    expect(judge(manifest())).toEqual([]);
    expect(judge(manifest({ jestPreset: { inBand: 'one Spanner CI database per run' } }))).toEqual([]);
  });

  test('P1: preset ts-jest, no preset line, a second transform, a typed testEnvironment / maxWorkers / workerIdleMemoryLimit, no config at all — each named', () => {
    const tsJest = "module.exports = {\n  preset: 'ts-jest',\n  roots: ['<rootDir>/test'],\n};\n";
    expect(p1(judge(manifest(), tsJest))[0]).toMatch(/names preset 'ts-jest'/);
    const bare = "module.exports = {\n  roots: ['<rootDir>/test'],\n};\n";
    expect(p1(judge(manifest(), bare))[0]).toMatch(/carries no preset: '@proteinjs\/jest-preset'/);
    const typed = `module.exports = {
  preset: '@proteinjs/jest-preset',
  transform: { '^.+\\\\.tsx?$': ['ts-jest', { tsconfig: { noEmitOnError: false } }] },
  testEnvironment: 'node',
  maxWorkers: 2,
  workerIdleMemoryLimit: '1500MB',
};
`;
    const found = judge(manifest(), typed);
    expect(rules(found)).toEqual(['P1']);
    expect(found[0].detail).toMatch(/types transform, testEnvironment, maxWorkers, workerIdleMemoryLimit/);
    const none = judge(manifest(), null);
    expect(rules(none)).toEqual(['P1']);
    expect(none[0].detail).toMatch(/no jest\.config\.js/);
  });

  test('P1 reads the exported object literal in any layout: one line, a named const, CRLF, any indent, a double-quoted preset', () => {
    expect(judge(manifest(), "module.exports = { preset: '@proteinjs/jest-preset' };\n")).toEqual([]);
    expect(
      judge(
        manifest(),
        "const config = {\n  preset: '@proteinjs/jest-preset',\n  roots: ['<rootDir>/test'],\n};\nmodule.exports = config;\n"
      )
    ).toEqual([]);
    expect(
      judge(
        manifest(),
        "module.exports = {\r\n  preset: '@proteinjs/jest-preset',\r\n  roots: ['<rootDir>/test'],\r\n};\r\n"
      )
    ).toEqual([]);
    expect(
      judge(manifest(), 'module.exports = {\n\tpreset: "@proteinjs/jest-preset",\n\t\troots: ["<rootDir>/test"],\n};\n')
    ).toEqual([]);
    // the same layouts with a typed key are read, not passed by their shape
    expect(p1(judge(manifest(), "module.exports = { preset: '@proteinjs/jest-preset', maxWorkers: 2 };\n"))[0]).toMatch(
      /types maxWorkers/
    );
    expect(
      p1(
        judge(
          manifest(),
          "const c = { preset: '@proteinjs/jest-preset', testEnvironment: 'node' };\nmodule.exports = c;\n"
        )
      )[0]
    ).toMatch(/types testEnvironment/);
    expect(
      p1(
        judge(manifest(), "module.exports = {\r\n  preset: '@proteinjs/jest-preset',\r\n  maxWorkers: 2,\r\n};\r\n")
      )[0]
    ).toMatch(/types maxWorkers/);
    expect(
      p1(judge(manifest(), "module.exports = {\n  preset: '@proteinjs/jest-preset',\n  ['maxWorkers']: 2,\n};\n"))[0]
    ).toMatch(/types maxWorkers/);
  });

  test('P1: a key at a deeper level (a mapper’s entry, a nested object, a string that spells a key) is a seam, never a preset key', () => {
    const nested = `module.exports = {
  preset: '@proteinjs/jest-preset',
  globals: {
    transform: 'not a jest key here',
    testEnvironment: 'nor here',
  },
  moduleNameMapper: { '^maxWorkers$': '<rootDir>/workerIdleMemoryLimit' },
  testEnvironmentOptions: { url: 'http://localhost/?transform=1' },
};
`;
    expect(judge(manifest(), nested)).toEqual([]);
  });

  test('P1: an export that is not an object literal (a require, an Object.assign, a function) is unreadable and deviates by name', () => {
    for (const config of [
      "module.exports = require('./jest.base.config');\n",
      "module.exports = Object.assign({ preset: '@proteinjs/jest-preset' }, { maxWorkers: 2 });\n",
      "module.exports = () => ({ preset: '@proteinjs/jest-preset' });\n",
      "const shared = require('./shared');\nmodule.exports = shared;\n",
      "exports.preset = '@proteinjs/jest-preset';\n",
    ]) {
      const found = judge(manifest(), config);
      expect(rules(found)).toEqual(['P1']);
      expect(found[0].detail).toMatch(/does not export an object literal the law can read/);
    }
  });

  test('P1: a spread entry is read as the spread it is — it passes beside the preset line and the typed key beside it is still named', () => {
    const spread =
      "const { fragment } = require('@n3xah/flow-server/jest');\nmodule.exports = {\n  preset: '@proteinjs/jest-preset',\n  ...fragment,\n  testTimeout: 120000,\n};\n";
    expect(judge(manifest(), spread)).toEqual([]);
    expect(TestPractice.readConfig(spread).spreads).toEqual(['fragment']);
    const spreadAndTyped =
      "module.exports = {\n  preset: '@proteinjs/jest-preset',\n  ...FlowServerJestPreset.fragment(),\n  maxWorkers: 2,\n};\n";
    expect(p1(judge(manifest(), spreadAndTyped))[0]).toMatch(/types maxWorkers/);
    expect(TestPractice.readConfig(spreadAndTyped).spreads).toEqual(['FlowServerJestPreset.fragment()']);
  });

  test('P1: a config that mutates the process or reads the run’s mode — round 1’s thought-export seam (the flag joined to NODE_OPTIONS at config load, the in-process run refused by the config itself) — is named by line; the declaration is the one owner', () => {
    // thought-export's jest.config.js at 2cf56144 (round 1 of row 3260), retired by the declaration in round 2: every
    // mutation line verbatim, the prose shortened. The judge at db26962c read it as [] — the hole this pin closes.
    const R1_EXPORT_CONFIG = [
      "'use strict';",
      "const vm = require('vm');",
      '',
      '// THE ROUND-1 SEAM (thought-export 2cf56144, retired by the declaration): the flag joined to NODE_OPTIONS by the',
      "// config itself and the in-process run refused by the config itself — a parallel mechanism beside the preset's one owner.",
      "const VM_MODULES_FLAG = '--experimental-vm-modules';",
      "const nodeOptions = process.env.NODE_OPTIONS || '';",
      'if (!nodeOptions.split(/\\s+/).includes(VM_MODULES_FLAG)) {',
      '  process.env.NODE_OPTIONS = `${nodeOptions} ${VM_MODULES_FLAG}`.trim();',
      '}',
      "const IN_PROCESS_FLAGS = ['--runInBand', '-i', '--detectOpenHandles'];",
      'const inProcess = process.argv.filter((arg) => IN_PROCESS_FLAGS.includes(arg));',
      "if (inProcess.length && typeof vm.SyntheticModule !== 'function') {",
      '  throw new Error(',
      "    `thought-export: an in-process jest run (${inProcess.join(' ')}) needs node's ${VM_MODULES_FLAG} — PptxGenJS's ` +",
      "      `write() starts a dynamic import that jest's vm refuses without it. Run \\`NODE_OPTIONS=${VM_MODULES_FLAG} npx jest ` +",
      "      `${inProcess.join(' ')} …\\`, or drop the flag: jest's workers carry it from this config.`",
      '  );',
      '}',
      '',
      'module.exports = {',
      "  preset: '@proteinjs/jest-preset',",
      "  roots: ['<rootDir>/test'],",
      '  moduleNameMapper: {',
      "    '^@proteinjs/([^/]+)$': '<rootDir>/node_modules/@proteinjs/$1',",
      '  },',
      '};',
      '',
    ].join('\n');
    const found = judge(manifest(), R1_EXPORT_CONFIG);
    expect(rules(found)).toEqual(['P1']);
    expect(found[0].detail).toMatch(
      /^jest\.config\.js reads or writes the process at 7 \(process\.env\.NODE_OPTIONS\), 9 \(process\.env\.NODE_OPTIONS \+ a write to process\.env\), 12 \(process\.argv\) — a config never mutates the process or reads the run's mode/
    );
    expect(found[0].detail).toMatch(/jestPreset\.nodeOptions/);
    // the declaration beside the seam does not excuse it: both mechanisms is still two owners
    const declared = manifest({ jestPreset: { nodeOptions: ['--experimental-vm-modules'], reason: 'pptxgenjs' } });
    expect(rules(judge(declared, R1_EXPORT_CONFIG))).toEqual(['P1']);
    // the round-2 shape — the declaration alone, the config a plain literal — passes
    expect(judge(declared, R1_EXPORT_CONFIG.slice(R1_EXPORT_CONFIG.indexOf('module.exports')))).toEqual([]);
    // every read of the process the rule names, each by its kind, on one line each
    const kinds = judge(
      manifest(),
      [
        "process.env.TZ = 'UTC';",
        "process.env['NODE_OPTIONS'] += ' --x';",
        'const started = process.execArgv;',
        'if (process.argv.includes("-i")) process.exit(1);',
        'delete process.env.JEST_WORKERS;',
        "Object.assign(process.env, { A: '1' });",
        "module.exports = { preset: '@proteinjs/jest-preset' };",
      ].join('\n')
    );
    expect(rules(kinds)).toEqual(['P1']);
    expect(kinds[0].detail).toMatch(
      /at 1 \(a write to process\.env\), 2 \(process\.env\.NODE_OPTIONS \+ a write to process\.env\), 3 \(process\.execArgv\), 4 \(process\.argv \+ process\.exit\), 5 \(a write to process\.env\), 6 \(a write to process\.env\)/
    );
    // a read of another env key is a seam's input, not a mutation; a comment or a message that spells the words is prose
    expect(
      judge(
        manifest(),
        [
          '// a config that said process.exit() or process.env.NODE_OPTIONS = x here would be named',
          "const ci = process.env.CI === 'true';",
          "const note = 'never write process.env.NODE_OPTIONS = … in a config; see process.argv';",
          "module.exports = { preset: '@proteinjs/jest-preset', testTimeout: ci ? 120000 : 30000, displayName: note };",
        ].join('\n')
      )
    ).toEqual([]);
  });

  test('P1: a local module the config requires is read the same way when the caller hands it in (modules); localRequires names the specifiers to read', () => {
    const config =
      "const { Fragment } = require('./test/Fragment');\nconst { testTimeoutForBackend } = require('@proteinjs/jest-preset/knobs');\nmodule.exports = {\n  preset: '@proteinjs/jest-preset',\n  ...Fragment.config(),\n};\n";
    expect(TestPractice.localRequires(config)).toEqual(['./test/Fragment']);
    expect(TestPractice.localRequires("require('@n3xah/flow-server/test/jest-preset');\nrequire('vm');\n")).toEqual([]);
    const hidden = [
      {
        path: 'test/Fragment.js',
        text: "'use strict';\n// the seam, moved out of sight\nprocess.env.NODE_OPTIONS = '--experimental-vm-modules';\nmodule.exports = { Fragment: { config: () => ({}) } };\n",
      },
    ];
    expect(TestPractice.judge({ manifest: manifest(), config, modules: hidden })).toEqual([
      {
        rule: 'P1',
        detail: expect.stringMatching(
          /^test\/Fragment\.js reads or writes the process at 3 \(process\.env\.NODE_OPTIONS \+ a write to process\.env\)/
        ),
      },
    ]);
    expect(
      TestPractice.judge({
        manifest: manifest(),
        config,
        modules: [{ path: 'test/Fragment.js', text: 'module.exports = {};\n' }],
      })
    ).toEqual([]);
    expect(TestPractice.judge({ manifest: manifest(), config })).toEqual([]);
    // drift carries the modules through
    expect(
      TestPractice.drift([{ dir: 'server', manifest: manifest(), config, modules: hidden }]).map((p) => [
        p.dir,
        rules(p.deviations),
      ])
    ).toEqual([['server', ['P1']]]);
  });

  test('P2: --runInBand, a typed NODE_OPTIONS, a bare `jest`, a missing script beside a config — each named with the practice’s script', () => {
    for (const test of [
      'jest --runInBand --passWithNoTests',
      'NODE_OPTIONS=--max-old-space-size=8192 jest --runInBand --passWithNoTests',
      'jest',
    ]) {
      const found = judge(manifest({ scripts: { test } }));
      expect(rules(found)).toEqual(['P2']);
      expect(found[0].detail).toMatch(/exactly "jest --passWithNoTests"/);
    }
    expect(judge(manifest({ scripts: { test: 'jest --runInBand' } }))[0].detail).toMatch(
      /declared, never flagged: package\.json jestPreset\.inBand/
    );
    expect(judge(manifest({ scripts: { test: 'NODE_OPTIONS=--x jest' } }))[0].detail).toMatch(
      /NODE_OPTIONS is the CI step's env/
    );
    const missing = judge(manifest({ scripts: { build: 'tsc' } }));
    expect(rules(missing)).toEqual(['P2']);
    expect(missing[0].detail).toMatch(/no test script/);
  });

  test('P3: a declaration without its reason, or a jestPreset of another shape, is named; a reasoned one passes', () => {
    for (const jestPreset of [{ inBand: true }, { inBand: '' }, { inBand: '  ' }, { inBand: 1 }]) {
      const found = judge(manifest({ jestPreset }));
      expect(rules(found)).toEqual(['P3']);
      expect(found[0].detail).toMatch(/jestPreset\.inBand carries no reason/);
    }
    for (const jestPreset of ['inBand', ['inBand'], 1]) {
      const found = judge(manifest({ jestPreset }));
      expect(rules(found)).toEqual(['P3']);
      expect(found[0].detail).toMatch(/jestPreset is not an object/);
    }
    expect(judge(manifest({ jestPreset: {} }))).toEqual([]);
  });

  test('P3: the node-options declaration — flags without their reason, a reason without flags, flags that are not a list of node flags, a key outside the vocabulary — each named; a reasoned one passes', () => {
    const VM = '--experimental-vm-modules';
    expect(
      judge(
        manifest({
          jestPreset: {
            nodeOptions: [VM],
            reason: 'pptxgenjs 4.0.1 dynamic-imports node:fs (dist/pptxgen.cjs.js:4844)',
          },
        })
      )
    ).toEqual([]);
    expect(judge(manifest({ jestPreset: { inBand: 'one database', nodeOptions: [VM], reason: 'the flag' } }))).toEqual(
      []
    );
    for (const jestPreset of [
      { nodeOptions: [VM] },
      { nodeOptions: [VM], reason: '' },
      { nodeOptions: [VM], reason: 1 },
    ]) {
      const found = judge(manifest({ jestPreset }));
      expect(rules(found)).toEqual(['P3']);
      expect(found[0].detail).toMatch(/jestPreset\.nodeOptions carries no reason/);
    }
    const alone = judge(manifest({ jestPreset: { reason: 'a reason beside no flags' } }));
    expect(rules(alone)).toEqual(['P3']);
    expect(alone[0].detail).toMatch(/jestPreset\.reason without jestPreset\.nodeOptions/);
    for (const nodeOptions of [VM, [], ['experimental-vm-modules'], [1]]) {
      const found = judge(manifest({ jestPreset: { nodeOptions, reason: 'r' } }));
      expect(rules(found)).toEqual(['P3']);
      expect(found[0].detail).toMatch(/jestPreset\.nodeOptions is not a list of node flags/);
    }
    const typo = judge(manifest({ jestPreset: { inband: 'one database' } }));
    expect(rules(typo)).toEqual(['P3']);
    expect(typo[0].detail).toMatch(/jestPreset\.inband is no key the preset reads/);
  });

  test('the preset’s own package reads itself (preset: ./jest-preset.js); any other package naming that file deviates', () => {
    const own =
      "module.exports = {\n  preset: './jest-preset.js',\n  roots: ['<rootDir>/test'],\n  testMatch: ['**/?(*.)+(spec|test).js'],\n};\n";
    expect(judge(manifest({ name: '@proteinjs/jest-preset' }), own)).toEqual([]);
    expect(rules(judge(manifest(), own))).toEqual(['P1']);
  });

  test('drift over a tree names each deviating package once with every rule it breaks; describe() is one clause per package', () => {
    const drift = TestPractice.drift([
      { dir: 'common', manifest: manifest({ name: '@fixture/common' }), config: PRACTICE_CONFIG },
      {
        dir: 'server',
        manifest: manifest({
          name: '@fixture/server',
          scripts: { test: 'jest --runInBand' },
          jestPreset: { inBand: '' },
        }),
        config: PRACTICE_CONFIG,
      },
      { dir: 'drivers/spanner', manifest: manifest(), config: "module.exports = {\n  preset: 'ts-jest',\n};\n" },
      { dir: 'mobile', manifest: { name: '@fixture/mobile', scripts: { test: 'node --test a.mjs' } }, config: null },
    ]);
    expect(drift.map((p) => [p.dir, rules(p.deviations)])).toEqual([
      ['server', ['P2', 'P3']],
      ['drivers/spanner', ['P1']],
    ]);
    expect(TestPractice.describe(drift)).toMatch(
      /^server: P2 the test script is "jest --runInBand" .*; P3 jestPreset\.inBand carries no reason .* · drivers\/spanner: P1 jest\.config\.js names preset 'ts-jest'/
    );
  });
});

describe('one owner: the judge ships with the preset, the builder reads the judge’s spelling and ts-jest’s one floor', () => {
  test('the declaration’s spelling is the judge’s and the builder’s alike (one spelling, every reader)', () => {
    expect(JestPresetBuilder.DECLARATION_KEY).toBe(TestPractice.DECLARATION_KEY);
    expect(JestPresetBuilder.IN_BAND_KEY).toBe(TestPractice.IN_BAND_KEY);
    expect(JestPresetBuilder.NODE_OPTIONS_KEY).toBe(TestPractice.NODE_OPTIONS_KEY);
    expect(JestPresetBuilder.REASON_KEY).toBe(TestPractice.REASON_KEY);
    expect(TestPractice.DECLARATION_KEYS).toEqual([
      TestPractice.IN_BAND_KEY,
      TestPractice.NODE_OPTIONS_KEY,
      TestPractice.REASON_KEY,
    ]);
  });

  test('TS_JEST_FLOOR is the number the builder refuses below and accepts at, and the number the peer range states', () => {
    const [major, minor, patch] = TS_JEST_FLOOR.split('.').map(Number);
    const below = patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.99`;
    const build = (tsJestVersion) => () =>
      new JestPresetBuilder({ env: {}, packageDir: path.join(__dirname, 'no-such-dir'), tsJestVersion }).build();
    expect(build(below)).toThrow(new RegExp(`ts-jest >= ${TS_JEST_FLOOR.replace(/\\./g, '\\.')}`));
    expect(build(TS_JEST_FLOOR)).not.toThrow();
    expect(JestPresetBuilder.TS_JEST_FLOOR).toBe(TS_JEST_FLOOR);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { peerDependencies } = require('../package.json');
    expect(peerDependencies['ts-jest']).toMatch(new RegExp(`^>=${TS_JEST_FLOOR.replace(/\\./g, '\\.')} `));
  });

  test('the judge, the knobs and their types ship in the package (npm pack lists practice.js, practice.d.ts, knobs.js, knobs.d.ts): a consumer’s require resolves', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = JSON.parse(out)[0].files.map((f) => f.path);
    expect(files).toEqual(
      expect.arrayContaining([
        'practice.js',
        'practice.d.ts',
        'jest-preset.js',
        'JestPresetBuilder.js',
        'knobs.js',
        'knobs.d.ts',
      ])
    );
  });
});
