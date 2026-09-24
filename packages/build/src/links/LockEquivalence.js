/**
 * LOCK EQUIVALENCE — the installed graph as the lock describes it, before and after a departure's
 * floors chore (n3xa's LANDING_TRAINS §1.4p, guard 1: the publish-skip / golden equivalence is
 * judged by the INSTALLED GRAPH, never by a file list). ONE predicate, kept in two places: here
 * (`@proteinjs/build`, run by `link-workspace prove` in the publish run's build job) and, verbatim,
 * as `scripts/ci/LockEquivalence.js` in the n3xa metarepo (the land tool judges the stamp on the Mac
 * before the push). Copy the file whole when it changes — the VerifiedTree.js discipline.
 *
 * Two package-lock.json texts are EQUIVALENT over `linked` (the package names the verify linked
 * from source) when every entry is byte-identical except:
 *   - the linked packages' own entries (`node_modules/<name>`, hoisted or nested): their
 *     `version` / `resolved` / `integrity` / dependency sections move with the mint;
 *   - the root entry's (`""`) dependency ranges on linked names (the floors the chore raised),
 *     and the lock's own top-level `packages[""].version` / `version` when the tree's package.json
 *     version itself is a linked name's (a lerna sibling — never the case for a consumer);
 * A stray transitive move — the stamp pulling a different version of ANY other package through the
 * lock, an entry added or removed, a linked package appearing a second time (a split) — is NOT
 * equivalent: the verify tested one graph and the mint would install another. The verdict names
 * every difference by lock path and field.
 *
 * `isVersionOnlyDiff(unifiedDiff)`: every changed line of a package.json diff is a version line
 * (a `"name": "<range>"` pair or a `"version"` field) — the floors chore's package.json shape.
 */
class LockEquivalence {
  /** { equivalent, differences: [{ path, field, before, after, why }] } for the two lock texts over `linked` names. */
  static judge(beforeText, afterText, { linked = [] } = {}) {
    const before = LockEquivalence.parse(beforeText, 'before');
    const after = LockEquivalence.parse(afterText, 'after');
    const linkedNames = new Set(linked);
    const differences = [];
    for (const key of ['name', 'version', 'lockfileVersion', 'requires']) {
      if (!LockEquivalence.same(before[key], after[key])) {
        differences.push({
          path: '',
          field: key,
          before: before[key],
          after: after[key],
          why: 'the lock header changed',
        });
      }
    }
    const beforePackages = before.packages || {};
    const afterPackages = after.packages || {};
    const keys = [...new Set([...Object.keys(beforePackages), ...Object.keys(afterPackages)])].sort();
    for (const key of keys) {
      const a = beforePackages[key];
      const b = afterPackages[key];
      const name = LockEquivalence.nameOf(key);
      if (a === undefined || b === undefined) {
        differences.push({
          path: key,
          field: null,
          before: a === undefined ? null : a.version || '(entry)',
          after: b === undefined ? null : b.version || '(entry)',
          why:
            a === undefined
              ? `${name || 'the root'} was added by the stamp`
              : `${name || 'the root'} was removed by the stamp`,
        });
        continue;
      }
      if (key === '') {
        differences.push(...LockEquivalence.rootDifferences(a, b, linkedNames));
        continue;
      }
      if (linkedNames.has(name)) {
        continue;
      } // a linked package's own entry moves with the mint
      for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (!LockEquivalence.same(a[field], b[field])) {
          differences.push({
            path: key,
            field,
            before: a[field],
            after: b[field],
            why: `${name} is not a linked package`,
          });
        }
      }
    }
    return { equivalent: differences.length === 0, differences };
  }

  /** The root entry: dependency ranges on linked names may move; every other field and every other range must not. */
  static rootDifferences(a, b, linkedNames) {
    const differences = [];
    for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (LockEquivalence.SECTIONS.includes(field)) {
        const da = a[field] || {};
        const db = b[field] || {};
        for (const name of [...new Set([...Object.keys(da), ...Object.keys(db)])].sort()) {
          if (linkedNames.has(name)) {
            continue;
          }
          if (!LockEquivalence.same(da[name], db[name])) {
            differences.push({
              path: '',
              field: `${field}.${name}`,
              before: da[name],
              after: db[name],
              why: `${name} is not a linked package`,
            });
          }
        }
        continue;
      }
      if (!LockEquivalence.same(a[field], b[field])) {
        differences.push({
          path: '',
          field,
          before: a[field],
          after: b[field],
          why: 'the root entry changed outside its dependency ranges',
        });
      }
    }
    return differences;
  }

  /** One line per difference, for a log or a refusal. */
  static describe(differences) {
    return differences.map((d) => {
      const where = d.path === '' ? 'the root entry' : d.path;
      const what = d.field ? `${d.field} ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}` : d.why;
      return `${where}: ${what}${d.field ? ` (${d.why})` : ''}`;
    });
  }

  /** Whether every changed line of a unified diff of a package.json is a version line (headers and context aside). An empty diff qualifies. */
  static isVersionOnlyDiff(diff) {
    for (const line of String(diff || '').split('\n')) {
      if (!line || !/^[+-]/.test(line) || /^(\+\+\+|---) /.test(line)) {
        continue;
      }
      if (!LockEquivalence.isVersionLine(line.slice(1))) {
        return false;
      }
    }
    return true;
  }

  /** A `"version"` field, or a `"<name>": "<semver range or ranges joined by ||>"` pair. */
  static isVersionLine(line) {
    const text = line.trim();
    return LockEquivalence.VERSION_FIELD.test(text) || LockEquivalence.RANGE_FIELD.test(text);
  }

  /** The package name a lock path names (`node_modules/@s/x/node_modules/y` -> `y`), or null for the root. */
  static nameOf(lockPath) {
    if (lockPath === '') {
      return null;
    }
    const idx = lockPath.lastIndexOf('node_modules/');
    return idx === -1 ? lockPath : lockPath.slice(idx + 'node_modules/'.length);
  }

  static same(a, b) {
    return JSON.stringify(LockEquivalence.sortKeys(a)) === JSON.stringify(LockEquivalence.sortKeys(b));
  }

  static sortKeys(value) {
    if (Array.isArray(value)) {
      return value.map((v) => LockEquivalence.sortKeys(v));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = LockEquivalence.sortKeys(value[key]);
    }
    return out;
  }

  static parse(text, which) {
    try {
      const raw = JSON.parse(text);
      if (!raw || typeof raw !== 'object') {
        throw new Error('not an object');
      }
      return raw;
    } catch (err) {
      throw new Error(`the ${which} lock is not JSON (${err.message})`);
    }
  }
}

LockEquivalence.SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
/** `"version": "1.2.3"` — a package's own version field. */
LockEquivalence.VERSION_FIELD = /^"version":\s*"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?",?$/;
/** `"<name>": "^1.2.3"`, `"~1.2.3"`, `"1.2.3"`, or ranges joined by `||` (the graduation floor `^0.50.0 || ^1.0.0-0`). */
LockEquivalence.RANGE_FIELD =
  /^"[^"]+":\s*"[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s*\|\|\s*[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)*",?$/;

module.exports = { LockEquivalence };
