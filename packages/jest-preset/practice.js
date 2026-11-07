'use strict';
/**
 * THE ONE CI TEST PRACTICE's judge (DECISIONS 1121, 2026-11-07: "all of our n3xah and n3xa repos need to follow the
 * same practice … make sure new ones follow the practice"; PROCESS.md "Testing"): a PURE READ of a package's
 * package.json and jest.config.js that names each deviation from the practice by rule — no jest run, no require of the
 * config (a config requires this preset, ts-jest and the package's seams; a tree read at a git sha has none of them
 * installed). The practice's owner is this package (JestPresetBuilder states P1–P4 whole), so its judge ships from
 * here too — `require('@proteinjs/jest-preset/practice')` — and every reader reads ONE judge: the land tool's law
 * (`land stage` refuses a deviating tip, `land release` a composed sha, `land practice <repo>` prints the census), and
 * the component template's own suite (a repo started from the template starts right). Nothing here touches the
 * filesystem: the caller hands in the parsed package.json and the config's text — and, as `modules`, the texts of the
 * local modules the config requires (`localRequires` names them), read by the same rule.
 *
 *   P1 the config — jest.config.js is `module.exports = { preset: '@proteinjs/jest-preset', <the package's OWN seams> }`
 *      (this package's own config names its entry file, `preset: './jest-preset.js'`): never `preset: 'ts-jest'`, never
 *      a top-level `transform`, `testEnvironment`, `maxWorkers` or `workerIdleMemoryLimit` (the four are the preset's:
 *      transpile-only ts-jest, jsdom by the per-file docblock, in band by P3's declaration, the heap by the preset's
 *      knob). The read is of the exported OBJECT LITERAL — its top-level entries in any layout (one line, many lines,
 *      any indent, CRLF, `const config = {…}; module.exports = config;`), comments stripped; an export that is not an
 *      object literal (a require, an Object.assign, a function) is unreadable and deviates by name. A spread entry
 *      (`...fragment`) is read as the spread it is: the keys it carries belong to the fragment's owner, who keeps them in
 *      the practice — the law judges what the package WRITES; so an object literal spread IN PLACE (`...{ maxWorkers: 2 }`)
 *      IS the package's writing and is read through, its keys the package's own (no road smuggles a preset key).
 *      And the config never reads or writes the PROCESS
 *      (PROCESS_READS, named by line in the config and in any local module it requires): process.env written,
 *      process.env.NODE_OPTIONS / process.argv / process.execArgv read, process.exit — the one owner of a node flag and
 *      of the run's mode is P3's declaration through the preset (thought-export's round-1 seam joined NODE_OPTIONS and
 *      refused an in-process run from its config: a second mechanism beside the preset's, row 3260).
 *   P2 the script — `scripts.test` is exactly `jest --passWithNoTests`: never `--runInBand`, never a typed NODE_OPTIONS,
 *      never a bare `jest` (a package with no suite yet reds the leg otherwise).
 *   P3 the declaration — a `jestPreset` key is an object over a closed vocabulary (inBand, nodeOptions, reason — a key
 *      outside it is named, never read as nothing); its `inBand`, when present, is a non-empty string, the reason (the
 *      builder sets maxWorkers 1 from it and ignores JEST_WORKERS); its `nodeOptions`, when present, is a non-empty list
 *      of node flags with `reason` beside it, a non-empty string (the builder starts jest's workers under the flags and
 *      refuses an in-process run that lacks them); a later lift of either is its own change with proof.
 *
 * UNDER THE LAW: a package whose `test` script invokes jest, or that carries a jest.config.js at its root. A package
 * tested by node:test, or with neither, is outside it.
 */

/** ts-jest's floor, THE ONE NUMBER: below it ts-jest ignores tsconfig.isolatedModules (the transpile-only road this preset exists for) — the builder refuses it at config load, the peer range states it, the template's suite reads it. */
const TS_JEST_FLOOR = '29.3.0';

class TestPractice {
  /** The house preset, as a package's config names it. */
  static PRESET = '@proteinjs/jest-preset';
  /** This package's own config names itself by its entry file (its suite runs THROUGH the preset). */
  static OWN_PRESET = './jest-preset.js';
  /** The one test script. */
  static SCRIPT = 'jest --passWithNoTests';
  /** The config file the law reads. */
  static CONFIG = 'jest.config.js';
  /** The declaration's spelling — the one the builder reads (JestPresetBuilder takes it from here). */
  static DECLARATION_KEY = 'jestPreset';
  static IN_BAND_KEY = 'inBand';
  /** The node-options declaration: the flags jest's workers start under, with REASON_KEY beside them. */
  static NODE_OPTIONS_KEY = 'nodeOptions';
  static REASON_KEY = 'reason';
  /** The declaration's whole vocabulary — the builder refuses, and the judge names, a key outside it. */
  static DECLARATION_KEYS = [TestPractice.IN_BAND_KEY, TestPractice.NODE_OPTIONS_KEY, TestPractice.REASON_KEY];
  /** The top-level keys a package never types: the preset's. */
  static PRESET_KEYS = ['transform', 'testEnvironment', 'maxWorkers', 'workerIdleMemoryLimit'];
  /**
   * P1's process reads — what a jest.config.js (or a local module it requires) never does, each named by line: the
   * process is the preset's to shape (P3's declaration carries a node flag; the builder joins it to NODE_OPTIONS for the
   * workers and refuses an in-process run that lacks it) — a config that joins NODE_OPTIONS itself, reads the run's
   * mode from process.argv / process.execArgv, or exits is a second owner beside it. Each kind is a regular expression
   * over one line of the text with comments and prose strings blanked (`blank`; a computed key's string —
   * `process.env['NODE_OPTIONS']` — stays). A read of another env key (`process.env.CI`) is a seam's input, not named.
   */
  static PROCESS_READS = [
    {
      what: 'process.env.NODE_OPTIONS',
      re: /\bprocess\.env\s*(?:\.\s*NODE_OPTIONS\b|\[\s*(['"`])NODE_OPTIONS\1\s*\])/,
    },
    {
      what: 'a write to process.env',
      re: /\bdelete\s+process\.env\b|\bObject\.assign\(\s*process\.env\b|\bprocess\.env\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]\n]*\])\s*(?:[+\-*/%&|^]|\*\*|<<|>>>?|\?\?|&&|\|\|)?=(?!=)/,
    },
    { what: 'process.execArgv', re: /\bprocess\.execArgv\b/ },
    { what: 'process.argv', re: /\bprocess\.argv\b/ },
    { what: 'process.exit', re: /\bprocess\.exit\s*\(/ },
  ];
  static RULES = {
    P1: "the config is the house preset plus the package's own seams",
    P2: `the test script is exactly "${TestPractice.SCRIPT}"`,
    P3: 'a declaration (in band, node options) carries its reason',
  };

  /**
   * Every deviating package of a tree: `packages` is [{ dir, manifest, config }] — `manifest` the parsed package.json,
   * `config` the jest.config.js text or null when the tree has none. Returns [{ dir, name, deviations }] for the
   * packages under the law that deviate, in the order given; [] = the tree follows the practice.
   */
  static drift(packages) {
    const out = [];
    for (const { dir, manifest, config, modules } of packages) {
      const deviations = TestPractice.judge({ manifest, config, modules });
      if (deviations.length) {
        out.push({ dir, name: (manifest && manifest.name) || dir, deviations });
      }
    }
    return out;
  }

  /**
   * The deviations of one package — [{ rule, detail }] — or [] (follows the practice, or outside the law). `modules`,
   * when the caller hands them in, are the local modules the config requires ([{ path, text }]; `localRequires` names
   * the specifiers), read for the process reads the config itself never makes.
   */
  static judge({ manifest, config, modules = [] }) {
    if (!TestPractice.underTheLaw(manifest, config)) {
      return [];
    }
    const scripts = (manifest && manifest.scripts) || {};
    const found = [];
    const say = (rule, detail) => found.push({ rule, detail });
    // P1 — the config
    if (config === null || config === undefined) {
      say(
        'P1',
        `no ${TestPractice.CONFIG} (the practice: preset: '${TestPractice.PRESET}' plus the package's own seams)`
      );
    } else {
      const read = TestPractice.readConfig(config);
      if (read === null) {
        say(
          'P1',
          `${TestPractice.CONFIG} does not export an object literal the law can read (the practice: module.exports = { preset: '${TestPractice.PRESET}', <the package's own seams> } — never a require, an Object.assign or a function)`
        );
      } else {
        const { keys } = read;
        const preset = keys.get('preset');
        const own = manifest && manifest.name === TestPractice.PRESET ? TestPractice.OWN_PRESET : null;
        if (preset === undefined) {
          say(
            'P1',
            `${TestPractice.CONFIG} carries no preset: '${TestPractice.PRESET}' (the house preset plus the package's own seams, never a config of its own)`
          );
        } else if (preset !== TestPractice.PRESET && preset !== own) {
          say(
            'P1',
            `${TestPractice.CONFIG} names preset ${preset === null ? '(not a string)' : `'${preset}'`} (the practice: preset: '${TestPractice.PRESET}')`
          );
        }
        const typed = TestPractice.PRESET_KEYS.filter((k) => keys.has(k));
        if (typed.length) {
          say(
            'P1',
            `${TestPractice.CONFIG} types ${typed.join(', ')} (the preset's — never re-declared; jsdom is the per-file docblock, in band is package.json ${TestPractice.DECLARATION_KEY}.${TestPractice.IN_BAND_KEY})`
          );
        }
      }
    }
    if (config !== null && config !== undefined) {
      TestPractice.sayProcessReads(say, TestPractice.CONFIG, config);
    }
    for (const { path: file, text } of modules) {
      TestPractice.sayProcessReads(say, file, text);
    }
    // P2 — the script
    const test = scripts.test;
    if (test === undefined) {
      say('P2', `no test script (the practice: exactly "${TestPractice.SCRIPT}")`);
    } else if (test !== TestPractice.SCRIPT) {
      say(
        'P2',
        `the test script is ${JSON.stringify(test)} (the practice: exactly "${TestPractice.SCRIPT}"${
          /--runInBand/.test(test)
            ? `; one suite at a time is declared, never flagged: package.json ${TestPractice.DECLARATION_KEY}.${TestPractice.IN_BAND_KEY} with the reason`
            : ''
        }${
          /NODE_OPTIONS/.test(test)
            ? "; NODE_OPTIONS is the CI step's env (a heap is the preset's workerIdleMemoryLimit), never the script's"
            : ''
        })`
      );
    }
    // P3 — the declaration
    const declaration =
      manifest && manifest[TestPractice.DECLARATION_KEY] !== undefined
        ? manifest[TestPractice.DECLARATION_KEY]
        : undefined;
    if (declaration !== undefined) {
      const { DECLARATION_KEY, IN_BAND_KEY, NODE_OPTIONS_KEY, REASON_KEY, DECLARATION_KEYS } = TestPractice;
      const shaped = declaration && typeof declaration === 'object' && !Array.isArray(declaration);
      if (!shaped) {
        say(
          'P3',
          `${DECLARATION_KEY} is not an object (the declaration: { "${IN_BAND_KEY}": "<the reason>" } and/or { "${NODE_OPTIONS_KEY}": ["<node flag>"], "${REASON_KEY}": "<the reason>" })`
        );
      } else {
        const unknown = Object.keys(declaration).filter((k) => !DECLARATION_KEYS.includes(k));
        if (unknown.length) {
          say(
            'P3',
            `${unknown.map((k) => `${DECLARATION_KEY}.${k}`).join(', ')} is no key the preset reads (the declaration's keys: ${DECLARATION_KEYS.join(', ')}; a key read as nothing runs the package as if it declared nothing)`
          );
        }
        const reason = declaration[IN_BAND_KEY];
        if (reason !== undefined && (typeof reason !== 'string' || !reason.trim())) {
          say(
            'P3',
            `${DECLARATION_KEY}.${IN_BAND_KEY} carries no reason (a non-empty string: why this package runs one suite at a time)`
          );
        }
        const flags = declaration[NODE_OPTIONS_KEY];
        const why = declaration[REASON_KEY];
        if (flags !== undefined) {
          const isFlag = (flag) => typeof flag === 'string' && /^-\S+$/.test(flag.trim());
          if (!Array.isArray(flags) || !flags.length || !flags.every(isFlag)) {
            say(
              'P3',
              `${DECLARATION_KEY}.${NODE_OPTIONS_KEY} is not a list of node flags (["--experimental-vm-modules"]: the flags jest's workers start under)`
            );
          }
          if (typeof why !== 'string' || !why.trim()) {
            say(
              'P3',
              `${DECLARATION_KEY}.${NODE_OPTIONS_KEY} carries no reason (${DECLARATION_KEY}.${REASON_KEY}, a non-empty string: why this package's workers need the flags)`
            );
          }
        } else if (why !== undefined) {
          say(
            'P3',
            `${DECLARATION_KEY}.${REASON_KEY} without ${DECLARATION_KEY}.${NODE_OPTIONS_KEY} (the reason belongs beside the flags it explains; the in-band declaration carries its reason as its value)`
          );
        }
      }
    }
    return found;
  }

  /** A package is under the law when its test script invokes jest or it carries a jest.config.js. */
  static underTheLaw(manifest, config) {
    const test = manifest && manifest.scripts && manifest.scripts.test;
    return (typeof test === 'string' && /\bjest\b/.test(test)) || (config !== null && config !== undefined);
  }

  /** P1's process reads of one file, said once with every line: `<file> reads or writes the process at 7 (…), 9 (…) — …`. */
  static sayProcessReads(say, file, text) {
    const reads = TestPractice.processReads(text);
    if (!reads.length) {
      return;
    }
    const { DECLARATION_KEY, IN_BAND_KEY, NODE_OPTIONS_KEY } = TestPractice;
    say(
      'P1',
      `${file} reads or writes the process at ${reads.map((r) => `${r.line} (${r.kinds.join(' + ')})`).join(', ')} — a config never mutates the process or reads the run's mode: a node flag is package.json ${DECLARATION_KEY}.${NODE_OPTIONS_KEY} with its reason, one suite at a time is ${DECLARATION_KEY}.${IN_BAND_KEY}; the preset starts jest's workers under the declared flags and refuses an in-process run that lacks them`
    );
  }

  /**
   * The lines of `text` that read or write the process (PROCESS_READS) — [{ line, kinds }], 1-based, each kind once —
   * over the text with its comments and prose strings blanked; [] when none.
   */
  static processReads(text) {
    const out = [];
    TestPractice.blank(text.replace(/\r\n?/g, '\n'))
      .split('\n')
      .forEach((line, i) => {
        const kinds = TestPractice.PROCESS_READS.filter(({ re }) => re.test(line)).map(({ what }) => what);
        if (kinds.length) {
          out.push({ line: i + 1, kinds });
        }
      });
    return out;
  }

  /**
   * The local modules a text requires — the `require('./…')` / `require('../…')` specifiers, in order, each once —
   * for the caller to read and hand to `judge` as `modules`. A package's require (`@n3xah/flow-server/test/jest-preset`)
   * is that package's own practice, read where it is published.
   */
  static localRequires(text) {
    const src = TestPractice.blank(text.replace(/\r\n?/g, '\n'), { strings: false });
    const found = [];
    const re = /\brequire\s*\(\s*(['"])(\.\.?\/[^'"\n]+)\1\s*\)/g;
    let match;
    while ((match = re.exec(src)) !== null) {
      if (!found.includes(match[2])) {
        found.push(match[2]);
      }
    }
    return found;
  }

  /**
   * The text with its comments blanked and, unless `strings` is false, its string literals' prose blanked — every
   * line kept at its number (a blank is a space; newlines stay), so a read names the line it sits on. A string whose
   * body is identifier-shaped (`'NODE_OPTIONS'`, a computed key) keeps its body; a template's `${…}` is read as text.
   */
  static blank(text, { strings = true } = {}) {
    const out = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i];
      const next = text[i + 1];
      if (c === '/' && next === '*') {
        const end = text.indexOf('*/', i + 2);
        const stop = end === -1 ? n : end + 2;
        for (let j = i; j < stop; j += 1) {
          out.push(text[j] === '\n' ? '\n' : ' ');
        }
        i = stop;
      } else if (c === '/' && next === '/') {
        while (i < n && text[i] !== '\n') {
          out.push(' ');
          i += 1;
        }
      } else if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (j < n && text[j] !== c) {
          if (text[j] === '\\') {
            j += 1;
          }
          j += 1;
        }
        const close = Math.min(j, n);
        const body = text.slice(i + 1, close);
        if (!strings || /^[A-Za-z_$][\w$]*$/.test(body)) {
          out.push(text.slice(i, Math.min(close + 1, n)));
        } else {
          out.push(c);
          for (const ch of body) {
            out.push(ch === '\n' ? '\n' : ' ');
          }
          if (j < n) {
            out.push(c);
          }
        }
        i = close + 1;
      } else {
        out.push(c);
        i += 1;
      }
    }
    return out.join('');
  }

  /**
   * The refusal's text: one clause per deviating package — `ui: P2 the test script is "jest --runInBand" (…); P1 …` —
   * each rule named by its letter so the reader finds it in PROCESS.md's testing section.
   */
  static describe(drift) {
    return drift.map((p) => `${p.dir}: ${p.deviations.map((d) => `${d.rule} ${d.detail}`).join('; ')}`).join(' · ');
  }

  /**
   * The config's exported object literal, read entry by entry: { keys, spreads } — `keys` a Map of every top-level
   * key → its value when a plain string literal, else null (an object literal spread in place is read through into it);
   * `spreads` the expressions the other top-level `...` entries carry (the fragment owners' keys, not read). The literal is found behind `module.exports =` (the literal itself, or the name of a `const`/`let`/`var`
   * bound to one) in the comment-stripped, LF-normalized text and scanned by its own braces — any layout. Null when
   * the text exports no object literal the scan can read.
   */
  static readConfig(text) {
    const literal = TestPractice.exportedLiteral(text);
    if (literal === null) {
      return null;
    }
    const keys = new Map();
    const spreads = [];
    TestPractice.readEntries(literal, keys, spreads);
    return { keys, spreads };
  }

  /**
   * A literal's body read into `keys` and `spreads`: a spread of an object literal written in place (`...{ … }`) is the
   * package's own writing — read through, its entries joining `keys` (nested in-place spreads the same) — while a spread
   * of any other expression (`...fragment`, `...Preset.fragment()`) names the fragment owner's keys and joins `spreads`.
   */
  static readEntries(body, keys, spreads) {
    for (const entry of TestPractice.entriesOf(body)) {
      if (entry.startsWith('...')) {
        const expression = entry.slice(3).trim();
        if (expression.startsWith('{')) {
          const end = TestPractice.closeOf(expression, 0);
          if (end !== -1) {
            TestPractice.readEntries(expression.slice(1, end), keys, spreads);
          }
        } else {
          spreads.push(expression);
        }
        continue;
      }
      const named = /^([A-Za-z_$][\w$]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*(?::\s*([\s\S]*))?$/.exec(entry);
      const computed = named ? null : /^\[\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*\]\s*:\s*([\s\S]*)$/.exec(entry);
      const match = named || computed;
      if (!match) {
        // a method (`foo() {…}`), a getter, a key the scan does not spell: present, unreadable, never a preset key
        continue;
      }
      const key = match[1].replace(/^(['"])(.*)\1$/, '$2');
      const value = match[2] === undefined ? null : /^'((?:[^'\\]|\\.)*)'$|^"((?:[^"\\]|\\.)*)"$/.exec(match[2].trim());
      keys.set(key, value ? (value[1] !== undefined ? value[1] : value[2]) : null);
    }
  }

  /** The Map of top-level keys alone (readConfig's `keys`), or null when the config is unreadable. */
  static topLevelKeys(text) {
    const read = TestPractice.readConfig(text);
    return read === null ? null : read.keys;
  }

  /** The body of the exported object literal (between its braces), or null. */
  static exportedLiteral(text) {
    const src = TestPractice.stripComments(text.replace(/\r\n?/g, '\n'));
    const exported = /module\.exports\s*=\s*/.exec(src);
    if (!exported) {
      return null;
    }
    let at = exported.index + exported[0].length;
    if (src[at] !== '{') {
      const name = /^([A-Za-z_$][\w$]*)\s*;?/.exec(src.slice(at));
      if (!name) {
        return null;
      }
      const bound = new RegExp(`(?:const|let|var)\\s+${name[1]}\\s*=\\s*`).exec(src);
      if (!bound) {
        return null;
      }
      at = bound.index + bound[0].length;
      if (src[at] !== '{') {
        return null;
      }
    }
    const end = TestPractice.closeOf(src, at);
    return end === -1 ? null : src.slice(at + 1, end);
  }

  /** The top-level entries of an object literal's body, split at the commas outside strings and brackets, trimmed, empties dropped. */
  static entriesOf(body) {
    const entries = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i];
      if (quote) {
        if (c === '\\') {
          i += 1;
        } else if (c === quote) {
          quote = null;
        }
      } else if (c === "'" || c === '"' || c === '`') {
        quote = c;
      } else if (c === '{' || c === '[' || c === '(') {
        depth += 1;
      } else if (c === '}' || c === ']' || c === ')') {
        depth -= 1;
      } else if (c === ',' && depth === 0) {
        entries.push(body.slice(start, i));
        start = i + 1;
      }
    }
    entries.push(body.slice(start));
    return entries.map((e) => e.trim()).filter(Boolean);
  }

  /** The index of the brace closing the one at `open`, strings and nested brackets honored; -1 when unbalanced. */
  static closeOf(src, open) {
    let depth = 0;
    let quote = null;
    for (let i = open; i < src.length; i += 1) {
      const c = src[i];
      if (quote) {
        if (c === '\\') {
          i += 1;
        } else if (c === quote) {
          quote = null;
        }
      } else if (c === "'" || c === '"' || c === '`') {
        quote = c;
      } else if (c === '{' || c === '[' || c === '(') {
        depth += 1;
      } else if (c === '}' || c === ']' || c === ')') {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  /** The text without its comments — block comments and `//` comments outside string literals (a URL in a string stays). */
  static stripComments(text) {
    const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, '');
    return noBlocks
      .split('\n')
      .map((line) => {
        let quote = null;
        for (let i = 0; i < line.length; i += 1) {
          const c = line[i];
          if (quote) {
            if (c === '\\') {
              i += 1;
            } else if (c === quote) {
              quote = null;
            }
          } else if (c === "'" || c === '"' || c === '`') {
            quote = c;
          } else if (c === '/' && line[i + 1] === '/') {
            return line.slice(0, i);
          }
        }
        return line;
      })
      .join('\n');
  }
}

module.exports = { TestPractice, TS_JEST_FLOOR };
