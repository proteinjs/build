const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * The DIST HASH — one number for "the bytes a package ships", the same whether they are read from
 * a tarball `npm pack` wrote (a linked verify's pack of a staged commit) or from the copy `npm ci`
 * put under node_modules (the registry tarball of the mint). The parallel-verify train ties the
 * two together with it (n3xa's LANDING_TRAINS §1.4p, guard 2: the proof must be for the bytes that
 * ship): the verify records the hash of what it linked, the publish records the hash of what it
 * published, and a departure compares them — a mismatch refuses, both hashes named.
 *
 * sha256 over the package's files in sorted path order, each as `<path>\0<size>\0<bytes>\0`, with
 * exactly the differences lerna's release commit introduces removed:
 *   - `CHANGELOG.md` at the package root is left out (lerna writes the mint's entry; npm always
 *     packs it);
 *   - `package.json` is hashed NORMALIZED: keys sorted at every level; `version`, `gitHead` and
 *     npm's own `_`-prefixed fields dropped; a dependency range on a name in the package's OWN
 *     scope (the sibling floors lerna's release commit moves — `@n3xah/util-common` inside
 *     `@n3xah/util-server`) dropped to '' — every other field verbatim, so an added dependency, a
 *     changed script or a new export still changes the hash;
 *   - `node_modules/` under the package (what npm nested there for the copy) is not the package.
 * Everything else — every dist file, README, LICENSE, the `files` list's every entry — byte for
 * byte. A build that is not reproducible (a timestamp in a generated file) changes the hash on
 * every rebuild: that is the guard's finding, not a nuisance to quiet.
 */
class DistHash {
  /** The hash of the package on disk at `dir` (an installed copy, or an unpacked tarball's `package/`). */
  static ofDirectory(dir, { scope = null } = {}) {
    const files = DistHash.files(dir);
    const hash = crypto.createHash('sha256');
    for (const rel of files) {
      const abs = path.join(dir, rel);
      const bytes =
        rel === 'package.json'
          ? Buffer.from(DistHash.normalizePackageJson(fs.readFileSync(abs, 'utf8'), { scope }))
          : fs.readFileSync(abs);
      hash.update(rel);
      hash.update('\0');
      hash.update(String(bytes.length));
      hash.update('\0');
      hash.update(bytes);
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  /** The hash of a tarball `npm pack` (or the registry) produced: unpacked to a temp dir, hashed, removed. */
  static ofTarball(file, { scope = null } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-hash-'));
    try {
      execFileSync('tar', ['-xzf', file, '-C', tmp, '--strip-components=1'], { stdio: ['ignore', 'ignore', 'pipe'] });
      return DistHash.ofDirectory(tmp, { scope });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** `@n3xah` from `@n3xah/util-server`; null for an unscoped name. */
  static scopeOf(name) {
    return typeof name === 'string' && name.startsWith('@') && name.includes('/')
      ? name.slice(0, name.indexOf('/'))
      : null;
  }

  /** The package's files, sorted, relative with `/` separators; CHANGELOG.md at the root and node_modules anywhere left out. */
  static files(dir) {
    const out = [];
    const walk = (rel) => {
      const abs = rel ? path.join(dir, rel) : dir;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.name === 'node_modules') {
          continue;
        }
        if (!rel && /^changelog(\.md)?$/i.test(entry.name)) {
          continue;
        }
        if (entry.isDirectory()) {
          walk(child);
        } else if (entry.isFile()) {
          out.push(child);
        }
      }
    };
    walk('');
    return out.sort();
  }

  /** package.json as the hash sees it (see the class note). Not JSON is hashed as it is. */
  static normalizePackageJson(text, { scope = null } = {}) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return text;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return text;
    }
    const out = {};
    for (const key of Object.keys(raw)) {
      if (key === 'version' || key === 'gitHead' || key.startsWith('_')) {
        continue;
      }
      out[key] = raw[key];
    }
    for (const section of DistHash.DEPENDENCY_SECTIONS) {
      if (!out[section] || typeof out[section] !== 'object') {
        continue;
      }
      const deps = {};
      for (const [name, range] of Object.entries(out[section])) {
        deps[name] = scope && name.startsWith(`${scope}/`) ? '' : range;
      }
      out[section] = deps;
    }
    return JSON.stringify(DistHash.sortKeys(out), null, 2) + '\n';
  }

  static sortKeys(value) {
    if (Array.isArray(value)) {
      return value.map((v) => DistHash.sortKeys(v));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = DistHash.sortKeys(value[key]);
    }
    return out;
  }
}

DistHash.DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

module.exports = { DistHash };
