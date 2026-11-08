import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeclaredImports } from '../src/DeclaredImports';

/**
 * The declared-imports law (row 3276): every package an import names is a dependency the importing
 * package declares. The finding (row 3275): chat-common 1.127.0 shipped importing
 * `@proteinjs/conversation/dist/src/AnthropicModelRules` with no `@proteinjs/conversation` in its
 * package.json — green in its own CI (the hoisted node_modules put the module in reach), dead in a
 * consumer's verify (`Cannot find module`). Fixtures are small trees written under a temp dir at run
 * time; every assertion is an OUTCOME — the offenders the scan names, the lines the CLI prints, its
 * exit code.
 */

const made: string[] = [];
afterAll(() => {
  for (const dir of made) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type Files = Record<string, string | object>;

/** A tree on disk: `{ 'rel/path': text | json }`; returns its root. */
const tree = (files: Files): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-imports-'));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return root;
};

/** A lerna-shaped workspace (`packages/**`, the house's shape) whose packages are `{ dir: files }`. */
const workspace = (packages: Record<string, Files>): string => {
  const files: Files = {
    'lerna.json': { version: 'independent', packages: ['packages/**'] },
    'package.json': { name: 'root', private: true },
  };
  for (const [dir, own] of Object.entries(packages)) {
    for (const [rel, content] of Object.entries(own)) {
      files[`packages/${dir}/${rel}`] = content;
    }
  }
  return tree(files);
};

/** The offenders as `[label, file:line, specifier, undeclared]` rows, in the report's order. */
const rows = (root: string) =>
  new DeclaredImports({ root })
    .check()
    .offenders.map((o) => [o.package, `${o.file}:${o.line}`, o.specifier, o.undeclared]);

/** The CLI's printed lines and exit code. */
const cli = (argv: string[]) => {
  const lines: string[] = [];
  const exit = DeclaredImports.cli(argv, (line) => lines.push(line));
  return { lines, exit };
};

describe('the declared-imports law', () => {
  it("refuses an undeclared bare import with the exact line — the finding's shape (chat-common 1.127.0: ModelCatalogEntryValidity.ts:4 importing a subpath of @proteinjs/conversation, declared nowhere)", () => {
    const root = workspace({
      common: {
        'package.json': { name: '@fixture/common', version: '1.0.0', dependencies: { '@fixture/util': '^1.0.0' } },
        'src/ModelCatalogEntryValidity.ts': [
          "import { ModelCatalogEntry } from '@fixture/util';",
          '',
          '// the rules for the Anthropic family',
          "import { AnthropicModelRules } from '@proteinjs/conversation/dist/src/AnthropicModelRules';",
          '',
          'export const valid = (e: ModelCatalogEntry) => AnthropicModelRules.accepts(e);',
          '',
        ].join('\n'),
      },
    });
    expect(rows(root)).toEqual([
      [
        'common',
        'src/ModelCatalogEntryValidity.ts:4',
        '@proteinjs/conversation/dist/src/AnthropicModelRules',
        '@proteinjs/conversation',
      ],
    ]);
    const { lines, exit } = cli(['--check', '--root', root]);
    expect(lines).toEqual([
      "common  src/ModelCatalogEntryValidity.ts:4  @proteinjs/conversation/dist/src/AnthropicModelRules → undeclared '@proteinjs/conversation'",
      'declared-imports: 1 package, 1 file, 1 undeclared',
    ]);
    expect(exit).toBe(1);
  });

  it('a subpath import resolves to its package — a scoped one to `@scope/name`, an unscoped one to its first segment — and a declared package admits every subpath', () => {
    const root = workspace({
      common: {
        'package.json': {
          name: '@fixture/common',
          version: '1.0.0',
          dependencies: { '@proteinjs/conversation': '^6.20.8', lodash: '^4.17.21' },
        },
        'src/a.ts': [
          "import { AnthropicModelRules } from '@proteinjs/conversation/dist/src/AnthropicModelRules';",
          "import flow from 'lodash/fp/flow';",
          "import { chunk } from 'lodash';",
          'export const a = [AnthropicModelRules, flow, chunk];',
          '',
        ].join('\n'),
      },
    });
    expect(rows(root)).toEqual([]);
  });

  it('a type-only import or export-from is ignored (erased by the compiler); an import that carries a value beside an inline `type` modifier counts', () => {
    const root = workspace({
      common: {
        'package.json': { name: '@fixture/common', version: '1.0.0' },
        'src/types.ts': [
          "import type { Shape } from 'typeonly-pkg';",
          "import type Default from 'typeonly-default';",
          "import type * as NS from 'typeonly-ns';",
          "export type { Shape as Reshape } from 'typeonly-pkg';",
          "import { type Only, value } from 'mixed-pkg';",
          'export const t = [value] as [Shape, Default, NS, Only];',
          '',
        ].join('\n'),
      },
    });
    expect(rows(root)).toEqual([['common', 'src/types.ts:5', 'mixed-pkg', 'mixed-pkg']]);
  });

  it('a node builtin is ignored — bare (`fs`, `path`) and `node:`-prefixed (`node:path`, `node:test`), imported or required', () => {
    const root = workspace({
      common: {
        'package.json': { name: '@fixture/common', version: '1.0.0' },
        'src/io.ts': [
          "import * as fs from 'fs';",
          "import path from 'node:path';",
          "import { readFile } from 'fs/promises';",
          "const os = require('os');",
          "import { describe } from 'node:test';",
          'export const io = [fs, path, readFile, os, describe];',
          '',
        ].join('\n'),
      },
    });
    expect(rows(root)).toEqual([]);
  });

  it('a test file may import a devDependency; the same import from src is refused — devDependencies are the tests’ alone', () => {
    const root = workspace({
      common: {
        'package.json': {
          name: '@fixture/common',
          version: '1.0.0',
          devDependencies: { 'fixture-test-lib': '^2.0.0' },
        },
        'test/a.test.ts': "import { harness } from 'fixture-test-lib';\nexport const t = harness;\n",
        'test/helpers/deep.ts': "const { helper } = require('fixture-test-lib');\nmodule.exports = { helper };\n",
        'src/a.ts': "import { harness } from 'fixture-test-lib';\nexport const a = harness;\n",
      },
    });
    expect(rows(root)).toEqual([['common', 'src/a.ts:1', 'fixture-test-lib', 'fixture-test-lib']]);
  });

  it('a peer dependency is a declaration; so is an optional one', () => {
    const root = workspace({
      ui: {
        'package.json': {
          name: '@fixture/ui',
          version: '1.0.0',
          peerDependencies: { react: '>=18' },
          optionalDependencies: { fsevents: '^2.3.0' },
        },
        'src/View.tsx': [
          "import React from 'react';",
          "import { useState } from 'react';",
          "const fsevents = require('fsevents');",
          'export const View = () => <div>{[React, useState, fsevents].length}</div>;',
          '',
        ].join('\n'),
      },
    });
    expect(rows(root)).toEqual([]);
  });

  it('a workspace sibling declared by any range counts as declared (`*`, `workspace:*`, `file:`); a sibling imported and declared nowhere is refused like any package', () => {
    const root = workspace({
      common: {
        'package.json': { name: '@fixture/common', version: '1.0.0' },
        'src/index.ts': 'export const common = 1;\n',
      },
      ui: {
        'package.json': { name: '@fixture/ui', version: '1.0.0', dependencies: { '@fixture/common': '*' } },
        'src/index.ts': "import { common } from '@fixture/common';\nexport const ui = common;\n",
      },
      server: {
        'package.json': {
          name: '@fixture/server',
          version: '1.0.0',
          dependencies: { '@fixture/common': 'workspace:*', '@fixture/ui': 'file:../ui' },
        },
        'src/index.ts': [
          "import { common } from '@fixture/common';",
          "import { ui } from '@fixture/ui/dist/index';",
          'export const server = [common, ui];',
          '',
        ].join('\n'),
      },
      cli: {
        'package.json': { name: '@fixture/cli', version: '1.0.0' },
        'src/index.ts': "import { common } from '@fixture/common';\nexport const cli = common;\n",
      },
    });
    expect(rows(root)).toEqual([['cli', 'src/index.ts:1', '@fixture/common', '@fixture/common']]);
  });

  it('a commented-out import is ignored — a line comment, a block comment, a line inside a block — and so is an import spelled inside a string; the live import after them counts', () => {
    const root = workspace({
      common: {
        'package.json': { name: '@fixture/common', version: '1.0.0' },
        'src/a.ts': [
          "// import gone from 'gone-line';",
          "/* import gone2 from 'gone-block'; */",
          '/*',
          " * import gone3 from 'gone-inside';",
          " import gone4 from 'gone-inside-unstarred';",
          ' */',
          'const spelled = "import gone5 from \'gone-string\'";',
          'const required = \'require("gone-required")\';',
          "const url = 'https://example.invalid//not-a-comment'; import live from 'live-pkg';",
          'export const a = [spelled, required, url, live];',
          '',
        ].join('\n'),
      },
    });
    expect(rows(root)).toEqual([['common', 'src/a.ts:9', 'live-pkg', 'live-pkg']]);
  });

  it('an export-from, a require() and a dynamic import() name dependencies too, each at its own line; relative and absolute specifiers never do', () => {
    const root = workspace({
      common: {
        'package.json': { name: '@fixture/common', version: '1.0.0' },
        'src/a.ts': [
          "export * from 'exp-star';",
          "export { a as b } from 'exp-named';",
          "export * as ns from './local';",
          "const r = require('req-pkg');",
          "const lazy = () => import('dyn-pkg');",
          "const here = require('../sibling');",
          "const abs = require('/opt/thing');",
          'export const all = [r, lazy, here, abs];',
          '',
        ].join('\n'),
        'src/local.ts': 'export const local = 1;\n',
      },
    });
    expect(rows(root)).toEqual([
      ['common', 'src/a.ts:1', 'exp-star', 'exp-star'],
      ['common', 'src/a.ts:2', 'exp-named', 'exp-named'],
      ['common', 'src/a.ts:4', 'req-pkg', 'req-pkg'],
      ['common', 'src/a.ts:5', 'dyn-pkg', 'dyn-pkg'],
    ]);
  });

  it('the CLI: a clean tree prints the one summary line and exits 0; offenders are grouped by package; --root may name a single package; without --check it prints the usage and exits 2', () => {
    const clean = workspace({
      common: {
        'package.json': { name: '@fixture/common', version: '1.0.0', dependencies: { lodash: '^4' } },
        'src/a.ts': "import { chunk } from 'lodash';\nexport const a = chunk;\n",
        'src/b.ts': "import { a } from './a';\nexport const b = a;\n",
      },
      ui: {
        'package.json': { name: '@fixture/ui', version: '1.0.0', dependencies: { '@fixture/common': '*' } },
        'src/index.ts': "export * from '@fixture/common';\n",
        'test/index.test.ts': "import { b } from '@fixture/common';\nexport const t = b;\n",
      },
    });
    expect(cli(['--check', '--root', clean])).toEqual({
      lines: ['declared-imports: 2 packages, 4 files, 0 undeclared'],
      exit: 0,
    });

    const dirty = workspace({
      ui: {
        'package.json': { name: '@fixture/ui', version: '1.0.0' },
        'src/z.ts': "import z from 'zed';\nexport const uz = z;\n",
        'src/a.ts': "import a from 'alpha';\nexport const ua = a;\n",
      },
      common: {
        'package.json': { name: '@fixture/common', version: '1.0.0' },
        'src/m.ts': "import m from 'mu';\nexport const cm = m;\n",
      },
    });
    expect(cli(['--check', '--root', dirty])).toEqual({
      lines: [
        "common  src/m.ts:1  mu → undeclared 'mu'",
        "ui  src/a.ts:1  alpha → undeclared 'alpha'",
        "ui  src/z.ts:1  zed → undeclared 'zed'",
        'declared-imports: 2 packages, 3 files, 3 undeclared',
      ],
      exit: 1,
    });

    // --root at one package: its own package.json has no workspaces — the one package is the tree
    expect(cli(['--check', '--root', path.join(dirty, 'packages', 'common')])).toEqual({
      lines: ["common  src/m.ts:1  mu → undeclared 'mu'", 'declared-imports: 1 package, 1 file, 1 undeclared'],
      exit: 1,
    });

    const usage = cli(['--root', dirty]);
    expect(usage.exit).toBe(2);
    expect(usage.lines.join('\n')).toMatch(/usage: declared-imports --check \[--root <dir>\]/);
  });

  it('a tsconfig path alias is a local path, never a package: a specifier whose first segment is a directory under `baseUrl` (thought-common’s `src/tables/TagTable`) or that a `paths` key covers; a `paths` key aimed into node_modules is a package reach and stays judged', () => {
    const root = workspace({
      common: {
        'package.json': { name: '@fixture/common', version: '1.0.0' },
        'tsconfig.json': [
          '{',
          '  // tsc reads comments and trailing commas; so does the law',
          '  "compilerOptions": {',
          '    "baseUrl": ".",',
          '    "paths": {',
          '      "@app/*": ["./src/*"],',
          '      "@proteinjs/*": ["./node_modules/@proteinjs/*"],',
          '    },',
          '  },',
          '}',
          '',
        ].join('\n'),
        'src/tables/TagTable.ts': 'export const Tag = 1;\n',
        'src/services/ThoughtService.ts': [
          "import { Tag } from 'src/tables/TagTable';",
          "import { Tag as Aliased } from '@app/tables/TagTable';",
          "import { Reflection } from '@proteinjs/reflection';",
          'export const service = [Tag, Aliased, Reflection];',
          '',
        ].join('\n'),
      },
    });
    expect(rows(root)).toEqual([
      ['common', 'src/services/ThoughtService.ts:3', '@proteinjs/reflection', '@proteinjs/reflection'],
    ]);
  });

  it('a jest moduleNameMapper key whose target is a local file aliases a TEST file’s import (thought-ui’s `__real__/ThoughtEditor`); a key aimed at a node_modules copy or a require.resolve is a package reach and stays judged; a src file never reads the mapper', () => {
    const root = workspace({
      ui: {
        'package.json': { name: '@fixture/ui', version: '1.0.0' },
        'jest.config.js': [
          'module.exports = {',
          '  moduleNameMapper: {',
          "    // the real module behind a mock: '__real__/X' is the source file",
          "    '^__real__/ThoughtEditor$': '<rootDir>/src/editor/ThoughtEditor.tsx',",
          "    '^react$': '<rootDir>/node_modules/react',",
          "    '^uuid$': require.resolve('uuid', { paths: [__dirname] }),",
          "    '\\\\.(png|css)$': '<rootDir>/test/fileMock.js',",
          '  },',
          '};',
          '',
        ].join('\n'),
        'src/editor/ThoughtEditor.tsx': 'export const ThoughtEditor = () => null;\n',
        'test/editor.test.ts': [
          "const { ThoughtEditor } = require('__real__/ThoughtEditor');",
          "import React from 'react';",
          "import { v4 } from 'uuid';",
          'export const t = [ThoughtEditor, React, v4];',
          '',
        ].join('\n'),
        'src/mapped.ts': "import { ThoughtEditor } from '__real__/ThoughtEditor';\nexport const m = ThoughtEditor;\n",
      },
    });
    expect(rows(root)).toEqual([
      ['ui', 'src/mapped.ts:1', '__real__/ThoughtEditor', '__real__'],
      ['ui', 'test/editor.test.ts:2', 'react', 'react'],
      ['ui', 'test/editor.test.ts:3', 'uuid', 'uuid'],
    ]);
  });

  it('declaration files, dist/ and node_modules/ are never scanned; a self-import is declared by the package’s own name', () => {
    const root = workspace({
      common: {
        'package.json': { name: '@fixture/common', version: '1.0.0' },
        'src/types.d.ts': "import { X } from 'ambient-only';\nexport declare const x: X;\n",
        'src/dist/built.js': "const built = require('built-only');\nmodule.exports = { built };\n",
        'src/node_modules/stray/index.js': "require('stray-dep');\n",
        'dist/index.js': "require('dist-only');\n",
        'src/self.ts': "import { x } from '@fixture/common/dist/src/types';\nexport const self = x;\n",
      },
    });
    expect(rows(root)).toEqual([]);
    expect(cli(['--check', '--root', root]).lines).toEqual(['declared-imports: 1 package, 1 file, 0 undeclared']);
  });
});
