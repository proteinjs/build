import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { PackageTreeHasher } from '../src/PackageTreeHasher';

/**
 * The source/output split is git's: tracked + unignored-untracked = sources, ignored = outputs,
 * node_modules in neither. Release bookkeeping (version fields, workspace-member lock entries,
 * CHANGELOG.md) never moves a hash; anything that can change a compiled byte does.
 */
describe('PackageTreeHasher', () => {
  let repo: string;
  let packageDir: string;
  const members = new Set(['@ws/lib', '@ws/other', 'root']);
  const hasher = new PackageTreeHasher(members);

  const write = async (relPath: string, content: string) => {
    const filePath = path.join(packageDir, relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  };

  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    }
  };

  beforeEach(async () => {
    repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tree-hasher-')));
    packageDir = path.join(repo, 'packages', 'consumer');
    git('init', '-q');
    await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
    await write(
      'package.json',
      JSON.stringify({ name: '@ws/consumer', version: '1.0.0', dependencies: { '@ws/lib': '^1.2.0', left: '1.0.0' } })
    );
    await write('src/index.ts', 'export const a = 1;');
    await write('CHANGELOG.md', '# 1.0.0');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    await write('dist/index.js', 'var a = 1;');
    await write('node_modules/left/index.js', 'module.exports = 1;');
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('is deterministic', async () => {
    expect(await hasher.hash(packageDir)).toEqual(await hasher.hash(packageDir));
  });

  it('a tracked source edit moves the source hash only', async () => {
    const before = await hasher.hash(packageDir);
    await write('src/index.ts', 'export const a = 2;');
    const after = await hasher.hash(packageDir);
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect(after.outputHash).toBe(before.outputHash);
  });

  it('an untracked, unignored file is a source; an ignored file is an output', async () => {
    const before = await hasher.hash(packageDir);
    await write('src/new.ts', 'export const n = 1;');
    const withUntracked = await hasher.hash(packageDir);
    expect(withUntracked.sourceHash).not.toBe(before.sourceHash);
    expect(withUntracked.outputHash).toBe(before.outputHash);

    await write('dist/extra.js', 'x');
    const withOutput = await hasher.hash(packageDir);
    expect(withOutput.sourceHash).toBe(withUntracked.sourceHash);
    expect(withOutput.outputHash).not.toBe(withUntracked.outputHash);
  });

  it('a deleted tracked file is a change', async () => {
    const before = await hasher.hash(packageDir);
    await fs.rm(path.join(packageDir, 'src', 'index.ts'));
    expect((await hasher.hash(packageDir)).sourceHash).not.toBe(before.sourceHash);
  });

  it('node_modules and .DS_Store never move either hash', async () => {
    const before = await hasher.hash(packageDir);
    await write('node_modules/left/index.js', 'module.exports = 2;');
    await write('node_modules/.proteinjs-build-stamp', '{}');
    await write('.DS_Store', 'finder');
    await write('dist/.DS_Store', 'finder');
    expect(await hasher.hash(packageDir)).toEqual(before);
  });

  it('a nested git work tree is not part of the package', async () => {
    const before = await hasher.hash(packageDir);
    await write('vendor/.git', 'gitdir: elsewhere');
    await write('vendor/file.txt', 'other repo');
    expect((await hasher.hash(packageDir)).outputHash).toBe(before.outputHash);
  });

  it('release bookkeeping is not a source: CHANGELOG.md, version, workspace-member specs', async () => {
    const before = await hasher.hash(packageDir);
    await write('CHANGELOG.md', '# 1.0.1\n\nbumped');
    await write(
      'package.json',
      JSON.stringify({ name: '@ws/consumer', version: '1.0.1', dependencies: { '@ws/lib': '^1.3.0', left: '1.0.0' } })
    );
    expect((await hasher.hash(packageDir)).sourceHash).toBe(before.sourceHash);

    // An external spec change IS a source change.
    await write(
      'package.json',
      JSON.stringify({ name: '@ws/consumer', version: '1.0.1', dependencies: { '@ws/lib': '^1.3.0', left: '1.1.0' } })
    );
    expect((await hasher.hash(packageDir)).sourceHash).not.toBe(before.sourceHash);
  });

  describe('lockHash', () => {
    const lock = {
      name: '@ws/consumer',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: '@ws/consumer', version: '1.0.0', dependencies: { '@ws/lib': '^1.2.0', left: '1.0.0' } },
        'node_modules/@ws/lib': { version: '1.2.0', resolved: 'https://registry/lib-1.2.0.tgz', integrity: 'sha512-a' },
        'node_modules/@ws/lib/node_modules/inner': {
          version: '0.1.0',
          resolved: 'https://registry/inner',
          integrity: 'sha512-b',
        },
        'node_modules/left': { version: '1.0.0', resolved: 'https://registry/left-1.0.0.tgz', integrity: 'sha512-c' },
        'node_modules/left/node_modules/@ws/other': {
          version: '2.0.0',
          resolved: 'https://registry/other',
          integrity: 'sha512-d',
        },
      },
    };

    it('is undefined without a lockfile', async () => {
      expect(await hasher.lockHash(packageDir)).toBeUndefined();
    });

    it('a release re-stamp (versions + workspace-member entries) keeps the hash; an external change moves it', async () => {
      await write('package-lock.json', JSON.stringify(lock));
      const before = await hasher.lockHash(packageDir);

      const restamped = {
        ...lock,
        version: '1.0.1',
        packages: {
          ...lock.packages,
          '': { ...lock.packages[''], version: '1.0.1', dependencies: { '@ws/lib': '^1.3.0', left: '1.0.0' } },
          'node_modules/@ws/lib': {
            version: '1.3.0',
            resolved: 'https://registry/lib-1.3.0.tgz',
            integrity: 'sha512-z',
          },
          'node_modules/@ws/lib/node_modules/inner': {
            version: '0.2.0',
            resolved: 'https://registry/inner2',
            integrity: 'sha512-y',
          },
        },
      };
      delete (restamped.packages as any)['node_modules/left/node_modules/@ws/other'];
      await write('package-lock.json', JSON.stringify(restamped));
      expect(await hasher.lockHash(packageDir)).toBe(before);

      const bumped = {
        ...lock,
        packages: {
          ...lock.packages,
          'node_modules/left': { ...lock.packages['node_modules/left'], version: '1.1.0' },
        },
      };
      await write('package-lock.json', JSON.stringify(bumped));
      expect(await hasher.lockHash(packageDir)).not.toBe(before);

      const added = {
        ...lock,
        packages: { ...lock.packages, 'node_modules/zod': { version: '3.0.0', resolved: 'r', integrity: 'i' } },
      };
      await write('package-lock.json', JSON.stringify(added));
      expect(await hasher.lockHash(packageDir)).not.toBe(before);
    });

    it('lockfile v2 drops the legacy dependencies mirror; v1 normalizes the dependencies tree', () => {
      const v2 = hasher.normalizeLockfile({
        ...lock,
        lockfileVersion: 2,
        dependencies: { left: { version: '1.0.0' }, '@ws/lib': { version: '1.2.0' } },
      });
      expect(v2.dependencies).toBeUndefined();
      expect(Object.keys(v2.packages)).toEqual(['', 'node_modules/left']);
      expect(v2.packages[''].version).toBeUndefined();
      expect(v2.packages[''].dependencies['@ws/lib']).toBe('<workspace>');

      const v1 = hasher.normalizeLockfile({
        lockfileVersion: 1,
        dependencies: {
          '@ws/lib': { version: '1.2.0' },
          left: {
            version: '1.0.0',
            requires: { '@ws/other': '^2.0.0', tiny: '1.0.0' },
            dependencies: { '@ws/other': { version: '2.0.0' }, tiny: { version: '1.0.0' } },
          },
        },
      });
      expect(v1.dependencies).toEqual({
        left: {
          version: '1.0.0',
          requires: { '@ws/other': '<workspace>', tiny: '1.0.0' },
          dependencies: { tiny: { version: '1.0.0' } },
        },
      });
    });
  });

  it('a package outside any git work tree is an error that names the rule', async () => {
    const loose = await fs.mkdtemp(path.join(os.tmpdir(), 'tree-hasher-loose-'));
    try {
      await fs.writeFile(path.join(loose, 'package.json'), '{}');
      await expect(hasher.hash(loose)).rejects.toThrow(/derives each package's sources from git/);
    } finally {
      await fs.rm(loose, { recursive: true, force: true });
    }
  });
});
