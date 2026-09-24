import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/* eslint-disable @typescript-eslint/no-var-requires */
const { LinkedWorkspace } = require('../src/links/LinkedWorkspace');
const { InstalledGraph } = require('../src/links/InstalledGraph');
const { LockEquivalence } = require('../src/links/LockEquivalence');
const { DistHash } = require('../src/links/DistHash');
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * The linked workspace (n3xa's LANDING_TRAINS §1.4p; DEV_ENVIRONMENT "Deploy a workspace"), on
 * fixtures built in a temp dir at run time under fixture package names (@n3xah/fixture-*): the
 * dispatch's preflight, the link (each linked package built at its commit, its pack in place of
 * EVERY copy, one copy per tree), the train's plan from `.train/links.json`, the dist hash (the same
 * number from a tarball and from an installed copy; a version bump and lerna's sibling floors do not
 * move it; a changed byte or a non-reproducible build does), the lock equivalence (a stray transitive
 * bump reds; the linked entries and the root's linked ranges may move), `assert` (a clobbered link
 * is a finding), `prove` (the publish run's equivalence) and `mints`.
 */

const SHA_A = 'a'.repeat(40);

const made: string[] = [];
const tmp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `link-workspace-${label}-`));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

/** A registry copy of a fixture package installed at `dir`. */
const installRegistryCopy = (dir: string, name: string, version: string, dependencies: Record<string, string> = {}) => {
  writeJson(path.join(dir, 'package.json'), { name, version, main: 'dist/index.js', dependencies });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), `module.exports = "registry ${name}@${version}";\n`);
};

/** The fixture workspace: three lerna trees (common, server, ui) with registry copies installed, one also NESTED under a sibling. */
const fixtureWorkspace = () => {
  const root = tmp('app');
  writeJson(path.join(root, 'lerna.json'), { packages: ['packages/common', 'packages/server', 'packages/ui'] });
  writeJson(path.join(root, 'package.json'), { name: 'root', private: true });
  const nm = (tree: string) => path.join(root, 'packages', tree, 'node_modules');
  writeJson(path.join(root, 'packages', 'common', 'package.json'), {
    name: '@n3xa/fixture-app-common',
    dependencies: { '@n3xah/fixture-flow-common': '^1.0.0' },
  });
  installRegistryCopy(path.join(nm('common'), '@n3xah', 'fixture-flow-common'), '@n3xah/fixture-flow-common', '1.0.0');
  writeJson(path.join(root, 'packages', 'server', 'package.json'), {
    name: '@n3xa/fixture-app-server',
    dependencies: {
      '@n3xah/fixture-flow-common': '^1.0.0',
      '@n3xah/fixture-flow-server': '^1.0.0',
      '@n3xah/fixture-space-server': '^1.0.0',
    },
  });
  installRegistryCopy(path.join(nm('server'), '@n3xah', 'fixture-flow-common'), '@n3xah/fixture-flow-common', '1.0.0');
  installRegistryCopy(path.join(nm('server'), '@n3xah', 'fixture-flow-server'), '@n3xah/fixture-flow-server', '1.0.0', {
    '@n3xah/fixture-flow-common': '^1.0.0',
    'fixture-openai': '6.0.0',
  });
  installRegistryCopy(path.join(nm('server'), 'fixture-openai'), 'fixture-openai', '4.0.0');
  installRegistryCopy(
    path.join(nm('server'), '@n3xah', 'fixture-flow-server', 'node_modules', 'fixture-openai'),
    'fixture-openai',
    '6.0.0'
  );
  installRegistryCopy(
    path.join(nm('server'), '@n3xah', 'fixture-space-server'),
    '@n3xah/fixture-space-server',
    '1.0.0',
    {
      '@n3xah/fixture-flow-server': '^1.0.0',
    }
  );
  installRegistryCopy(
    path.join(nm('server'), '@n3xah', 'fixture-space-server', 'node_modules', '@n3xah', 'fixture-flow-server'),
    '@n3xah/fixture-flow-server',
    '1.0.0',
    { '@n3xah/fixture-flow-common': '^1.0.0' }
  );
  writeJson(path.join(root, 'packages', 'ui', 'package.json'), {
    name: '@n3xa/fixture-app-ui',
    dependencies: { '@n3xah/fixture-flow-common': '^1.0.0', '@n3xah/fixture-flow-ui': '^1.0.0' },
  });
  installRegistryCopy(path.join(nm('ui'), '@n3xah', 'fixture-flow-common'), '@n3xah/fixture-flow-common', '1.0.0');
  installRegistryCopy(path.join(nm('ui'), '@n3xah', 'fixture-flow-ui'), '@n3xah/fixture-flow-ui', '1.0.0', {
    '@n3xah/fixture-flow-common': '^1.0.0',
  });
  return root;
};

/** The linked repo as a checkout at one commit: three packages whose build writes a dist naming the linked build; `build` may be a script text. */
const fixtureLinkedRepo = (
  linksDir: string,
  repo: string,
  {
    serverVersion = '1.1.0',
    serverDeclares = '^1.1.0',
    build,
  }: { serverVersion?: string; serverDeclares?: string; build?: (name: string) => string } = {}
) => {
  const dir = path.join(linksDir, repo);
  const script = (name: string) =>
    build
      ? build(name)
      : `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.js','module.exports = \\'linked ${name}\\';\\n')"`;
  const pkg = (dirName: string, name: string, version: string, dependencies: Record<string, string>) =>
    writeJson(path.join(dir, 'packages', dirName, 'package.json'), {
      name,
      version,
      main: 'dist/index.js',
      files: ['dist/**'],
      scripts: { build: script(name) },
      dependencies,
    });
  pkg('a-server', '@n3xah/fixture-flow-server', serverVersion, {
    '@n3xah/fixture-flow-common': serverDeclares,
    'fixture-openai': '6.0.0',
  });
  pkg('common', '@n3xah/fixture-flow-common', '1.1.0', {});
  pkg('ui', '@n3xah/fixture-flow-ui', '1.1.0', { '@n3xah/fixture-flow-common': '^1.1.0' });
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
};

type Call = { cmd: string; args: string[]; cwd?: string };
/** The exec seam: `npm ci` installs a registry copy of each declared sibling (the copy the link must replace); build, pack, git and tar run for real. */
const fixtureExec =
  (calls: Call[]) =>
  (cmd: string, args: string[], options: { cwd?: string; capture?: boolean; env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args: [...args], cwd: options.cwd });
    if (cmd === 'npm' && args[0] === 'ci') {
      const manifest = readJson(path.join(options.cwd as string, 'package.json'));
      for (const name of Object.keys(manifest.dependencies || {})) {
        installRegistryCopy(path.join(options.cwd as string, 'node_modules', ...name.split('/')), name, '1.0.0');
      }
      return '';
    }
    if (cmd === 'npm' && args[0] === 'run' && args[1] === 'build-workspace') {
      return '';
    }
    return execFileSync(cmd, args, { cwd: options.cwd, encoding: 'utf8', env: options.env || process.env });
  };

const linker = ({
  repoRoot,
  linksDir,
  calls = [],
  workspacePackages,
}: {
  repoRoot: string;
  linksDir: string;
  calls?: Call[];
  workspacePackages?: () => Promise<string[]>;
}) =>
  new LinkedWorkspace({
    repoRoot,
    linksDir,
    exec: fixtureExec(calls),
    log: () => undefined,
    packDir: tmp('pack'),
    workspacePackages,
  });

const trainLinks = (
  sha: string,
  packages = ['@n3xah/fixture-flow-common', '@n3xah/fixture-flow-server', '@n3xah/fixture-flow-ui']
) => JSON.stringify({ links: [{ repo: 'n3xah/flow', sha, packages }], floors: [] });

// ─── the dispatch (the dev deploy) ───────────────────────────────────────────────────────────────

describe('plan (the dev deploy)', () => {
  it('parses repo=ref pairs over the allow-list, in order; no links is the registry road', () => {
    expect(
      new LinkedWorkspace().plan({
        links: ' flow=feat/dev-skill-x , util=main ',
        environment: 'dev',
        dockerfile: 'FROM scratch AS links\n',
      })
    ).toEqual([
      { repo: 'flow', ref: 'feat/dev-skill-x' },
      { repo: 'util', ref: 'main' },
    ]);
    expect(new LinkedWorkspace().plan({ links: '', environment: 'dev', dockerfile: '' })).toEqual([]);
    expect(LinkedWorkspace.DEFAULT_REPOS).toEqual([
      'util',
      'chat',
      'thought',
      'space',
      'flow',
      'sandbox',
      'component-template',
    ]);
  });

  it('refuses a repo outside the allow-list, a malformed entry, a repeated repo, a ref a shell could misread, a non-dev target, a Dockerfile without the links stage', () => {
    const plan =
      (links: string, over: Record<string, unknown> = {}) =>
      () =>
        new LinkedWorkspace().plan({ links, environment: 'dev', dockerfile: 'FROM scratch AS links\n', ...over });
    expect(plan('flow=main,app=main')).toThrow(
      /app is not a linkable repo \(util, chat, thought, space, flow, sandbox, component-template\)/
    );
    expect(plan('flow')).toThrow(/"flow" is not repo=ref/);
    expect(plan('flow=main,flow=feat/x')).toThrow(/flow is linked twice/);
    for (const ref of ['main;rm -rf /', 'feat/$(id)', 'a..b', '-rf', 'feat//x', 'feat/x/', 'x.lock', 'feat x']) {
      expect(plan(`flow=${ref}`)).toThrow(/is not a branch, tag or SHA this workflow checks out/);
    }
    for (const environment of ['test', 'prod', '', undefined]) {
      expect(plan('flow=main', { environment })).toThrow(/links deploy to dev only/);
    }
    expect(plan('flow=main', { dockerfile: 'FROM node:22 AS build\n' })).toThrow(
      /its Dockerfile has no `FROM scratch AS links` stage/
    );
    expect(() =>
      new LinkedWorkspace({ repos: ['x'] }).plan({
        links: 'flow=main',
        environment: 'dev',
        dockerfile: 'FROM scratch AS links\n',
      })
    ).toThrow(/flow is not a linkable repo \(x\)/);
  });

  it('resolve: each ref to the commit it names; a ref that does not resolve is refused by name', () => {
    const links = new LinkedWorkspace();
    expect(
      links.resolve([{ repo: 'flow', ref: 'feat/x' }], (repo: string, ref: string) =>
        repo === 'flow' && ref === 'feat/x' ? SHA_A : null
      )
    ).toEqual([{ repo: 'flow', ref: 'feat/x', sha: SHA_A }]);
    expect(() =>
      links.resolve([{ repo: 'flow', ref: 'feat/gone' }], () => {
        throw new Error('HTTP 422');
      })
    ).toThrow(/flow=feat\/gone does not resolve in n3xah\/flow/);
  });

  it('the manifest (BUILD_LINKS): repo=ref@sha entries, rendered and parsed as one format', () => {
    const links = [
      { repo: 'flow', ref: 'feat/x', sha: SHA_A },
      { repo: 'util', ref: 'main', sha: 'b'.repeat(40) },
    ];
    const manifest = LinkedWorkspace.renderManifest(links);
    expect(manifest).toBe(`flow=feat/x@${SHA_A} util=main@${'b'.repeat(40)}`);
    expect(new LinkedWorkspace().parseManifest(manifest)).toEqual(links);
    expect(new LinkedWorkspace().parseManifest('')).toEqual([]);
    expect(() => new LinkedWorkspace().parseManifest('flow=feat/x')).toThrow(
      /BUILD_LINKS entry "flow=feat\/x" is not repo=ref@sha/
    );
  });
});

// ─── the train's plan ────────────────────────────────────────────────────────────────────────────

describe('planFromTrain (.train/links.json)', () => {
  it('reads the derived links: repo, slug, sha and the packages; an absent file is the plain road', () => {
    const plan = new LinkedWorkspace().planFromTrain(trainLinks(SHA_A));
    expect(plan).toEqual([
      {
        repo: 'flow',
        slug: 'n3xah/flow',
        ref: SHA_A,
        sha: SHA_A,
        packages: ['@n3xah/fixture-flow-common', '@n3xah/fixture-flow-server', '@n3xah/fixture-flow-ui'],
      },
    ]);
    expect(new LinkedWorkspace().planFromTrain(null)).toEqual([]);
    expect(new LinkedWorkspace().planFromTrain('')).toEqual([]);
  });

  it('refuses not-JSON, no list, a foreign owner, a repo outside the allow-list, a short sha, a repo linked twice', () => {
    const links = new LinkedWorkspace();
    expect(() => links.planFromTrain('{nope')).toThrow(/not JSON/);
    expect(() => links.planFromTrain('{}')).toThrow(/no "links" list/);
    expect(() => links.planFromTrain(JSON.stringify({ links: [{ repo: 'other/util', sha: SHA_A }] }))).toThrow(
      /not under n3xah/
    );
    expect(() => links.planFromTrain(JSON.stringify({ links: [{ repo: 'n3xah/app', sha: SHA_A }] }))).toThrow(
      /app is not a linkable repo/
    );
    expect(() => links.planFromTrain(JSON.stringify({ links: [{ repo: 'n3xah/util', sha: 'abc' }] }))).toThrow(
      /not a full commit sha/
    );
    expect(() =>
      links.planFromTrain(
        JSON.stringify({
          links: [
            { repo: 'util', sha: SHA_A },
            { repo: 'n3xah/util', sha: SHA_A },
          ],
        })
      )
    ).toThrow(/linked twice/);
  });
});

// ─── the link ────────────────────────────────────────────────────────────────────────────────────

describe('link', () => {
  it('install: every workspace package installs at its own lock and none builds', async () => {
    const calls: Call[] = [];
    const repoRoot = fixtureWorkspace();
    await linker({
      repoRoot,
      linksDir: tmp('links'),
      calls,
      workspacePackages: async () => ['@n3xa/fixture-app-common', '@n3xa/fixture-app-ui'],
    }).install();
    expect(calls).toEqual([
      {
        cmd: 'npm',
        args: ['run', 'build-workspace', '--', '--no-build=@n3xa/fixture-app-common,@n3xa/fixture-app-ui'],
        cwd: repoRoot,
      },
    ]);
  });

  it('each linked package built at its commit; its packed dist replaces EVERY copy in the trees — one copy, the registry copies gone, the nested third-party pin kept; the receipts carry the dist hash; the installed graph holds', () => {
    const repoRoot = fixtureWorkspace();
    const linksDir = tmp('links');
    const { sha } = fixtureLinkedRepo(linksDir, 'flow');
    const calls: Call[] = [];
    const receipts = linker({ repoRoot, linksDir, calls }).link({ links: [{ repo: 'flow', ref: 'feat/x', sha }] });
    const served = (rel: string) => fs.readFileSync(path.join(repoRoot, rel, 'dist', 'index.js'), 'utf8');
    expect(served('packages/common/node_modules/@n3xah/fixture-flow-common')).toMatch(
      /linked @n3xah\/fixture-flow-common/
    );
    expect(served('packages/server/node_modules/@n3xah/fixture-flow-server')).toMatch(
      /linked @n3xah\/fixture-flow-server/
    );
    expect(served('packages/ui/node_modules/@n3xah/fixture-flow-ui')).toMatch(/linked @n3xah\/fixture-flow-ui/);
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          'packages/server/node_modules/@n3xah/fixture-space-server/node_modules/@n3xah/fixture-flow-server'
        )
      )
    ).toBe(false);
    expect(
      readJson(
        path.join(
          repoRoot,
          'packages/server/node_modules/@n3xah/fixture-flow-server/node_modules/fixture-openai/package.json'
        )
      ).version
    ).toBe('6.0.0');
    const server = receipts.find((r: { name: string }) => r.name === '@n3xah/fixture-flow-server');
    expect(server.placed).toEqual(['packages/server/node_modules/@n3xah/fixture-flow-server']);
    expect(server.removed.sort()).toEqual([
      'packages/server/node_modules/@n3xah/fixture-flow-server',
      'packages/server/node_modules/@n3xah/fixture-space-server/node_modules/@n3xah/fixture-flow-server',
    ]);
    expect(server.hash).toMatch(/^[0-9a-f]{64}$/);
    // the placed copy hashes to the pack: the number the verify records is the number the publish will read from node_modules
    expect(
      DistHash.ofDirectory(path.join(repoRoot, 'packages/server/node_modules/@n3xah/fixture-flow-server'), {
        scope: '@n3xah',
      })
    ).toBe(server.hash);
    const builds = calls
      .filter((c) => c.cmd === 'npm' && c.args[0] === 'run' && c.args[1] === 'build')
      .map((c) => path.basename(c.cwd as string));
    expect(builds).toEqual(['common', 'a-server', 'ui']);
    expect(
      fs.readFileSync(
        path.join(linksDir, 'flow/packages/a-server/node_modules/@n3xah/fixture-flow-common/dist/index.js'),
        'utf8'
      )
    ).toMatch(/linked/);
    expect(new InstalledGraph({ repoRoot, log: () => undefined }).run().ok).toBe(true);
  });

  it('refuses: no links but a tree present; a tree at another sha; a linked repo the workspace installs nothing from; a dev-only build that is not dev; a cycle', () => {
    const repoRoot = fixtureWorkspace();
    const linksDir = tmp('links');
    const { dir, sha } = fixtureLinkedRepo(linksDir, 'flow');
    expect(() => linker({ repoRoot, linksDir }).link({ links: [] })).toThrow(/holds flow, but the links name none/);
    expect(() => linker({ repoRoot, linksDir }).link({ links: [{ repo: 'flow', ref: 'feat/x', sha: SHA_A }] })).toThrow(
      new RegExp(`/flow is at ${sha.slice(0, 12)}, not ${SHA_A.slice(0, 12)}`)
    );
    expect(() =>
      linker({ repoRoot, linksDir }).link({
        links: [{ repo: 'flow', ref: 'feat/x', sha }],
        buildVersion: 'pr-1-abc',
        requireBuildPrefix: 'dev-',
      })
    ).toThrow(/links build into dev-… images only/);
    const common = path.join(dir, 'packages/common/package.json');
    writeJson(common, { ...readJson(common), dependencies: { '@n3xah/fixture-flow-ui': '^1.1.0' } });
    git(dir, 'commit', '-qam', 'cycle');
    const cyc = git(dir, 'rev-parse', 'HEAD');
    expect(() => linker({ repoRoot, linksDir }).link({ links: [{ repo: 'flow', ref: 'feat/x', sha: cyc }] })).toThrow(
      /a dependency cycle among the linked packages/
    );
  });

  it('an empty plan with no trees is the registry road — nothing touched', () => {
    const repoRoot = fixtureWorkspace();
    const calls: Call[] = [];
    expect(linker({ repoRoot, linksDir: tmp('links'), calls }).link({ links: [] })).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// ─── the dist hash ───────────────────────────────────────────────────────────────────────────────

describe('DistHash', () => {
  const pkgDir = (label: string, over: Record<string, unknown> = {}, files: Record<string, string> = {}) => {
    const dir = tmp(label);
    writeJson(path.join(dir, 'package.json'), {
      name: '@n3xah/fixture-x',
      version: '1.0.0',
      dependencies: { '@n3xah/fixture-y': '^1.0.0', lodash: '4.0.0' },
      ...over,
    });
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'module.exports = 1;\n');
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return dir;
  };

  it('a version bump, lerna sibling floor moves, gitHead, CHANGELOG.md and node_modules do not move it; a changed byte, a third-party range, a new file do', () => {
    const base = DistHash.ofDirectory(pkgDir('base'), { scope: '@n3xah' });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(DistHash.ofDirectory(pkgDir('bump', { version: '1.1.0' }), { scope: '@n3xah' })).toBe(base);
    expect(
      DistHash.ofDirectory(pkgDir('floor', { dependencies: { '@n3xah/fixture-y': '^1.2.0', lodash: '4.0.0' } }), {
        scope: '@n3xah',
      })
    ).toBe(base);
    expect(DistHash.ofDirectory(pkgDir('githead', { gitHead: 'abc', _id: 'x' }), { scope: '@n3xah' })).toBe(base);
    expect(
      DistHash.ofDirectory(pkgDir('changelog', {}, { 'CHANGELOG.md': '# 1.1.0\n', 'node_modules/z/index.js': '1' }), {
        scope: '@n3xah',
      })
    ).toBe(base);
    expect(
      DistHash.ofDirectory(pkgDir('byte', {}, { 'dist/index.js': 'module.exports = 2;\n' }), { scope: '@n3xah' })
    ).not.toBe(base);
    expect(
      DistHash.ofDirectory(pkgDir('third', { dependencies: { '@n3xah/fixture-y': '^1.0.0', lodash: '4.1.0' } }), {
        scope: '@n3xah',
      })
    ).not.toBe(base);
    expect(DistHash.ofDirectory(pkgDir('newfile', {}, { 'dist/extra.js': '' }), { scope: '@n3xah' })).not.toBe(base);
    expect(DistHash.ofDirectory(pkgDir('noscope'), { scope: null })).not.toBe(base);
  });

  it('a tarball `npm pack` wrote and its installed copy are one number', () => {
    const dir = pkgDir('pack', { files: ['dist/**'] });
    const dest = tmp('packdest');
    const [{ filename }] = JSON.parse(
      execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dest], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    );
    const tarball = path.join(dest, filename);
    const installed = tmp('installed');
    execFileSync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1']);
    expect(DistHash.ofTarball(tarball, { scope: '@n3xah' })).toBe(DistHash.ofDirectory(installed, { scope: '@n3xah' }));
    expect(DistHash.scopeOf('@n3xah/util-server')).toBe('@n3xah');
    expect(DistHash.scopeOf('lodash')).toBeNull();
  });

  it('a build that is not reproducible is caught: two packs of the same commit differ, and the guard says so (the fixture stamps the clock into its dist)', () => {
    const repoRoot = fixtureWorkspace();
    const linksDir = tmp('links');
    const { sha } = fixtureLinkedRepo(linksDir, 'flow', {
      build: (name) =>
        `node -e "const t=process.hrtime.bigint();require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.js','module.exports = \\'${name} built at '+t+'\\';\\n')"`,
    });
    const first = linker({ repoRoot, linksDir }).link({ links: [{ repo: 'flow', ref: 'feat/x', sha }] });
    const second = linker({ repoRoot: fixtureWorkspace(), linksDir }).link({
      links: [{ repo: 'flow', ref: 'feat/x', sha }],
    });
    const hash = (receipts: { name: string; hash: string }[]) =>
      receipts.find((r) => r.name === '@n3xah/fixture-flow-common')!.hash;
    expect(hash(first)).not.toBe(hash(second));
    // the publish's proof over the SECOND build's tree against the FIRST build's record: not equivalent, both hashes named
    const record = linker({ repoRoot, linksDir }).record({
      tip: SHA_A,
      links: [{ repo: 'flow', slug: 'n3xah/flow', sha, packages: [] }],
      receipts: first,
    });
    const proof = linker({ repoRoot, linksDir }).prove({
      links: new LinkedWorkspace().planFromTrain(trainLinks(sha)),
      record,
      trees: [],
    });
    expect(proof.ok).toBe(true); // the first tree still holds the first build
    const other = linker({ repoRoot: fixtureWorkspace(), linksDir });
    other.link({ links: [{ repo: 'flow', ref: 'feat/x', sha }] });
    const proofOther = other.prove({ links: new LinkedWorkspace().planFromTrain(trainLinks(sha)), record, trees: [] });
    expect(proofOther.ok).toBe(false);
    expect(proofOther.why.join('\n')).toMatch(
      /@n3xah\/fixture-flow-common installed [0-9a-f]{12} ≠ verified [0-9a-f]{12}/
    );
  });
});

// ─── the lock equivalence ────────────────────────────────────────────────────────────────────────

describe('LockEquivalence', () => {
  const lock = (over: Record<string, unknown> = {}, root: Record<string, unknown> = {}) =>
    JSON.stringify({
      name: '@n3xa/fixture-app-server',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: '@n3xa/fixture-app-server',
          version: '1.0.0',
          dependencies: { '@n3xah/util-server': '^1.30.1', lodash: '^4.0.0' },
          ...root,
        },
        'node_modules/@n3xah/util-server': {
          version: '1.30.1',
          resolved: 'https://r/util-server-1.30.1.tgz',
          integrity: 'sha512-a',
          dependencies: { lodash: '^4.0.0' },
        },
        'node_modules/lodash': { version: '4.17.21', resolved: 'https://r/lodash-4.17.21.tgz', integrity: 'sha512-b' },
        ...over,
      },
    });
  const linked = ['@n3xah/util-server'];

  it("the linked package's own entry and the root's range on it may move; everything else is equivalent byte for byte", () => {
    const after = lock(
      {
        'node_modules/@n3xah/util-server': {
          version: '1.30.2',
          resolved: 'https://r/util-server-1.30.2.tgz',
          integrity: 'sha512-c',
          dependencies: { lodash: '^4.1.0' },
        },
      },
      { dependencies: { '@n3xah/util-server': '^1.30.2', lodash: '^4.0.0' } }
    );
    expect(LockEquivalence.judge(lock(), after, { linked })).toEqual({ equivalent: true, differences: [] });
    expect(LockEquivalence.judge(lock(), lock(), { linked: [] }).equivalent).toBe(true);
  });

  it('a stray transitive bump — the stamp moving lodash — is NOT equivalent, named by path and field', () => {
    const after = lock({
      'node_modules/lodash': { version: '4.17.22', resolved: 'https://r/lodash-4.17.22.tgz', integrity: 'sha512-d' },
    });
    const verdict = LockEquivalence.judge(lock(), after, { linked });
    expect(verdict.equivalent).toBe(false);
    expect(verdict.differences.map((d: { path: string; field: string }) => `${d.path} ${d.field}`)).toEqual([
      'node_modules/lodash integrity',
      'node_modules/lodash resolved',
      'node_modules/lodash version',
    ]);
    expect(LockEquivalence.describe(verdict.differences)[2]).toBe(
      'node_modules/lodash: version "4.17.21" -> "4.17.22" (lodash is not a linked package)'
    );
  });

  it('an entry added or removed, a linked package nested a second time, a root range on a non-linked name, the lock header — each is a difference', () => {
    expect(
      LockEquivalence.judge(lock(), lock({ 'node_modules/semver': { version: '7.0.0' } }), { linked }).differences[0]
        .why
    ).toBe('semver was added by the stamp');
    expect(
      LockEquivalence.judge(lock({ 'node_modules/semver': { version: '7.0.0' } }), lock(), { linked }).differences[0]
        .why
    ).toBe('semver was removed by the stamp');
    const split = LockEquivalence.judge(
      lock(),
      lock({ 'node_modules/x/node_modules/@n3xah/util-server': { version: '1.30.2' } }),
      { linked }
    );
    expect(split.equivalent).toBe(false);
    expect(split.differences[0].why).toMatch(/@n3xah\/util-server was added/);
    const range = LockEquivalence.judge(
      lock(),
      lock({}, { dependencies: { '@n3xah/util-server': '^1.30.1', lodash: '^4.1.0' } }),
      { linked }
    );
    expect(range.differences).toEqual([
      {
        path: '',
        field: 'dependencies.lodash',
        before: '^4.0.0',
        after: '^4.1.0',
        why: 'lodash is not a linked package',
      },
    ]);
    const header = LockEquivalence.judge(lock(), lock().replace('"lockfileVersion":3', '"lockfileVersion":2'), {
      linked,
    });
    expect(header.differences[0]).toMatchObject({ path: '', field: 'lockfileVersion' });
    expect(() => LockEquivalence.judge('{', lock(), { linked })).toThrow(/the before lock is not JSON/);
  });

  it("isVersionOnlyDiff: the floors chore's package.json shape (ranges, a graduation `a || ^b`, the version field) — anything else is not", () => {
    expect(
      LockEquivalence.isVersionOnlyDiff(
        '--- a\n+++ b\n@@ -1 +1 @@\n-    "@n3xah/util-server": "^1.30.1",\n+    "@n3xah/util-server": "^1.30.2",\n'
      )
    ).toBe(true);
    expect(
      LockEquivalence.isVersionOnlyDiff(
        '-    "@n3xah/flow-common": "^0.50.0",\n+    "@n3xah/flow-common": "^0.50.0 || ^1.0.0-0",\n'
      )
    ).toBe(true);
    expect(LockEquivalence.isVersionOnlyDiff('-  "version": "1.0.0",\n+  "version": "1.0.1",\n')).toBe(true);
    expect(LockEquivalence.isVersionOnlyDiff('')).toBe(true);
    expect(LockEquivalence.isVersionOnlyDiff('+    "build": "tsc",\n')).toBe(false);
    expect(LockEquivalence.isVersionOnlyDiff('+    "@n3xah/util-server": "^1.30.2",\n')).toBe(true);
    expect(LockEquivalence.isVersionOnlyDiff('+    "@n3xah/util-server": "file:../x",\n')).toBe(false);
  });
});

// ─── assert, prove, mints ────────────────────────────────────────────────────────────────────────

describe('assert / prove / mints', () => {
  it('assert: the linked copies as installed hash to the record; a copy npm put back is a finding', () => {
    const repoRoot = fixtureWorkspace();
    const linksDir = tmp('links');
    const { sha } = fixtureLinkedRepo(linksDir, 'flow');
    const links = linker({ repoRoot, linksDir });
    const plan = new LinkedWorkspace().planFromTrain(trainLinks(sha));
    const receipts = links.link({ links: plan });
    const record = links.record({ tip: SHA_A, links: plan, receipts });
    expect(record.tip).toBe(SHA_A);
    expect(record.links[0].packages.map((p: { name: string }) => p.name)).toEqual([
      '@n3xah/fixture-flow-server',
      '@n3xah/fixture-flow-common',
      '@n3xah/fixture-flow-ui',
    ]);
    expect(links.assert({ record })).toMatchObject({ ok: true, checked: 5 });
    installRegistryCopy(
      path.join(repoRoot, 'packages/ui/node_modules/@n3xah/fixture-flow-ui'),
      '@n3xah/fixture-flow-ui',
      '1.0.0'
    );
    const clobbered = links.assert({ record });
    expect(clobbered.ok).toBe(false);
    expect(clobbered.findings[0]).toMatch(
      /packages\/ui: @n3xah\/fixture-flow-ui at node_modules\/@n3xah\/fixture-flow-ui hashes [0-9a-f]{12}, the pack was [0-9a-f]{12} — the linked copy was replaced/
    );
  });

  it("prove: the publish run's equivalence — the installed copies hash to the packs, the locks equivalent over the linked names, the package.json diffs version-only; a stray lock move or a missing record is not ok", () => {
    const repoRoot = fixtureWorkspace();
    const linksDir = tmp('links');
    const { sha } = fixtureLinkedRepo(linksDir, 'flow');
    const links = linker({ repoRoot, linksDir });
    const plan = new LinkedWorkspace().planFromTrain(trainLinks(sha));
    const record = links.record({ tip: SHA_A, links: plan, receipts: links.link({ links: plan }) });
    const before = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@n3xah/fixture-flow-common': '^1.0.0' } },
        'node_modules/@n3xah/fixture-flow-common': { version: '1.0.0' },
        'node_modules/x': { version: '1' },
      },
    });
    const after = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@n3xah/fixture-flow-common': '^1.1.0' } },
        'node_modules/@n3xah/fixture-flow-common': { version: '1.1.0' },
        'node_modules/x': { version: '1' },
      },
    });
    const ok = links.prove({
      links: plan,
      record,
      trees: [
        {
          rel: 'packages/common',
          lockBefore: before,
          lockAfter: after,
          packageJsonDiff:
            '-    "@n3xah/fixture-flow-common": "^1.0.0",\n+    "@n3xah/fixture-flow-common": "^1.1.0",\n',
        },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(ok.judged).toEqual(['packages/common/package-lock.json', 'packages/common/package.json']);
    expect(ok.packages.filter((p: { ok: boolean }) => p.ok).length).toBe(5);
    const stray = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@n3xah/fixture-flow-common': '^1.1.0' } },
        'node_modules/@n3xah/fixture-flow-common': { version: '1.1.0' },
        'node_modules/x': { version: '2' },
      },
    });
    const notOk = links.prove({
      links: plan,
      record,
      trees: [{ rel: 'packages/common', lockBefore: before, lockAfter: stray, packageJsonDiff: '' }],
    });
    expect(notOk.ok).toBe(false);
    expect(notOk.why.join('\n')).toMatch(
      /packages\/common\/package-lock.json is not equivalent over the linked names: node_modules\/x: version "1" -> "2"/
    );
    const notVersionOnly = links.prove({
      links: plan,
      record,
      trees: [
        { rel: 'packages/common', lockBefore: before, lockAfter: after, packageJsonDiff: '+    "build": "tsc",\n' },
      ],
    });
    expect(notVersionOnly.why.join('\n')).toMatch(/packages\/common\/package.json changes more than version lines/);
    expect(links.prove({ links: plan, record: null, trees: [] })).toMatchObject({
      ok: false,
      why: ["the verify run's train-links record could not be read"],
    });
    expect(links.prove({ links: [], record: null, trees: [] })).toMatchObject({
      ok: true,
      why: ['no links at the parent: the plain road'],
    });
    const otherSha = links.prove({
      links: new LinkedWorkspace().planFromTrain(trainLinks('b'.repeat(40))),
      record,
      trees: [],
    });
    expect(otherSha.why[0]).toMatch(/the record links flow at [0-9a-f]{12}, the parent's links.json at bbbbbbbbbbbb/);
  });

  it("mints: the published tarballs hashed by tag; the number equals the pack's (the same bytes)", () => {
    const repoRoot = fixtureWorkspace();
    const linksDir = tmp('links');
    const { sha } = fixtureLinkedRepo(linksDir, 'flow');
    const links = linker({ repoRoot, linksDir });
    const receipts = links.link({ links: [{ repo: 'flow', ref: 'feat/x', sha }] });
    const packs = fs.readdirSync(links.packDir).map((f) => path.join(links.packDir, f));
    const mints = links.mints({
      tags: ['@n3xah/fixture-flow-common@1.1.0', 'not-a-tag'],
      pack: (name: string) => packs.find((p) => path.basename(p).startsWith(name.replace('@', '').replace('/', '-')))!,
    });
    expect(mints).toEqual([
      {
        name: '@n3xah/fixture-flow-common',
        version: '1.1.0',
        tag: '@n3xah/fixture-flow-common@1.1.0',
        hash: receipts.find((r: { name: string }) => r.name === '@n3xah/fixture-flow-common').hash,
      },
    ]);
  });
});

// ─── the installed graph ─────────────────────────────────────────────────────────────────────────

describe('InstalledGraph', () => {
  it("a second copy of an internal package in one tree, a version split across trees, and a range nothing installed resolves are findings; the scopes are the caller's", () => {
    const repoRoot = fixtureWorkspace();
    const graph = new InstalledGraph({ repoRoot, log: () => undefined });
    const first = graph.run();
    expect(first.ok).toBe(false);
    expect(first.failures.map((f: { leg: string }) => f.leg)).toEqual(['one-copy']);
    expect(first.failures[0].message).toMatch(/packages\/server: @n3xah\/fixture-flow-server is installed 2 times/);
    const scoped = new InstalledGraph({ repoRoot, scopes: ['@nobody/'], log: () => undefined }).run();
    expect(scoped.ok).toBe(true);
    fs.rmSync(path.join(repoRoot, 'packages/server/node_modules/@n3xah/fixture-space-server/node_modules'), {
      recursive: true,
    });
    installRegistryCopy(
      path.join(repoRoot, 'packages/ui/node_modules/@n3xah/fixture-flow-common'),
      '@n3xah/fixture-flow-common',
      '1.2.0'
    );
    writeJson(path.join(repoRoot, 'packages/ui/package.json'), {
      name: '@n3xa/fixture-app-ui',
      dependencies: {
        '@n3xah/fixture-flow-common': '^1.0.0',
        '@n3xah/fixture-flow-ui': '^1.0.0',
        '@n3xah/fixture-missing': '^1.0.0',
      },
    });
    const second = new InstalledGraph({ repoRoot, log: () => undefined }).run();
    expect(second.failures.map((f: { leg: string }) => f.leg).sort()).toEqual(['one-version', 'resolution']);
    expect(second.failures.find((f: { leg: string }) => f.leg === 'resolution').message).toMatch(
      /declares @n3xah\/fixture-missing \^1.0.0; nothing installed resolves it/
    );
  });
});
