const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { InstalledGraph } = require('./InstalledGraph');
const { DistHash } = require('./DistHash');
const { LockEquivalence } = require('./LockEquivalence');

/**
 * LINK A WORKSPACE FROM SOURCE — a lerna workspace whose internal dependencies are installed from a
 * registry receives, in place of EVERY registry copy of a package (hoisted or nested), the PACKED
 * dist of that package built from a sibling repo's checkout at one commit. Two callers, one owner:
 *
 *   AN IMAGE BUILD: a deploy workflow's `links` input names sibling-repo branches (`repo=ref[,repo=ref…]`),
 *   the preflight refuses what must never build (`plan`, `resolve`), and the Dockerfile's build stage
 *   installs every package at its own lock building none (`install`), builds each linked package at
 *   its branch and puts its pack in place (`link`, for a named environment only), then judges the
 *   installed graph.
 *
 *   A LINKED VERIFY (a library repository's CI run of its integration branch): the tip carries
 *   `.train/links.json` — the not-yet-published upstream repositories, each at the commit it was linked
 *   at, derived from the package graph by the release tooling — and the reusable test workflow checks
 *   each out at that commit, links it (`plan --train`, `link --train --record`), builds and tests; the
 *   packed dists' hashes ride the run's `train-links` artifact. The publish run then PROVES the released
 *   tip equivalent to the verified one (`prove`: the installed copies of the linked packages hash to
 *   what was packed, the locks equivalent over the linked names, the package.json diffs version-only)
 *   and, after the publish, records the published tarballs' hashes (`mints`). `assert` reds a verify
 *   whose linked copies were clobbered between the link and the tests.
 *
 * The workspace's trees are lerna.json's packages. Each linked repo checkout sits under
 * `linksDir/<repo>` with its own `packages/`. `owner`, `repos` (the allow-list) and `scopes` (the
 * internal scopes the installed graph judges) are the caller's — required inputs, never defaults:
 * this package knows no organization. A linked package is built in dependency order
 * across every linked repo (a package builds against the linked build of every linked sibling it
 * declares); it copies (never symlinks) so a tree holds one real path per package, and what npm
 * nested under the registry copy (a third-party pin the tree top cannot meet) stays under the
 * placed one.
 */
class LinkedWorkspace {
  constructor({
    repoRoot = process.cwd(),
    linksDir = path.join(process.cwd(), 'links'),
    packDir = path.join(os.tmpdir(), 'link-workspace-packs'),
    exec = LinkedWorkspace.exec,
    workspacePackages,
    owner = null,
    repos = null,
    scopes = null,
    log = console.log,
  } = {}) {
    this.repoRoot = repoRoot;
    this.linksDir = linksDir;
    this.packDir = packDir;
    this.exec = exec;
    this.workspacePackages = workspacePackages || (() => this.buildableWorkspacePackages());
    this.owner = owner;
    this.repos = repos;
    this.scopes = scopes;
    this.log = log;
    this.graph = new InstalledGraph({ repoRoot, scopes: scopes || [], log });
  }

  // ---- the dispatch (the dev deploy) ----------------------------------------------------------

  /** The `links` input as [{ repo, ref }], or a refusal naming what is wrong. No links → []. */
  plan({ links, environment, dockerfile, requireEnvironment = 'dev' }) {
    const entries = String(links == null ? '' : links)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const match = /^([^=\s]+)=(.+)$/.exec(entry);
        if (!match) {
          throw new Error(`links: "${entry}" is not repo=ref`);
        }
        const [, repo, ref] = match;
        this.assertRepo(repo);
        LinkedWorkspace.assertRef(repo, ref);
        return { repo, ref };
      });
    if (entries.length === 0) {
      return [];
    }
    const seen = new Set();
    for (const { repo } of entries) {
      if (seen.has(repo)) {
        throw new Error(`links: ${repo} is linked twice — one ref per repo`);
      }
      seen.add(repo);
    }
    if (requireEnvironment && environment !== requireEnvironment) {
      throw new Error(
        `links deploy to ${requireEnvironment} only — this deploy targets ${environment ? `"${environment}"` : 'no named environment'}; every other environment builds every supporting package from the registry`
      );
    }
    if (dockerfile !== undefined && !LinkedWorkspace.DOCKERFILE_LINKS_STAGE.test(dockerfile || '')) {
      throw new Error(
        'links: the build ref predates the linked build — its Dockerfile has no `FROM scratch AS links` stage, so the linked trees would be ignored; build a ref cut after it landed, or dispatch without links'
      );
    }
    return entries;
  }

  /** Each planned link at the commit its ref names: [{ repo, ref, sha }]. `resolveRef(repo, ref)` → sha. */
  resolve(entries, resolveRef) {
    return entries.map(({ repo, ref }) => {
      let sha;
      try {
        sha = String(resolveRef(repo, ref) == null ? '' : resolveRef(repo, ref)).trim();
      } catch {
        sha = '';
      }
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(
          `links: ${repo}=${ref} does not resolve in ${this.assertOwner()}/${repo} — push the branch, or name a tag or a full SHA`
        );
      }
      return { repo, ref, sha };
    });
  }

  // ---- the train (a supporting repo's verify) --------------------------------------------------

  /**
   * `.train/links.json`'s text as [{ repo, slug, ref, sha, packages }] — `repo` the short name the
   * checkouts and the token use, `slug` `<owner>/<repo>`, `ref` the sha (a train links commits, never
   * refs). Refuses a repo outside the allow-list, a sha that is not 40 hex, a repo linked twice.
   * An absent file (null / '') is the plain road: [].
   */
  planFromTrain(text) {
    if (text == null || !String(text).trim()) {
      return [];
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`links: .train/links.json is not JSON (${err.message})`);
    }
    if (!raw || !Array.isArray(raw.links)) {
      throw new Error('links: .train/links.json carries no "links" list');
    }
    const seen = new Set();
    return raw.links.map((link, i) => {
      if (!link || typeof link.repo !== 'string' || typeof link.sha !== 'string') {
        throw new Error(`links: .train/links.json link ${i + 1} needs "repo" and "sha"`);
      }
      const repo = link.repo.includes('/') ? link.repo.slice(link.repo.indexOf('/') + 1) : link.repo;
      const owner = link.repo.includes('/') ? link.repo.slice(0, link.repo.indexOf('/')) : this.assertOwner();
      if (owner !== this.assertOwner()) {
        throw new Error(`links: ${link.repo} is not under ${this.owner} — a train links its own owner's repos`);
      }
      this.assertRepo(repo);
      if (!/^[0-9a-f]{40}$/.test(link.sha)) {
        throw new Error(`links: ${link.repo} sha ${JSON.stringify(link.sha)} is not a full commit sha`);
      }
      if (seen.has(repo)) {
        throw new Error(`links: ${repo} is linked twice — one commit per repo`);
      }
      seen.add(repo);
      const packages = Array.isArray(link.packages) ? link.packages.filter((p) => typeof p === 'string') : [];
      return { repo, slug: `${owner}/${repo}`, ref: link.sha, sha: link.sha, packages };
    });
  }

  // ---- the image / the verify: install, then link ----------------------------------------------

  /** Install every workspace package at its own lock, building none (build-workspace's own installer). */
  async install() {
    const names = await this.workspacePackages();
    this.log(`link-workspace: installing ${names.length} workspace packages, building none (${names.join(', ')})`);
    this.exec('npm', ['run', 'build-workspace', '--', `--no-build=${names.join(',')}`], { cwd: this.repoRoot });
  }

  /**
   * Build and place the linked repos. `links`: [{ repo, ref, sha }] (the manifest parsed, or the
   * train's plan). `requireBuildPrefix` (the dev deploy: 'dev-') refuses any other `buildVersion`;
   * the train passes null. Returns one receipt per linked package: { repo, ref, sha, name, version,
   * hash, placed: [tree paths], removed: [registry copies] }.
   */
  link({ links, buildVersion = null, requireBuildPrefix = null }) {
    const trees = this.linkedTrees();
    const named = links.map((l) => l.repo);
    for (const repo of trees) {
      if (!named.includes(repo)) {
        throw new Error(
          `links: ${path.basename(this.linksDir)}/ holds ${repo}, but the links name ${named.length ? named.join(', ') : 'none'} — the manifest must name every linked tree`
        );
      }
    }
    for (const repo of named) {
      if (!trees.includes(repo)) {
        throw new Error(`links: the links name ${repo}, but ${path.basename(this.linksDir)}/ holds no ${repo} tree`);
      }
    }
    if (links.length === 0) {
      this.log('link-workspace: nothing linked — every supporting package is the registry copy the locks name');
      return [];
    }
    if (requireBuildPrefix && !String(buildVersion == null ? '' : buildVersion).startsWith(requireBuildPrefix)) {
      throw new Error(
        `links build into ${requireBuildPrefix}… images only — BUILD_VERSION is ${buildVersion ? `"${buildVersion}"` : 'unset'}; every other build installs from the registry`
      );
    }
    for (const { repo, ref, sha } of links) {
      const head = this.exec('git', ['rev-parse', 'HEAD'], {
        cwd: path.join(this.linksDir, repo),
        capture: true,
      }).trim();
      if (head !== sha) {
        throw new Error(
          `links: ${path.basename(this.linksDir)}/${repo} is at ${head.slice(0, 12)}, not ${sha.slice(0, 12)} (${repo}=${ref}) — the tree must be the commit the record will name`
        );
      }
    }

    const packages = links.flatMap((link) => this.repoPackages(link));
    const appTrees = this.appTrees();
    for (const link of links) {
      const own = packages.filter((p) => p.repo === link.repo);
      if (!own.some((p) => appTrees.some((tree) => this.copiesIn(tree.dir, tree.pkg, p.name).length > 0))) {
        throw new Error(
          `links: ${link.repo}: this workspace installs none of its packages (${own
            .map((p) => p.name)
            .sort()
            .join(', ')}) — linking it would change nothing`
        );
      }
    }

    fs.mkdirSync(this.packDir, { recursive: true });
    const packed = new Map(); // name -> { tarball, hash }
    for (const pkg of this.buildOrder(packages)) {
      this.log(
        `link-workspace: ${pkg.repo}/${pkg.dirName} (${pkg.name}@${pkg.version}) — npm ci, link its linked siblings, build, pack`
      );
      this.step(pkg, 'npm ci', () => this.exec('npm', ['ci', '--no-audit', '--no-fund'], { cwd: pkg.dir }));
      const manifestPath = path.join(pkg.dir, 'package.json');
      const own = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const [name, { tarball }] of packed) {
        if (this.copiesIn(pkg.dir, own, name).length > 0) {
          this.place(pkg.dir, own, name, tarball);
        }
      }
      this.step(pkg, 'npm run build', () => this.exec('npm', ['run', 'build'], { cwd: pkg.dir }));
      const [{ filename }] = JSON.parse(
        this.exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', this.packDir], {
          cwd: pkg.dir,
          capture: true,
        })
      );
      const tarball = path.join(this.packDir, filename);
      packed.set(pkg.name, { tarball, hash: DistHash.ofTarball(tarball, { scope: DistHash.scopeOf(pkg.name) }) });
    }

    const receipts = [];
    for (const pkg of packages) {
      const link = links.find((l) => l.repo === pkg.repo);
      const { tarball, hash } = packed.get(pkg.name);
      const receipt = {
        repo: pkg.repo,
        ref: link.ref,
        sha: link.sha,
        name: pkg.name,
        version: pkg.version,
        hash,
        placed: [],
        removed: [],
      };
      for (const tree of appTrees) {
        if (this.copiesIn(tree.dir, tree.pkg, pkg.name).length === 0) {
          continue;
        }
        const removed = this.place(tree.dir, tree.pkg, pkg.name, tarball);
        receipt.placed.push(path.posix.join(tree.rel, 'node_modules', pkg.name));
        receipt.removed.push(...removed.map((lockPath) => path.posix.join(tree.rel, lockPath)));
      }
      receipts.push(receipt);
      this.log(
        receipt.placed.length
          ? `link-workspace: ${pkg.name}@${pkg.version} (${pkg.repo}=${link.ref}@${link.sha.slice(0, 12)}; dist ${hash.slice(0, 12)}) placed at ${receipt.placed.join(', ')}; registry copies removed: ${receipt.removed.length}`
          : `link-workspace: ${pkg.name}@${pkg.version} built (a sibling's dependency; dist ${hash.slice(0, 12)}); this workspace installs no copy of it`
      );
    }
    return receipts;
  }

  /** The verify's record of what it linked — the `train-links` artifact: { tip, links: [{ repo, slug, sha, packages: [{ name, version, hash, placed }] }] }. */
  record({ tip, links, receipts }) {
    return {
      tip,
      links: links.map((l) => ({
        repo: l.repo,
        slug: l.slug || `${this.assertOwner()}/${l.repo}`,
        sha: l.sha,
        packages: receipts
          .filter((r) => r.repo === l.repo)
          .map((r) => ({ name: r.name, version: r.version, hash: r.hash, placed: r.placed })),
      })),
    };
  }

  /**
   * The linked copies as installed NOW hash to what the record says was packed — every tree that
   * installs a recorded package holds exactly one copy of it and that copy is the pack. A copy npm
   * put back (a per-package install that re-resolved over the link) or a second copy is a finding.
   * Returns { ok, findings: [lines], checked }.
   */
  assert({ record }) {
    const findings = [];
    let checked = 0;
    const appTrees = this.appTrees();
    for (const link of record.links || []) {
      for (const pkg of link.packages || []) {
        for (const tree of appTrees) {
          const copies = this.copiesIn(tree.dir, tree.pkg, pkg.name);
          if (copies.length === 0) {
            continue;
          }
          if (copies.length > 1) {
            findings.push(
              `${tree.rel}: ${pkg.name} is installed ${copies.length} times (${copies.join(', ')}) — the link left one copy`
            );
            continue;
          }
          checked += 1;
          const dir = path.join(tree.dir, copies[0]);
          const installed = DistHash.ofDirectory(dir, { scope: DistHash.scopeOf(pkg.name) });
          if (installed !== pkg.hash) {
            findings.push(
              `${tree.rel}: ${pkg.name} at ${copies[0]} hashes ${installed.slice(0, 12)}, the pack was ${String(pkg.hash).slice(0, 12)} — the linked copy was replaced after the link (a per-package install re-resolved over it)`
            );
          }
        }
      }
    }
    return { ok: findings.length === 0, findings, checked };
  }

  /**
   * The publish run's proof that the released tip is EQUIVALENT to the verified one: `links` = the parent's `.train/links.json` plan; `record` = the verify run's
   * `train-links` record (null when it could not be read); `trees` = [{ rel, lockBefore, lockAfter,
   * packageJsonDiff }] — the parent's and the head's lock texts and the unified diff of package.json,
   * per lerna tree. Judges: every recorded package's INSTALLED copy hashes to the pack; every tree's
   * lock equivalent over the linked names; every package.json diff version-only. Returns { ok,
   * judged: [files], packages: [{ name, verified, installed, ok, tree }], locks: [{ tree, equivalent,
   * differences }], manifests: [{ tree, versionOnly }], why }.
   */
  prove({ links, record, trees }) {
    const proof = { ok: true, judged: [], packages: [], locks: [], manifests: [], why: [] };
    if (!links.length) {
      proof.why.push('no links at the parent: the plain road');
      return proof;
    }
    if (!record) {
      proof.ok = false;
      proof.why.push("the verify run's train-links record could not be read");
      return proof;
    }
    const linkedNames = links.flatMap((l) => l.packages);
    const recorded = new Map();
    for (const link of record.links || []) {
      for (const pkg of link.packages || []) {
        recorded.set(pkg.name, pkg);
      }
    }
    for (const link of links) {
      const rec = (record.links || []).find((r) => r.repo === link.repo);
      if (!rec || rec.sha !== link.sha) {
        proof.ok = false;
        proof.why.push(
          `the record links ${link.repo} at ${rec ? rec.sha.slice(0, 12) : 'nothing'}, the parent's links.json at ${link.sha.slice(0, 12)}`
        );
      }
    }
    const appTrees = this.appTrees();
    for (const name of linkedNames) {
      const pkg = recorded.get(name);
      for (const tree of appTrees) {
        const copies = this.copiesIn(tree.dir, tree.pkg, name);
        if (copies.length === 0) {
          continue;
        }
        if (!pkg) {
          proof.ok = false;
          proof.packages.push({ name, verified: null, installed: null, ok: false, tree: tree.rel });
          proof.why.push(`${name} is installed in ${tree.rel} but the verify recorded no pack of it`);
          continue;
        }
        if (copies.length > 1) {
          proof.ok = false;
          proof.packages.push({ name, verified: pkg.hash, installed: null, ok: false, tree: tree.rel });
          proof.why.push(`${tree.rel}: ${name} is installed ${copies.length} times`);
          continue;
        }
        const installed = DistHash.ofDirectory(path.join(tree.dir, copies[0]), { scope: DistHash.scopeOf(name) });
        const ok = installed === pkg.hash;
        proof.packages.push({ name, verified: pkg.hash, installed, ok, tree: tree.rel });
        if (!ok) {
          proof.ok = false;
          proof.why.push(
            `${tree.rel}: ${name} installed ${installed.slice(0, 12)} ≠ verified ${String(pkg.hash).slice(0, 12)}`
          );
        }
      }
    }
    for (const tree of trees) {
      if (tree.lockBefore != null || tree.lockAfter != null) {
        let verdict;
        try {
          verdict = LockEquivalence.judge(
            tree.lockBefore == null ? '{}' : tree.lockBefore,
            tree.lockAfter == null ? '{}' : tree.lockAfter,
            { linked: linkedNames }
          );
        } catch (err) {
          verdict = {
            equivalent: false,
            differences: [{ path: '', field: null, before: null, after: null, why: err.message }],
          };
        }
        proof.locks.push({ tree: tree.rel, equivalent: verdict.equivalent, differences: verdict.differences });
        proof.judged.push(path.posix.join(tree.rel, 'package-lock.json'));
        if (!verdict.equivalent) {
          proof.ok = false;
          proof.why.push(
            `${tree.rel}/package-lock.json is not equivalent over the linked names: ${LockEquivalence.describe(verdict.differences).join('; ')}`
          );
        }
      }
      if (tree.packageJsonDiff != null) {
        const versionOnly = LockEquivalence.isVersionOnlyDiff(tree.packageJsonDiff);
        proof.manifests.push({ tree: tree.rel, versionOnly });
        proof.judged.push(path.posix.join(tree.rel, 'package.json'));
        if (!versionOnly) {
          proof.ok = false;
          proof.why.push(`${tree.rel}/package.json changes more than version lines`);
        }
      }
    }
    if (proof.ok) {
      proof.why.push(
        `${proof.packages.length} installed cop${proof.packages.length === 1 ? 'y' : 'ies'} hash to the verify's packs; ${proof.locks.length} lock(s) equivalent over ${linkedNames.length} linked name(s)`
      );
    }
    return proof;
  }

  /**
   * The tags a publish run created: every tag pointing at HEAD or at a commit between `since` (the
   * commit the run was pushed for) and HEAD. The release commit lerna tags is not the last commit of
   * the run when a lock re-stamp commit follows it, so HEAD alone would name nothing.
   * `git(args)` → the command's stdout. Sorted, unique.
   */
  static tagsCreatedSince({ git, since = null }) {
    const commits = ['HEAD'];
    if (since) {
      commits.push(
        ...String(git(['rev-list', `${since}..HEAD`]) || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
    const tags = new Set();
    for (const commit of commits) {
      for (const tag of String(git(['tag', '--points-at', commit]) || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)) {
        tags.add(tag);
      }
    }
    return [...tags].sort();
  }

  /** The published tarballs' hashes — the `train-mints` artifact: [{ name, version, tag, hash }]. `pack(name, version)` → a tarball path (the registry's copy). */
  mints({ tags, pack }) {
    const out = [];
    for (const tag of tags) {
      const at = tag.lastIndexOf('@');
      if (at <= 0) {
        continue;
      }
      const name = tag.slice(0, at);
      const version = tag.slice(at + 1);
      if (!/^\d+\.\d+\.\d+/.test(version)) {
        continue;
      }
      const tarball = pack(name, version);
      out.push({ name, version, tag, hash: DistHash.ofTarball(tarball, { scope: DistHash.scopeOf(name) }) });
    }
    return out;
  }

  // ---- the manifest (BUILD_LINKS, the dev deploy) -----------------------------------------------

  static renderManifest(links) {
    return links.map(({ repo, ref, sha }) => `${repo}=${ref}@${sha}`).join(' ');
  }

  parseManifest(text) {
    return String(text == null ? '' : text)
      .split(/\s+/)
      .filter(Boolean)
      .map((entry) => {
        const match = /^([^=@\s]+)=([^@\s]+)@([0-9a-f]{40})$/.exec(entry);
        if (!match) {
          throw new Error(`links: BUILD_LINKS entry "${entry}" is not repo=ref@sha`);
        }
        const [, repo, ref, sha] = match;
        this.assertRepo(repo);
        LinkedWorkspace.assertRef(repo, ref);
        return { repo, ref, sha };
      });
  }

  // ---- helpers -----------------------------------------------------------------------------------

  assertRepo(repo) {
    if (!Array.isArray(this.repos) || !this.repos.length) {
      throw new Error('links: no allow-list of linkable repos was given (LINK_REPOS, or `repos` to the constructor)');
    }
    if (!this.repos.includes(repo)) {
      throw new Error(`links: ${repo} is not a linkable repo (${this.repos.join(', ')})`);
    }
  }

  /** The owner every linked repo belongs to — required (LINK_OWNER, or `owner` to the constructor). */
  assertOwner() {
    if (typeof this.owner !== 'string' || !this.owner.trim()) {
      throw new Error('links: no owner was given (LINK_OWNER, or `owner` to the constructor)');
    }
    return this.owner;
  }

  /** Branch, tag or SHA characters only; nothing a shell, git or the manifest could read two ways. */
  static assertRef(repo, ref) {
    const ok =
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
      !ref.includes('..') &&
      !ref.includes('//') &&
      !ref.endsWith('/') &&
      !ref.endsWith('.lock');
    if (!ok) {
      throw new Error(`links: ${repo}=${ref} — "${ref}" is not a branch, tag or SHA this workflow checks out`);
    }
  }

  /** The repo dirs under linksDir (a checkout per linked repo; nothing else belongs there). */
  linkedTrees() {
    if (!fs.existsSync(this.linksDir)) {
      return [];
    }
    return fs
      .readdirSync(this.linksDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  }

  /** A linked repo's packages (packages/<dir>/package.json), in listing order. */
  repoPackages({ repo }) {
    const root = path.join(this.linksDir, repo, 'packages');
    if (!fs.existsSync(root)) {
      throw new Error(
        `links: ${path.basename(this.linksDir)}/${repo} has no packages/ — not a supporting-repo checkout`
      );
    }
    return fs
      .readdirSync(root)
      .sort()
      .filter((dirName) => fs.existsSync(path.join(root, dirName, 'package.json')))
      .map((dirName) => {
        const dir = path.join(root, dirName);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return { repo, dirName, dir, name: manifest.name, version: manifest.version, manifest };
      });
  }

  /** The linked packages in dependency order across every linked repo; ties keep the listing order. A cycle is refused, naming the packages on it. */
  buildOrder(packages) {
    const names = new Set(packages.map((p) => p.name));
    const needs = new Map(
      packages.map((p) => [
        p.name,
        new Set(
          Object.keys({
            ...(p.manifest.dependencies || {}),
            ...(p.manifest.peerDependencies || {}),
            ...(p.manifest.devDependencies || {}),
          }).filter((dep) => names.has(dep) && dep !== p.name)
        ),
      ])
    );
    const order = [];
    const placed = new Set();
    while (order.length < packages.length) {
      const next = packages.find((p) => !placed.has(p.name) && [...needs.get(p.name)].every((dep) => placed.has(dep)));
      if (!next) {
        let left = packages.filter((p) => !placed.has(p.name)).map((p) => p.name);
        for (;;) {
          const needed = new Set(left.flatMap((name) => [...needs.get(name)].filter((dep) => left.includes(dep))));
          const kept = left.filter((name) => needed.has(name));
          if (kept.length === left.length) {
            break;
          }
          left = kept;
        }
        throw new Error(
          `links: a dependency cycle among the linked packages: ${left.sort().join(', ')} — no build order exists`
        );
      }
      order.push(next);
      placed.add(next.name);
    }
    return order;
  }

  /** The workspace's lerna trees: where the served copies live. */
  appTrees() {
    return this.graph
      .loadTrees()
      .map((tree) => ({ ...tree, pkg: JSON.parse(fs.readFileSync(path.join(tree.dir, 'package.json'), 'utf8')) }));
  }

  /** Every installed copy of `name` in the tree at `dir` (lock-style paths), hoisted or nested. */
  copiesIn(dir, pkg, name) {
    const installed = this.graph.installedPackages(dir, pkg);
    return Object.keys(installed).filter((lockPath) => lockPath.endsWith(`node_modules/${name}`));
  }

  /**
   * Remove every copy of `name` in the tree at `dir` and extract the packed dist at
   * `<dir>/node_modules/<name>`. What npm installed UNDER the top copy stays under the placed one
   * (the third-party dependencies it resolved for that package in this tree). Returns the removed paths.
   */
  place(dir, pkg, name, tarball) {
    const removed = this.copiesIn(dir, pkg, name);
    const top = `node_modules/${name}`;
    for (const lockPath of removed) {
      const copy = path.join(dir, lockPath);
      if (lockPath === top && fs.lstatSync(copy).isDirectory()) {
        // Emptied in place, never moved: a rename out of an image layer is EXDEV on overlayfs.
        for (const entry of fs.readdirSync(copy)) {
          if (entry !== 'node_modules') {
            fs.rmSync(path.join(copy, entry), { recursive: true, force: true });
          }
        }
      } else {
        fs.rmSync(copy, { recursive: true, force: true });
      }
    }
    const target = path.join(dir, 'node_modules', ...name.split('/'));
    fs.mkdirSync(target, { recursive: true });
    this.exec('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'], { cwd: dir });
    return removed;
  }

  /** One command of a linked package's build, its failure named by package and step (npm's own output is above it). */
  step(pkg, what, run) {
    try {
      return run();
    } catch (e) {
      const why =
        what === 'npm ci'
          ? ' — the ref must be a tree whose package-lock.json matches its package.json (a train publish commit is followed by its lock re-stamp; link the branch tip or the re-stamp)'
          : '';
      throw new Error(`links: ${pkg.repo}/packages/${pkg.dirName} (${pkg.name}): \`${what}\` failed${why}`);
    }
  }

  /** The workspace packages build-workspace would build (its own scanner), for the install-only run. */
  async buildableWorkspacePackages() {
    const { PackageUtil } = require('@proteinjs/util-node');
    const { packageMap, sortedPackageNames } = await PackageUtil.getWorkspaceMetadata(this.repoRoot);
    return sortedPackageNames.filter((name) => name !== 'root' && !!(packageMap[name].packageJson.scripts || {}).build);
  }

  /** Runs a command in the build's log (installs and builds stream); `capture` returns stdout instead. */
  static exec(cmd, args, { cwd, capture = false, env } = {}) {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      env: env || process.env,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return capture ? stdout : '';
  }
}

LinkedWorkspace.DOCKERFILE_LINKS_STAGE = /^FROM scratch AS links$/m;
LinkedWorkspace.TRAIN_LINKS_FILE = '.train/links.json';
LinkedWorkspace.LINKS_ARTIFACT = 'train-links';
LinkedWorkspace.MINTS_ARTIFACT = 'train-mints';

module.exports = { LinkedWorkspace };
