const fs = require('fs');
const path = require('path');
const semver = require('semver');

const MAX_CHAINS_PER_COPY = 8;
const MAX_CHAIN_DEPTH = 30;

/**
 * The INSTALLED GRAPH — a lerna workspace's trees judged as they sit on disk, not as the locks
 * describe them (n3xa's DEV_SKILL_ORCHESTRATION §10.1a leg (a) and the dev workspace's linked
 * build; LANDING_TRAINS §1.4p: the linked verify runs it after the packed dists replaced the
 * registry copies, when the locks no longer describe the tree). Three legs over each tree's
 * node_modules:
 *   (a') one COPY per internal package per tree — a second copy, even at the same version, is a
 *        second module instance in the process (duplicate reflection graphs: the router keeps ONE
 *        interface per qualified name); a nested registry copy beside a linked one is exactly this;
 *   (a)  one version per internal package across the trees;
 *   (r)  every dependency an internal package declares — and every dependency the tree's own
 *        package.json declares — resolves, by node's walk-up from where the package sits, to an
 *        installed version inside the declared range (a linked branch whose floors the tree does
 *        not meet, or that adds a dependency the tree does not install, reds here by name).
 * On a registry install every leg holds by construction (npm resolved the lock); a linked tree
 * proves it. `scopes` names the internal scopes (the caller's: n3xa passes `@proteinjs/`, `@n3xah/`).
 * The tree readers (`installedPackages`, `resolveFrom`, `parentChains`) are the lock-shaped view the
 * linker's `place` reads through too.
 */
class InstalledGraph {
  constructor({ repoRoot, scopes = ['@proteinjs/', '@n3xah/'], log = console.log } = {}) {
    this.repoRoot = repoRoot || process.cwd();
    this.scopes = scopes;
    this.log = log;
  }

  /** The three legs over every non-root lerna tree. Returns { ok, failures: [{ leg, message }], counted }. */
  run() {
    const trees = this.loadTrees();
    for (const tree of trees) {
      tree.pkg = this.readJson(path.join(tree.dir, 'package.json'));
      tree.lock = { packages: this.installedPackages(tree.dir, tree.pkg) };
    }
    const failures = [
      ...this.assertOneCopy(trees),
      ...this.assertOneVersion(trees),
      ...this.assertInstalledResolution(trees),
    ];
    const counted = trees.map((t) => `${t.label} ${Object.keys(t.lock.packages).length - 1}`).join(', ');
    if (failures.length === 0) {
      this.log(
        `INSTALLED GRAPH: PASS — one copy per internal package per tree, one version across the trees, every declared dependency resolves in range (${counted} installed).`
      );
      return { ok: true, failures, counted };
    }
    for (const f of failures) {
      this.log(`\n[${f.leg}] ${f.message}`);
    }
    if (failures.some((f) => f.leg === 'resolution')) {
      this.log(
        "\n[resolution] fix: a linked branch whose floors the tree does not meet — link the repos that carry those packages at satisfying refs, or build a ref whose floors meet the branch; a dependency nothing installs goes into the tree's own package.json."
      );
    }
    this.log(
      `\nINSTALLED GRAPH: FAIL (${failures.length} finding${failures.length === 1 ? '' : 's'}; ${counted} installed).`
    );
    return { ok: false, failures, counted };
  }

  /**
   * One tree as installed, keyed like a lock's `packages`: '' is the tree's own package.json,
   * `node_modules/<name>` and `node_modules/<a>/node_modules/<b>` every package on disk (a symlink
   * is recorded as `{ link: true }` and not entered — a `file:` sibling is its own tree). Each entry
   * carries the manifest's version and dependency sections, so the lock walkers read it unchanged.
   */
  installedPackages(dir, pkg) {
    const packages = { '': this.manifestEntry(pkg) };
    const walk = (nmRel) => {
      const nmAbs = path.join(dir, nmRel);
      if (!fs.existsSync(nmAbs)) {
        return;
      }
      for (const entry of fs.readdirSync(nmAbs, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        const names =
          entry.name.startsWith('@') && entry.isDirectory()
            ? fs.readdirSync(path.join(nmAbs, entry.name)).map((name) => `${entry.name}/${name}`)
            : [entry.name];
        for (const name of names) {
          const rel = `${nmRel}/${name}`;
          const stat = fs.lstatSync(path.join(dir, rel));
          if (stat.isSymbolicLink()) {
            packages[rel] = { link: true };
            continue;
          }
          const manifestPath = path.join(dir, rel, 'package.json');
          if (!stat.isDirectory() || !fs.existsSync(manifestPath)) {
            continue;
          }
          packages[rel] = this.manifestEntry(this.readJson(manifestPath));
          walk(`${rel}/node_modules`);
        }
      }
    };
    walk('node_modules');
    return packages;
  }

  // ---- leg (a'): one copy per internal package per tree ----

  assertOneCopy(trees) {
    const failures = [];
    for (const tree of trees) {
      const copies = new Map();
      for (const [lockPath, entry] of Object.entries(tree.lock.packages)) {
        const name = this.internalNameFromLockPath(lockPath);
        if (!name) {
          continue;
        }
        if (!copies.has(name)) {
          copies.set(name, []);
        }
        copies.get(name).push({ lockPath, entry });
      }
      for (const [name, list] of copies) {
        if (list.length <= 1) {
          continue;
        }
        const lines = [
          `${tree.label}: ${name} is installed ${list.length} times — one copy per package (a second copy is a second module instance: duplicate reflection graphs):`,
        ];
        for (const { lockPath, entry } of list) {
          lines.push(`  - ${lockPath} ${entry.link ? '(symlink)' : entry.version}`);
          for (const chain of entry.link ? [] : this.parentChains(tree, lockPath)) {
            lines.push(`      ${chain}`);
          }
        }
        lines.push(
          '  fix: a linked package replaces EVERY copy with one at the tree top (link-workspace); a registry install with a nested copy is a lock split — converge the lagging tree.'
        );
        failures.push({ leg: 'one-copy', message: lines.join('\n') });
      }
    }
    return failures;
  }

  // ---- leg (r): every declared dependency resolves in range ----

  assertInstalledResolution(trees) {
    const failures = [];
    for (const tree of trees) {
      const packages = tree.lock.packages;
      for (const [fromPath, entry] of Object.entries(packages)) {
        if (entry.link) {
          continue;
        }
        const own = fromPath === '' ? undefined : this.internalNameFromLockPath(fromPath);
        if (fromPath !== '' && !own) {
          continue;
        } // a third-party package's own graph is npm's
        const who = fromPath === '' ? `${tree.pkg.name || tree.label} (package.json)` : `${own}@${entry.version}`;
        const sections = fromPath === '' ? ['dependencies', 'devDependencies'] : ['dependencies'];
        for (const section of sections) {
          for (const [name, range] of Object.entries(entry[section] || {})) {
            if (!semver.validRange(range)) {
              continue;
            } // file:, link:, git and alias specs
            const target = this.resolveFrom(packages, fromPath, name);
            if (!target) {
              failures.push({
                leg: 'resolution',
                message: `${tree.label}: ${who} declares ${name} ${range}; nothing installed resolves it (from ${fromPath || 'the tree root'}).`,
              });
              continue;
            }
            const resolved = packages[target];
            if (resolved.link) {
              continue;
            } // a symlinked sibling is its own tree
            if (!semver.satisfies(resolved.version, range, { includePrerelease: true })) {
              failures.push({
                leg: 'resolution',
                message: `${tree.label}: ${who} declares ${name} ${range}; it resolves to ${resolved.version} (${target}) — outside the range.`,
              });
            }
          }
        }
      }
    }
    return failures;
  }

  // ---- leg (a): one version across the trees ----

  assertOneVersion(trees) {
    const failures = [];
    for (const { name, versions, copies } of this.oneVersionSplits(trees)) {
      const lines = [`${name} resolves to ${versions.length} versions across the workspace:`];
      for (const version of versions) {
        lines.push(`  - ${version}`);
        for (const { tree, lockPath, chains } of copies.filter((c) => c.version === version)) {
          for (const chain of chains) {
            lines.push(`      ${tree.label}: ${chain}  (${lockPath})`);
          }
          if (chains.length === 0) {
            lines.push(`      ${tree.label}: (no dependent found)  (${lockPath})`);
          }
        }
      }
      lines.push(
        "  fix: if the parents' ranges admit one version, converge with `npm update " +
          name +
          ' --package-lock-only` in the lagging tree(s); a range that cannot admit it means the pinning parent needs a re-mint with a bumped range.'
      );
      failures.push({ leg: 'one-version', message: lines.join('\n') });
    }
    return failures;
  }

  /** Leg (a) as data: every internal package resolving to more than one version across `trees` — [{ name, versions, copies: [{ tree, lockPath, version, chains, dependents }] }]. */
  oneVersionSplits(trees) {
    const copies = new Map();
    for (const tree of trees) {
      for (const [lockPath, entry] of Object.entries(tree.lock.packages || {})) {
        const name = this.internalNameFromLockPath(lockPath);
        if (!name || entry.link || !entry.version) {
          continue;
        }
        if (!copies.has(name)) {
          copies.set(name, []);
        }
        copies.get(name).push({ tree, lockPath, version: entry.version });
      }
    }
    const splits = [];
    for (const [name, list] of copies) {
      const versions = [...new Set(list.map((c) => c.version))];
      if (versions.length <= 1) {
        continue;
      }
      splits.push({
        name,
        versions,
        copies: list.map((copy) => ({
          ...copy,
          chains: this.parentChains(copy.tree, copy.lockPath),
          dependents: this.dependentsOf(copy.tree, copy.lockPath, name),
        })),
      });
    }
    return splits;
  }

  // ---- the walkers ----

  /** Dependency chains (root -> ... -> copy) that resolve to the copy at lockPath. */
  parentChains(tree, lockPath) {
    if (!tree.reverseEdges) {
      tree.reverseEdges = this.buildReverseEdges(tree.lock);
    }
    const chains = [];
    const walk = (node, suffix, onPath) => {
      if (chains.length >= MAX_CHAINS_PER_COPY || suffix.length > MAX_CHAIN_DEPTH) {
        return;
      }
      const parents = tree.reverseEdges.get(node) || [];
      if (node === '') {
        chains.push([`${tree.pkg.name || tree.label}`, ...suffix].join(' > '));
        return;
      }
      if (parents.length === 0) {
        return;
      }
      for (const parent of parents) {
        if (onPath.has(parent)) {
          continue;
        }
        onPath.add(parent);
        walk(parent, [this.labelFor(tree, node), ...suffix], onPath);
        onPath.delete(parent);
      }
    };
    walk(lockPath, [], new Set([lockPath]));
    return chains;
  }

  /** The entries whose `name` edge resolves to `lockPath`, each with the range it declares. */
  dependentsOf(tree, lockPath, name) {
    if (!tree.reverseEdges) {
      tree.reverseEdges = this.buildReverseEdges(tree.lock);
    }
    return (tree.reverseEdges.get(lockPath) || []).map((from) => ({ from, range: this.rangeFrom(tree, from, name) }));
  }

  rangeFrom(tree, fromPath, name) {
    const entry = tree.lock.packages[fromPath] || {};
    const sections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
    if (fromPath === '') {
      sections.push('devDependencies');
    }
    for (const section of sections) {
      if (entry[section] && entry[section][name] !== undefined) {
        return entry[section][name];
      }
    }
    return '*';
  }

  /** target lock path -> [dependent lock paths], via npm's walk-up resolution. */
  buildReverseEdges(lock) {
    const packages = lock.packages || {};
    const edges = new Map();
    for (const [fromPath, entry] of Object.entries(packages)) {
      if (fromPath.startsWith('..') || entry.link) {
        continue;
      }
      const depNames = new Set([
        ...Object.keys(entry.dependencies || {}),
        ...Object.keys(entry.optionalDependencies || {}),
        ...Object.keys(entry.peerDependencies || {}),
        ...(fromPath === '' ? Object.keys(entry.devDependencies || {}) : []),
      ]);
      for (const depName of depNames) {
        const target = this.resolveFrom(packages, fromPath, depName);
        if (!target) {
          continue;
        }
        if (!edges.has(target)) {
          edges.set(target, []);
        }
        edges.get(target).push(fromPath);
      }
    }
    return edges;
  }

  /** npm resolution: the nearest node_modules/<name> at or above fromPath. */
  resolveFrom(packages, fromPath, name) {
    let base = fromPath;
    for (;;) {
      const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (packages[candidate]) {
        return candidate;
      }
      if (!base) {
        return null;
      }
      const idx = base.lastIndexOf('/node_modules/');
      base = idx === -1 ? '' : base.slice(0, idx);
    }
  }

  labelFor(tree, lockPath) {
    const entry = tree.lock.packages[lockPath] || {};
    const name = lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
    return entry.version ? `${name}@${entry.version}` : name;
  }

  internalNameFromLockPath(lockPath) {
    const idx = lockPath.lastIndexOf('node_modules/');
    if (idx === -1) {
      return null;
    }
    const name = lockPath.slice(idx + 'node_modules/'.length);
    return this.isInternalName(name) ? name : null;
  }

  isInternalName(name) {
    return this.scopes.some((scope) => name.startsWith(scope));
  }

  /** A package.json as a lock entry: its version and the dependency sections the walkers read. */
  manifestEntry(manifest) {
    const entry = { version: manifest.version };
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      if (manifest[section]) {
        entry[section] = manifest[section];
      }
    }
    return entry;
  }

  /** The non-root lerna trees: [{ dir, rel, label }]. */
  loadTrees() {
    const lerna = this.readJson(path.join(this.repoRoot, 'lerna.json'));
    const trees = [];
    for (const pattern of lerna.packages || ['packages/*']) {
      for (const rel of this.expand(pattern)) {
        trees.push({ dir: path.join(this.repoRoot, rel), rel, label: rel });
      }
    }
    return trees;
  }

  /** lerna's package globs: a literal dir, `<dir>/*` (its child dirs), `<dir>/**` (every dir below it) — kept when a package.json sits there. Sorted. */
  expand(pattern) {
    const segments = pattern.split('/').filter(Boolean);
    let dirs = [''];
    for (const segment of segments) {
      const next = [];
      for (const dir of dirs) {
        if (segment === '**') {
          next.push(dir, ...this.walkDirs(dir));
        } else if (segment === '*') {
          next.push(...this.children(dir));
        } else {
          next.push(path.posix.join(dir, segment));
        }
      }
      dirs = next;
    }
    return [...new Set(dirs)].filter((d) => d && fs.existsSync(path.join(this.repoRoot, d, 'package.json'))).sort();
  }

  children(dir) {
    const abs = path.join(this.repoRoot, dir);
    if (!fs.existsSync(abs)) {
      return [];
    }
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      .map((e) => path.posix.join(dir, e.name));
  }

  walkDirs(dir) {
    const out = [];
    for (const child of this.children(dir)) {
      out.push(child, ...this.walkDirs(child));
    }
    return out;
  }

  readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
}

module.exports = { InstalledGraph };
