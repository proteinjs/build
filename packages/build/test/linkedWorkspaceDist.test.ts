import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * The links cores as SHIPPED: this package's own build (`npm run build` — the real tsconfig) is run
 * first, and every assertion loads the compiled files from dist/, never the source jest runs natively.
 *
 * Why a dist-level suite exists at all: the cores are plain JS under `allowJs` with `checkJs` off, so
 * the type checker never sees them. A compile target that cannot iterate a Set or a Map (ES5 without
 * `downlevelIteration`) then turns `[...set]` into `[]` and `for (const [k, v] of map)` into a loop over
 * `map.length` SILENTLY — where the same construct in a .ts file is a compile error. Every source-level
 * test stays green while the shipped build orders nothing, refuses no cycle, reads no tags, compares no
 * lock entries and finds no trees. These tests pin the shipped behaviour to the source's.
 */
const packageDir = path.resolve(__dirname, '..');
const distLinks = path.join(packageDir, 'dist', 'src', 'links');

const made: string[] = [];
const tmp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `link-workspace-dist-${label}-`));
  made.push(dir);
  return dir;
};
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
/** A linked-repo checkout's packages/ under `linksDir/<repo>`: [dirName, name, dependencies], written in the order given. */
const fixtureRepo = (linksDir: string, repo: string, packages: [string, string, Record<string, string>][]) => {
  for (const [dirName, name, dependencies] of packages) {
    writeJson(path.join(linksDir, repo, 'packages', dirName, 'package.json'), { name, version: '1.0.0', dependencies });
  }
};
const ORG = { owner: 'acme', repos: ['chain', 'loop'], scopes: ['@acme/'], log: () => undefined };

beforeAll(() => {
  try {
    execFileSync('npm', ['run', 'build'], { cwd: packageDir, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`the package's own build failed:\n${err.stdout || ''}${err.stderr || ''}${err.message}`);
  }
}, 120_000);
afterAll(() => {
  for (const dir of made) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('the shipped build (dist/) of the links cores', () => {
  it('buildOrder: the linked packages in dependency order — a chain declared against the listing order builds leaf first; ties keep the listing', () => {
    const { LinkedWorkspace } = require(path.join(distLinks, 'LinkedWorkspace'));
    const linksDir = tmp('chain');
    // listing a, b, c, d; a needs b, b needs c; d needs nothing → c, b, a, then d (the tie keeps the listing)
    fixtureRepo(linksDir, 'chain', [
      ['a', '@acme/fixture-a', { '@acme/fixture-b': '^1.0.0' }],
      ['b', '@acme/fixture-b', { '@acme/fixture-c': '^1.0.0' }],
      ['c', '@acme/fixture-c', {}],
      ['d', '@acme/fixture-d', {}],
    ]);
    const linker = new LinkedWorkspace({ repoRoot: tmp('app'), linksDir, ...ORG });
    const listed = linker.repoPackages({ repo: 'chain' }).map((p: { dirName: string }) => p.dirName);
    expect(listed).toEqual(['a', 'b', 'c', 'd']);
    const order = linker.buildOrder(linker.repoPackages({ repo: 'chain' })).map((p: { dirName: string }) => p.dirName);
    expect(order).toEqual(['c', 'b', 'a', 'd']);
  });

  it('buildOrder: a two-package cycle is refused, naming the packages on it', () => {
    const { LinkedWorkspace } = require(path.join(distLinks, 'LinkedWorkspace'));
    const linksDir = tmp('loop');
    fixtureRepo(linksDir, 'loop', [
      ['a', '@acme/fixture-a', { '@acme/fixture-b': '^1.0.0' }],
      ['b', '@acme/fixture-b', { '@acme/fixture-a': '^1.0.0' }],
    ]);
    const linker = new LinkedWorkspace({ repoRoot: tmp('app'), linksDir, ...ORG });
    expect(() => linker.buildOrder(linker.repoPackages({ repo: 'loop' }))).toThrow(
      'links: a dependency cycle among the linked packages: @acme/fixture-a, @acme/fixture-b — no build order exists'
    );
  });

  it('tagsCreatedSince: the tags a run created come back (a Set spread into the sorted list)', () => {
    const { LinkedWorkspace } = require(path.join(distLinks, 'LinkedWorkspace'));
    const tags = LinkedWorkspace.tagsCreatedSince({
      git: (args: string[]) => (args[0] === 'tag' ? '@acme/fixture-b@1.0.1\n@acme/fixture-a@1.0.1\n' : ''),
    });
    expect(tags).toEqual(['@acme/fixture-a@1.0.1', '@acme/fixture-b@1.0.1']);
  });

  it('LockEquivalence.judge: a moved package entry is a difference (the union of the lock keys is a Set spread)', () => {
    const { LockEquivalence } = require(path.join(distLinks, 'LockEquivalence'));
    const lock = (version: string) =>
      JSON.stringify({ name: 'root', lockfileVersion: 3, packages: { 'node_modules/left-pad': { version } } });
    const verdict = LockEquivalence.judge(lock('1.0.0'), lock('2.0.0'), { linked: [] });
    expect(verdict.equivalent).toBe(false);
    expect(verdict.differences.map((d: { path: string; field: string | null }) => `${d.path} ${d.field}`)).toEqual([
      'node_modules/left-pad version',
    ]);
  });

  it('InstalledGraph: the lerna trees are found (a Set spread), a second copy and a version split are findings (Maps iterated)', () => {
    const { InstalledGraph } = require(path.join(distLinks, 'InstalledGraph'));
    const repoRoot = tmp('graph');
    writeJson(path.join(repoRoot, 'lerna.json'), { packages: ['packages/common', 'apps/*'] });
    writeJson(path.join(repoRoot, 'packages', 'common', 'package.json'), { name: '@consumer/common' });
    writeJson(path.join(repoRoot, 'apps', 'ui', 'package.json'), { name: '@consumer/ui' });
    const graph = new InstalledGraph({ repoRoot, scopes: ORG.scopes, log: () => undefined });
    // lerna.json's pattern order, each glob's expansion sorted
    expect(graph.loadTrees().map((t: { rel: string }) => t.rel)).toEqual(['packages/common', 'apps/ui']);
    const tree = (label: string, packages: Record<string, { version: string }>) => ({ label, lock: { packages } });
    expect(
      graph
        .assertOneCopy([
          tree('packages/common', {
            'node_modules/@acme/fixture-a': { version: '1.0.0' },
            'node_modules/x/node_modules/@acme/fixture-a': { version: '1.0.0' },
          }),
        ])
        .map((f: { leg: string }) => f.leg)
    ).toEqual(['one-copy']);
    expect(
      graph
        .oneVersionSplits([
          tree('packages/common', { 'node_modules/@acme/fixture-a': { version: '1.0.0' } }),
          tree('apps/ui', { 'node_modules/@acme/fixture-a': { version: '2.0.0' } }),
        ])
        .map((s: { name: string; versions: string[] }) => `${s.name} ${s.versions.join(' ')}`)
    ).toEqual(['@acme/fixture-a 1.0.0 2.0.0']);
  });
});
