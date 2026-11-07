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

  test('P1: a spread entry is read as the spread it is — an expression spread (the fragment owner’s keys) passes beside the preset line and the typed key beside it is still named; an object literal spread IN PLACE is the package’s own writing and its preset key is named', () => {
    const spread =
      "const { fragment } = require('@n3xah/flow-server/jest');\nmodule.exports = {\n  preset: '@proteinjs/jest-preset',\n  ...fragment,\n  testTimeout: 120000,\n};\n";
    expect(judge(manifest(), spread)).toEqual([]);
    const spreadAndTyped =
      "module.exports = {\n  preset: '@proteinjs/jest-preset',\n  ...FlowServerJestPreset.fragment(),\n  maxWorkers: 2,\n};\n";
    expect(p1(judge(manifest(), spreadAndTyped))[0]).toMatch(/types maxWorkers/);
    // the outcome of the spread read: a literal written in place and spread carries the package's OWN keys — a preset
    // key there is named (no road smuggles maxWorkers past the law), a seam there passes; a nested in-place spread the same
    const inPlace =
      "module.exports = {\n  preset: '@proteinjs/jest-preset',\n  ...{ roots: ['<rootDir>/test'], maxWorkers: 2 },\n};\n";
    expect(p1(judge(manifest(), inPlace))).toEqual([expect.stringMatching(/types maxWorkers/)]);
    expect(
      judge(
        manifest(),
        "module.exports = {\n  preset: '@proteinjs/jest-preset',\n  ...{ roots: ['<rootDir>/test'] },\n};\n"
      )
    ).toEqual([]);
    expect(
      p1(
        judge(
          manifest(),
          "module.exports = {\n  preset: '@proteinjs/jest-preset',\n  ...{ ...{ testEnvironment: 'node' } },\n};\n"
        )
      )
    ).toEqual([expect.stringMatching(/types testEnvironment/)]);
    // the preset line itself may ride an in-place literal: it is the package's own writing too
    expect(
      judge(manifest(), "module.exports = { ...{ preset: '@proteinjs/jest-preset' }, roots: ['<rootDir>/test'] };\n")
    ).toEqual([]);
    // the read's shape: an expression spread is recorded as the spread it is, never read through
    expect(TestPractice.readConfig(spread).spreads).toEqual(['fragment']);
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

  test('the judge and its types ship in the package (npm pack lists practice.js and practice.d.ts): a consumer’s require resolves', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = JSON.parse(out)[0].files.map((f) => f.path);
    expect(files).toEqual(
      expect.arrayContaining(['practice.js', 'practice.d.ts', 'jest-preset.js', 'JestPresetBuilder.js', 'knobs.js'])
    );
  });
});
