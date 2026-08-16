import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { symlinkWorkspace } from '../src/symlinkWorkspace';

/**
 * Regression tests for symlink-workspace coverage (metarepo issue #75).
 *
 * Root-named consumers must symlink like everyone else. Every workspace root in the metarepo
 * is named `root` (the metarepo root, the app root, each nested lerna root); the old
 * implementation both SKIPPED the name `root` outright and iterated the name-keyed package
 * map, in which same-named packages collide — so root-named packages never had their
 * workspace deps symlinked and kept STALE REGISTRY copies indefinitely (live case: the app
 * root's registry @proteinjs/build carried an old @proteinjs/util-node, so the dev-server
 * OOM persisted after the workspace fix had shipped).
 *
 * Coverage must come from the PATH-KEYED discovery map: one entry per package.json, no name
 * collisions, roots included.
 */
describe('symlinkWorkspace — root-named consumers symlink like everyone else', () => {
  let workspaceRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'symlink-ws-'));
    // macOS mkdtemp returns /var/... which is a symlink to /private/var — realpath so
    // cwd-derived paths and fixture paths compare equal.
    workspaceRoot = await fs.realpath(workspaceRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {
        /* ignore */
      });
    }
  });

  const writePackageJson = async (
    relDir: string,
    name: string,
    deps: Record<string, string> = {},
    devDeps: Record<string, string> = {}
  ) => {
    const dir = path.join(workspaceRoot, relDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies: deps, devDependencies: devDeps }, null, 2)
    );
  };

  /**
   * The metarepo shape: metarepo root and app root BOTH named `root` with different deps,
   * a transitive chain under the metarepo root's dep, and one regular consumer.
   */
  const writeMetarepoFixture = async () => {
    await writePackageJson('.', 'root', {}, { '@test/build-tools': '^1.0.0' });
    await writePackageJson('packages/app', 'root', {}, { '@test/app-lib': '^1.0.0' });
    await writePackageJson('packages/tools/build-tools', '@test/build-tools', { '@test/util-lib': '^1.0.0' });
    await writePackageJson('packages/tools/util-lib', '@test/util-lib');
    await writePackageJson('packages/app/packages/app-lib', '@test/app-lib');
    await writePackageJson('packages/consumer', '@test/consumer', { '@test/util-lib': '^1.0.0' });
  };

  test('symlinks every discovered package, including both root-named consumers', async () => {
    await writeMetarepoFixture();
    process.chdir(workspaceRoot);

    await symlinkWorkspace();

    // Metarepo root: its own transitive closure (build-tools + util-lib), nothing else's.
    await expectSymlinkTo(
      path.join(workspaceRoot, 'node_modules/@test/build-tools'),
      path.join(workspaceRoot, 'packages/tools/build-tools')
    );
    await expectSymlinkTo(
      path.join(workspaceRoot, 'node_modules/@test/util-lib'),
      path.join(workspaceRoot, 'packages/tools/util-lib')
    );
    await expectAbsent(path.join(workspaceRoot, 'node_modules/@test/app-lib'));

    // App root (same name `root`): ITS closure, not the metarepo root's.
    await expectSymlinkTo(
      path.join(workspaceRoot, 'packages/app/node_modules/@test/app-lib'),
      path.join(workspaceRoot, 'packages/app/packages/app-lib')
    );
    await expectAbsent(path.join(workspaceRoot, 'packages/app/node_modules/@test/build-tools'));

    // Regular consumers keep working exactly as before.
    await expectSymlinkTo(
      path.join(workspaceRoot, 'packages/consumer/node_modules/@test/util-lib'),
      path.join(workspaceRoot, 'packages/tools/util-lib')
    );
  });

  test('--skip still filters by package name', async () => {
    await writeMetarepoFixture();
    process.chdir(workspaceRoot);
    const originalArgv = process.argv;
    process.argv = [...originalArgv.slice(0, 2), '--skip=@test/consumer'];
    try {
      await symlinkWorkspace();
    } finally {
      process.argv = originalArgv;
    }

    // Skipped consumer got nothing; everyone else (including roots) still linked.
    await expectAbsent(path.join(workspaceRoot, 'packages/consumer/node_modules/@test/util-lib'));
    await expectSymlinkTo(
      path.join(workspaceRoot, 'node_modules/@test/build-tools'),
      path.join(workspaceRoot, 'packages/tools/build-tools')
    );
  });

  const expectSymlinkTo = async (linkPath: string, expectedTargetDir: string) => {
    const stat = await fs.lstat(linkPath).catch(() => undefined);
    expect(stat?.isSymbolicLink() ?? false).toBe(true);
    expect(await fs.realpath(linkPath)).toBe(await fs.realpath(expectedTargetDir));
  };

  const expectAbsent = async (linkPath: string) => {
    const stat = await fs.lstat(linkPath).catch(() => undefined);
    expect(stat).toBeUndefined();
  };
});
