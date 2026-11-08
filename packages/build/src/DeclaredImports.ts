import * as fs from 'fs';
import * as path from 'path';
import { builtinModules } from 'module';

/**
 * DeclaredImports — THE DECLARED-IMPORTS LAW: every package an import names is a dependency the
 * importing package declares. chat-common 1.127.0 shipped importing
 * `@proteinjs/conversation/dist/src/AnthropicModelRules` with no `@proteinjs/conversation` in its
 * package.json: green in its own CI (the hoisted node_modules and a sibling's declaration put the
 * module in reach), dead in a consumer's verify as `Cannot find module`. The law is built once, here,
 * and reached from two doors — the `declared-imports` bin (a repo's _test.yml, a lane's worktree) and
 * a metarepo's land stage, which runs it over every package of a staged repo at the composed tip and
 * refuses by name before anything ships.
 *
 * THE RULE: for every package of the tree, every static import / export-from / require() / import()
 * specifier in src/** and test/** that names a PACKAGE must appear in that package's dependencies,
 * peerDependencies or optionalDependencies — devDependencies too for a test file (test/**, a
 * `__tests__/` directory, a `*.test.*` or `*.spec.*` file). A subpath specifier resolves to its
 * package (`@scope/name/dist/x` → `@scope/name`, `lodash/fp` → `lodash`); any range declares (a
 * workspace sibling by `*`, `workspace:` or `file:` counts); a package's own name is declared (a
 * self-import); a `require()` counts spread too (`...require('pkg')`, the stub shape). Never counted: a relative or
 * absolute path, a `#` import, a `node:` or builtin name, a scheme (`data:`), `import type` / `export type … from`, a
 * dynamic `import()` in a TYPE position (`doc: import('pkg').Node`, `typeof import('pkg')`, `Array<import('pkg').T>`,
 * `type T = import('pkg').T` — erased like `import type`; one in a value position counts: `await import('pkg')`,
 * `() => import('pkg')`, `import('pkg').then(…)`), a member `x.require(…)` (no module reach), and anything inside a
 * comment or a string. A
 * PATH ALIAS is never a package: a specifier a tsconfig `paths` key covers, or whose first segment is a directory
 * under the package's tsconfig `baseUrl` (`src/tables/TagTable` with `baseUrl: "."`), and — in a test file — one a
 * jest `moduleNameMapper` key matches; an alias whose target is a node_modules copy (`@proteinjs/*` →
 * `./node_modules/@proteinjs/*`, `^react$` → `<rootDir>/node_modules/react`) is a package reach and stays judged.
 *
 * THE SCAN AND ITS LIMITS: a tokenizer over each file's text — comments dropped, string literals
 * replaced by numbered placeholders, regex literals skipped where the usual heuristic puts one (after
 * `( , = : [ ! & | ? { } ;` or a keyword such as `return`; never right after `<`, a JSX closing tag, and only when
 * the literal closes on its line — a `/` with no closing `/` before the newline divides) — then four regular
 * expressions over the result, a dynamic `import()` read as a type by what surrounds it (a type keyword or `<`,
 * `|`, `&` before it; a member chain after it that is never called); never a TypeScript program, so the law runs
 * before any install or build, in seconds. It reads a LITERAL specifier only: a specifier built at run time
 * (`require(name)`, a template with `${}`), `require.resolve(…)`, `jest.mock('…')`, `jest.requireActual('…')`,
 * the loader half of a loader-prefixed specifier and a template literal nested in `${}` are outside what it sees;
 * a bare type-position `import('pkg')` with no member after it and no type keyword before it (`x: import('pkg')`)
 * reads as a value and counts (it fails safe). Files: src/** and test/** of each package with the extensions below,
 * never dist/, node_modules/ or a `.d.ts` (type-level). Packages: lerna.json `packages` (globs — `*`
 * one level, `**` any depth — ending at a directory that holds a package.json) or package.json
 * `workspaces`; a root with neither and a package.json of its own is the one package (`--root <pkg>`).
 */

export interface DeclaredImportsOptions {
  /** A workspace root (lerna.json `packages` or package.json `workspaces`) or one package's directory. */
  root: string;
}

export interface Offender {
  /** The package's directory under the root (`packages/` stripped): `common`, as a train manifest names it. */
  package: string;
  /** The package.json name of the importing package. */
  name: string;
  /** The file, relative to the package. */
  file: string;
  /** The 1-based line the statement starts on. */
  line: number;
  /** The specifier as written. */
  specifier: string;
  /** The package the specifier names and the package declares nowhere. */
  undeclared: string;
}

export interface DeclaredImportsReport {
  root: string;
  packages: number;
  files: number;
  offenders: Offender[];
}

interface ScannedPackage {
  dir: string;
  label: string;
  name: string;
  src: Set<string>;
  test: Set<string>;
  aliases: Aliases;
}

interface Found {
  specifier: string;
  line: number;
}

/** A package's path aliases: tsconfig `paths` keys and `baseUrl` (every file), jest `moduleNameMapper` keys (test files). */
interface Aliases {
  pathKeys: string[];
  baseUrl: string | null;
  mappers: RegExp[];
}

const USAGE = [
  'usage: declared-imports --check [--root <dir>]',
  '  --check        scan every package of the tree (lerna.json packages / package.json workspaces, or the one package',
  '                 at --root) for imports of packages it does not declare; exit 0 clean, 1 with one line per offender',
  '  --root <dir>   the workspace root or the package to scan (default: the current directory)',
];

export class DeclaredImports {
  static readonly SRC_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
  static readonly TEST_SECTIONS = [...DeclaredImports.SRC_SECTIONS, 'devDependencies'];
  static readonly SCANNED_ROOTS = ['src', 'test'];
  static readonly EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
  static readonly SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);
  /** lerna's default when lerna.json names no `packages`. */
  static readonly LERNA_DEFAULT_GLOBS = ['packages/*'];
  /** The jest configs read for moduleNameMapper aliases (as text; never executed). */
  static readonly JEST_CONFIGS = [
    'jest.config.js',
    'jest.config.cjs',
    'jest.config.mjs',
    'jest.config.ts',
    'jest.config.json',
  ];

  private readonly root: string;

  constructor(options: DeclaredImportsOptions) {
    this.root = path.resolve(options.root);
  }

  /** The scan: every package, every source file, every specifier judged; offenders sorted by package, file, line. */
  check(): DeclaredImportsReport {
    const packages = this.packages();
    let files = 0;
    const offenders: Offender[] = [];
    for (const pkg of packages) {
      for (const file of this.sourceFiles(pkg.dir)) {
        files += 1;
        const rel = path.relative(pkg.dir, file).split(path.sep).join('/');
        const isTest = DeclaredImports.isTestFile(rel);
        const declared = isTest ? pkg.test : pkg.src;
        const source = fs.readFileSync(file, 'utf8');
        for (const { specifier, line } of DeclaredImports.specifiersOf(source)) {
          const name = DeclaredImports.packageNameOf(specifier);
          if (!name || name === pkg.name || declared.has(name)) {
            continue;
          }
          if (DeclaredImports.isAlias(specifier, pkg, isTest)) {
            continue;
          }
          offenders.push({ package: pkg.label, name: pkg.name, file: rel, line, specifier, undeclared: name });
        }
      }
    }
    offenders.sort(
      (a, b) =>
        a.package.localeCompare(b.package) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.specifier.localeCompare(b.specifier)
    );
    return { root: this.root, packages: packages.length, files, offenders };
  }

  /** One line per offender, grouped by package (the report's order), then the count line. */
  static render(report: DeclaredImportsReport): string[] {
    const lines = report.offenders.map(
      (o) => `${o.package}  ${o.file}:${o.line}  ${o.specifier} → undeclared '${o.undeclared}'`
    );
    lines.push(
      `declared-imports: ${DeclaredImports.count(report.packages, 'package')}, ${DeclaredImports.count(
        report.files,
        'file'
      )}, ${report.offenders.length} undeclared`
    );
    return lines;
  }

  /** The bin's body: `--check [--root <dir>]`; exit 0 clean, 1 offenders, 2 usage or a root that is no tree. */
  static cli(argv: string[], out: (line: string) => void): number {
    let check = false;
    let root = process.cwd();
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--check') {
        check = true;
      } else if (arg === '--root' && argv[i + 1] !== undefined) {
        root = argv[i + 1];
        i += 1;
      } else if (arg.startsWith('--root=')) {
        root = arg.slice('--root='.length);
      } else {
        for (const line of [`declared-imports: unexpected argument ${arg}`, ...USAGE]) {
          out(line);
        }
        return 2;
      }
    }
    if (!check) {
      for (const line of USAGE) {
        out(line);
      }
      return 2;
    }
    let report: DeclaredImportsReport;
    try {
      report = new DeclaredImports({ root }).check();
    } catch (err) {
      out(`declared-imports: ${(err as Error).message}`);
      return 2;
    }
    for (const line of DeclaredImports.render(report)) {
      out(line);
    }
    return report.offenders.length ? 1 : 0;
  }

  /** The literal specifiers a source names, with the line each statement starts on. */
  static specifiersOf(source: string): Found[] {
    const { code, strings } = DeclaredImports.tokenize(source);
    const found: Found[] = [];
    const seen = new Set<string>();
    const lineAt = (index: number) => {
      let line = 1;
      for (let i = 0; i < index; i += 1) {
        if (code.charCodeAt(i) === 10) {
          line += 1;
        }
      }
      return line;
    };
    for (const { re, type, id, dynamic } of DeclaredImports.PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        if (type && m[type]) {
          continue; // `import type` / `export type … from`: erased by the compiler
        }
        if (dynamic && m[dynamic] === 'import' && DeclaredImports.isTypeImport(code, m.index + m[1].length)) {
          continue; // a type-position import(): erased by the compiler like `import type`
        }
        const text = strings[Number(m[id])];
        const key = `${m.index}:${text}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        found.push({ specifier: text, line: lineAt(m.index + m[1].length) });
      }
    }
    return found.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
  }

  /** The package a specifier names; null for what never counts (a path, a builtin, a scheme, a run-time template). */
  static packageNameOf(specifier: string): string | null {
    let s = specifier.trim();
    if (s.includes('!')) {
      s = s.slice(s.lastIndexOf('!') + 1); // a loader-prefixed specifier: the module after the last `!`
    }
    if (!s || s.startsWith('.') || s.startsWith('/') || s.startsWith('#') || s.includes('${')) {
      return null;
    }
    if (/^[A-Za-z][\w+.-]*:/.test(s)) {
      return null; // node:, data:, file:, http: — a builtin or a scheme, never a package
    }
    s = s.replace(/[?#].*$/, '');
    const m = s.startsWith('@') ? /^(@[^/]+\/[^/]+)/.exec(s) : /^([^/]+)/.exec(s);
    if (!m) {
      return null;
    }
    const name = m[1];
    if (DeclaredImports.BUILTINS.has(name) || /\s/.test(name)) {
      return null;
    }
    return name;
  }

  // ---- the tree -------------------------------------------------------------------------------

  private packages(): ScannedPackage[] {
    const globs = this.workspaceGlobs();
    const dirs = globs === null ? [this.root] : this.expand(globs);
    const packages: ScannedPackage[] = [];
    for (const dir of dirs) {
      const json = DeclaredImports.readJson(path.join(dir, 'package.json'));
      if (!json || typeof json.name !== 'string') {
        continue;
      }
      const rel = path.relative(this.root, dir).split(path.sep).join('/');
      packages.push({
        dir,
        label: rel ? rel.replace(/^packages\//, '') : path.basename(dir),
        name: json.name,
        src: DeclaredImports.declaredIn(json, DeclaredImports.SRC_SECTIONS),
        test: DeclaredImports.declaredIn(json, DeclaredImports.TEST_SECTIONS),
        aliases: DeclaredImports.aliasesOf(dir, json),
      });
    }
    return packages;
  }

  /** lerna.json `packages`, else package.json `workspaces`; null when the root is itself the one package. */
  private workspaceGlobs(): string[] | null {
    const lerna = DeclaredImports.readJson(path.join(this.root, 'lerna.json'));
    if (lerna) {
      return Array.isArray(lerna.packages) && lerna.packages.length
        ? lerna.packages
        : DeclaredImports.LERNA_DEFAULT_GLOBS;
    }
    const pkg = DeclaredImports.readJson(path.join(this.root, 'package.json'));
    if (!pkg) {
      throw new Error(`${this.root}: no lerna.json and no package.json — not a workspace root nor a package`);
    }
    const workspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : pkg.workspaces && Array.isArray(pkg.workspaces.packages)
        ? pkg.workspaces.packages
        : null;
    if (workspaces && workspaces.length) {
      return workspaces;
    }
    if (typeof pkg.name === 'string') {
      return null;
    }
    throw new Error(`${this.root}: package.json names no workspaces and no package name — not a tree the law reads`);
  }

  /** The directories the globs reach that hold a package.json: `*` one level, `**` any depth, a plain segment itself. */
  private expand(globs: string[]): string[] {
    const found = new Set<string>();
    for (const glob of globs) {
      const segments = glob.replace(/\/+$/, '').split('/').filter(Boolean);
      this.walk(this.root, segments, 0, found);
    }
    return [...found].sort();
  }

  private walk(dir: string, segments: string[], at: number, found: Set<string>): void {
    if (at === segments.length) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        found.add(dir);
      }
      return;
    }
    const segment = segments[at];
    if (segment === '**') {
      this.walk(dir, segments, at + 1, found);
      for (const child of this.childDirs(dir)) {
        this.walk(child, segments, at, found);
      }
    } else if (segment.includes('*')) {
      const re = new RegExp(`^${segment.split('*').map(DeclaredImports.escape).join('.*')}$`);
      for (const child of this.childDirs(dir)) {
        if (re.test(path.basename(child))) {
          this.walk(child, segments, at + 1, found);
        }
      }
    } else {
      const next = path.join(dir, segment);
      if (DeclaredImports.isDir(next)) {
        this.walk(next, segments, at + 1, found);
      }
    }
  }

  private childDirs(dir: string): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !DeclaredImports.SKIPPED_DIRS.has(e.name))
      .map((e) => path.join(dir, e.name))
      .sort();
  }

  /** src/** and test/** of a package: the source extensions, never dist/, node_modules/ or a `.d.ts`. */
  private sourceFiles(pkgDir: string): string[] {
    const files: string[] = [];
    const visit = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!DeclaredImports.SKIPPED_DIRS.has(entry.name)) {
            visit(file);
          }
        } else if (entry.isFile() && DeclaredImports.isSource(entry.name)) {
          files.push(file);
        }
      }
    };
    for (const sub of DeclaredImports.SCANNED_ROOTS) {
      visit(path.join(pkgDir, sub));
    }
    return files;
  }

  // ---- the aliases ----------------------------------------------------------------------------

  /** A specifier a tsconfig path alias covers, or (a test file) a jest moduleNameMapper key matches: a local path, never a package. */
  private static isAlias(specifier: string, pkg: ScannedPackage, isTest: boolean): boolean {
    const { pathKeys, baseUrl, mappers } = pkg.aliases;
    for (const key of pathKeys) {
      if (key === specifier || (key.endsWith('*') && specifier.startsWith(key.slice(0, -1)))) {
        return true;
      }
    }
    if (baseUrl !== null && !specifier.startsWith('@')) {
      const first = specifier.split('/')[0];
      if (first !== 'node_modules' && fs.existsSync(path.join(pkg.dir, baseUrl, first))) {
        return true;
      }
    }
    return isTest && mappers.some((re) => re.test(specifier));
  }

  /**
   * The package's aliases: tsconfig.json `compilerOptions.paths` keys whose every target is outside node_modules and its
   * `baseUrl`; jest `moduleNameMapper` keys (jest.config.*, package.json `jest`) whose target is a quoted local path
   * outside node_modules — a `require.resolve(…)` target or a node_modules path names a package and is no alias.
   */
  private static aliasesOf(dir: string, json: Record<string, any>): Aliases {
    const aliases: Aliases = { pathKeys: [], baseUrl: null, mappers: [] };
    const tsconfig = DeclaredImports.readJsonLoose(path.join(dir, 'tsconfig.json'));
    const options = tsconfig && tsconfig.compilerOptions;
    if (options && typeof options === 'object') {
      if (typeof options.baseUrl === 'string') {
        aliases.baseUrl = options.baseUrl;
      }
      if (options.paths && typeof options.paths === 'object') {
        for (const [key, targets] of Object.entries(options.paths as Record<string, unknown>)) {
          const list = Array.isArray(targets) ? (targets as unknown[]) : [];
          if (list.length && list.every((t) => typeof t === 'string' && !t.includes('node_modules'))) {
            aliases.pathKeys.push(key);
          }
        }
      }
    }
    const texts: string[] = [];
    for (const name of DeclaredImports.JEST_CONFIGS) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        texts.push(fs.readFileSync(file, 'utf8'));
      }
    }
    if (json.jest && typeof json.jest === 'object') {
      texts.push(JSON.stringify(json.jest));
    }
    for (const text of texts) {
      aliases.mappers.push(...DeclaredImports.mapperKeys(text));
    }
    return aliases;
  }

  /** The `moduleNameMapper` block's `'<key>': '<local target>'` pairs as regexes (the config read as text, comments dropped). */
  private static mapperKeys(text: string): RegExp[] {
    const keys: RegExp[] = [];
    const { code, strings } = DeclaredImports.tokenize(text);
    let at = code.indexOf('moduleNameMapper');
    while (at !== -1) {
      const open = code.indexOf('{', at);
      if (open === -1) {
        break;
      }
      let depth = 0;
      let close = open;
      for (; close < code.length; close += 1) {
        if (code[close] === '{') {
          depth += 1;
        } else if (code[close] === '}' && (depth -= 1) === 0) {
          break;
        }
      }
      const block = code.slice(open, close);
      const pair = /"§(\d+)"\s*:\s*"§(\d+)"/g;
      let m: RegExpExecArray | null;
      while ((m = pair.exec(block))) {
        const key = strings[Number(m[1])];
        const target = strings[Number(m[2])];
        if (target.includes('node_modules')) {
          continue;
        }
        try {
          keys.push(new RegExp(key));
        } catch {
          // a key that is no regex: jest would refuse the config; nothing to alias
        }
      }
      at = code.indexOf('moduleNameMapper', close);
    }
    return keys;
  }

  // ---- the text -------------------------------------------------------------------------------

  /**
   * The code with comments blanked (newlines kept), every string literal replaced by `"§<n>"` (a template's own
   * newlines re-emitted after it) and regex literals blanked where the heuristic reads one; `strings[n]` is the text.
   */
  private static tokenize(source: string): { code: string; strings: string[] } {
    let out = '';
    const strings: string[] = [];
    let tail = ''; // the last significant code characters, for the regex-literal heuristic
    const n = source.length;
    let i = 0;
    while (i < n) {
      const c = source[i];
      const d = source[i + 1];
      if (c === '/' && d === '/') {
        const end = source.indexOf('\n', i);
        const stop = end === -1 ? n : end;
        out += ' '.repeat(stop - i);
        i = stop;
        continue;
      }
      if (c === '/' && d === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end === -1 ? n : end + 2;
        out += source.slice(i, stop).replace(/[^\n]/g, ' ');
        i = stop;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        let text = '';
        while (j < n) {
          const ch = source[j];
          if (ch === '\\' && j + 1 < n) {
            text += DeclaredImports.unescape(source[j + 1]);
            j += 2;
            continue;
          }
          if (ch === c || (ch === '\n' && c !== '`')) {
            break;
          }
          text += ch;
          j += 1;
        }
        const stop = j < n && source[j] === c ? j + 1 : j;
        const index = strings.push(text) - 1;
        out += `"§${index}"${'\n'.repeat(DeclaredImports.newlines(source.slice(i, stop)))}`;
        i = stop;
        tail = '"';
        continue;
      }
      // a regex literal where the heuristic puts one — never right after `<` (a JSX closing tag: `</div>`), and only
      // when it closes on its line: a `/` with no closing `/` before the newline divides (a JSX text's `{done}/`), so
      // the newline stays and every later statement keeps its line
      if (c === '/' && source[i - 1] !== '<' && DeclaredImports.regexMayStart(tail)) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
          const ch = source[j];
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === '\n') {
            break;
          }
          if (inClass) {
            if (ch === ']') {
              inClass = false;
            }
          } else if (ch === '[') {
            inClass = true;
          } else if (ch === '/') {
            closed = true;
            break;
          }
          j += 1;
        }
        if (closed) {
          const stop = j + 1;
          out += ' '.repeat(stop - i);
          i = stop;
          tail = '/';
          continue;
        }
      }
      out += c;
      if (!/\s/.test(c)) {
        tail = (tail + c).slice(-12);
      }
      i += 1;
    }
    return { code: out, strings };
  }

  /** Where a `/` opens a regex literal rather than dividing: after an operator, a bracket, or a keyword that takes an expression. */
  private static regexMayStart(tail: string): boolean {
    if (!tail) {
      return true;
    }
    const last = tail[tail.length - 1];
    if ('(,=:[!&|?{};+-*%<>~^'.includes(last)) {
      return true;
    }
    const word = /[A-Za-z_$][\w$]*$/.exec(tail);
    return Boolean(word && DeclaredImports.EXPRESSION_KEYWORDS.has(word[0]));
  }

  /**
   * Whether the `import(` at `at` sits in a TYPE position — erased by the compiler like `import type`. Read from what
   * surrounds it: a type keyword before it (`typeof import(…)`, `keyof`, `as`, `extends`, `implements`, `satisfies`,
   * `is`, `infer`, `readonly`) or a type-only operator (`<`, `|`, `&` — never an expression's neighbor); else a member
   * chain after it that is never called (`import('pkg').Node`, `.Node<T>` — a value's chain is a call: `.then(`) or a
   * type continuation (`>`, `|`, `&`, `[`). What is left — `await import(…)`, `=> import(…)`, `? import(…) : import(…)`,
   * `[import(…), …]`, `{ key: import(…) }`, a bare `x: import('pkg')` — is read as a value and counts.
   */
  private static isTypeImport(code: string, at: number): boolean {
    const before = code.slice(Math.max(0, at - 40), at).trimEnd();
    const word = /[A-Za-z_$][\w$]*$/.exec(before);
    if (word && DeclaredImports.TYPE_KEYWORDS.has(word[0])) {
      return true;
    }
    const last = before[before.length - 1];
    if (last === '<' || last === '|' || last === '&') {
      return true;
    }
    let i = code.indexOf('(', at);
    if (i === -1) {
      return false;
    }
    for (let depth = 0; i < code.length; i += 1) {
      if (code[i] === '(') {
        depth += 1;
      } else if (code[i] === ')' && (depth -= 1) === 0) {
        break;
      }
    }
    i += 1;
    const limit = Math.min(code.length, i + 400);
    const skipSpace = () => {
      while (i < limit && /\s/.test(code[i])) {
        i += 1;
      }
    };
    skipSpace();
    let members = 0;
    while (code[i] === '.') {
      i += 1;
      skipSpace();
      const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 80));
      if (!name) {
        return false;
      }
      i += name[0].length;
      members += 1;
      skipSpace();
      if (code[i] === '<') {
        for (let depth = 0; i < limit; i += 1) {
          if (code[i] === '<') {
            depth += 1;
          } else if (code[i] === '>' && (depth -= 1) === 0) {
            i += 1;
            break;
          }
        }
        skipSpace();
      }
    }
    if (members) {
      return code[i] !== '(';
    }
    const next = code[i];
    return next === '>' || next === '|' || next === '&' || next === '[';
  }

  private static unescape(ch: string): string {
    return ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch;
  }

  private static newlines(text: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) {
        count += 1;
      }
    }
    return count;
  }

  // ---- small helpers --------------------------------------------------------------------------

  private static isTestFile(rel: string): boolean {
    return rel.startsWith('test/') || /(^|\/)__tests__\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
  }

  private static isSource(name: string): boolean {
    if (/\.d\.[cm]?ts$/.test(name)) {
      return false;
    }
    return DeclaredImports.EXTENSIONS.has(path.extname(name));
  }

  private static declaredIn(json: Record<string, unknown>, sections: string[]): Set<string> {
    const names = new Set<string>();
    for (const section of sections) {
      const block = json[section];
      if (block && typeof block === 'object') {
        for (const name of Object.keys(block as Record<string, unknown>)) {
          names.add(name);
        }
      }
    }
    return names;
  }

  private static readJson(file: string): Record<string, any> | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** A tsconfig's JSON: comments and trailing commas allowed (tsc's reading); null when absent or unreadable. */
  private static readJsonLoose(file: string): Record<string, any> | null {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const { code, strings } = DeclaredImports.tokenize(text);
    const restored = code
      .replace(/"§(\d+)"/g, (_, i) => JSON.stringify(strings[Number(i)]))
      .replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(restored);
    } catch {
      return null;
    }
  }

  private static isDir(dir: string): boolean {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }

  private static escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private static count(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  }

  private static readonly BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

  private static readonly EXPRESSION_KEYWORDS = new Set([
    'return',
    'typeof',
    'case',
    'do',
    'else',
    'in',
    'of',
    'instanceof',
    'new',
    'delete',
    'void',
    'throw',
    'yield',
    'await',
  ]);

  /** The words a type-position `import()` follows: `typeof import('pkg')`, `as import('pkg').T`, `extends import('pkg').T`. */
  private static readonly TYPE_KEYWORDS = new Set([
    'typeof',
    'keyof',
    'as',
    'extends',
    'implements',
    'satisfies',
    'is',
    'infer',
    'readonly',
  ]);

  /**
   * The four shapes over the tokenized code: `m[1]` the prefix, `type` the erasing keyword's group, `id` the
   * placeholder's, `dynamic` the `require`/`import` keyword's (a type-position `import()` is dropped by `isTypeImport`).
   */
  private static readonly PATTERNS: { re: RegExp; type: number | null; id: number; dynamic?: number }[] = [
    // import x from "§n" · import { a, type b } from "§n" · import * as ns from "§n" · import type … from "§n" (erased)
    { re: /(^|[^\w$.])import\s+(type\s+)?(?:[^;"]*?\s)?from\s*"§(\d+)"/g, type: 2, id: 3 },
    // import "§n" (a side-effect import)
    { re: /(^|[^\w$.])import\s*"§(\d+)"/g, type: null, id: 2 },
    // export * from "§n" · export * as ns from "§n" · export { a as b } from "§n" · export type { … } from "§n" (erased)
    { re: /(^|[^\w$.])export\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}"]*\})\s*from\s*"§(\d+)"/g, type: 2, id: 3 },
    // require("§n") · ...require("§n") (a spread — the stub shape) · import("§n"); a member `x.require(…)` is no module
    // reach and is never read; a type-position import() is dropped by `isTypeImport`
    { re: /(^|[^\w$.]|\.\.\.)(require|import)\s*\(\s*"§(\d+)"\s*[,)]/g, type: null, id: 3, dynamic: 2 },
  ];
}
