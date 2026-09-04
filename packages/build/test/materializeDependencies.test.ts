import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { cmd } from '@proteinjs/util-node';
import { materializeDependencies, MATERIALIZE_INSTALL_ARGS } from '../src/materializeDependencies';

/**
 * Hermetic npm fixtures (dependency-free package, no network): npm rewrites a committed
 * package-lock.json on EVERY install — normalizing shape, bumping lockfileVersion — which is the
 * churn build-workspace used to leave in every built repo. materializeDependencies installs
 * without that side effect.
 */

// A stale-shaped lockfile npm will rewrite on install (v2 → v3 normalization).
const STALE_LOCKFILE = JSON.stringify(
  {
    name: '@test/materialize',
    version: '1.0.0',
    lockfileVersion: 2,
    requires: true,
    packages: { '': { name: '@test/materialize', version: '1.0.0' } },
  },
  null,
  2
);

describe('materializeDependencies', () => {
  let packageDir: string;
  let lockfilePath: string;
  const originalCI = process.env.CI;

  beforeEach(async () => {
    // The helper's behavior is keyed on CI — pin each test's mode explicitly so the suite
    // behaves identically on a laptop and on a GitHub runner (where CI=true is ambient).
    delete process.env.CI;
    packageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'materialize-deps-test-'));
    lockfilePath = path.join(packageDir, 'package-lock.json');
    await fs.writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: '@test/materialize', version: '1.0.0' }, null, 2)
    );
  });

  afterEach(async () => {
    await fs.rm(packageDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
  });

  it('REPRO: a raw npm install rewrites the committed lockfile', async () => {
    // The same install the helper runs, minus the lockfile snapshot — the snapshot is the only
    // difference between this test and the next.
    await fs.writeFile(lockfilePath, STALE_LOCKFILE);
    await cmd(
      'npm',
      MATERIALIZE_INSTALL_ARGS,
      { cwd: packageDir },
      { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } }
    );
    const after = await fs.readFile(lockfilePath, 'utf-8');
    expect(after).not.toEqual(STALE_LOCKFILE);
  });

  it('installs without mutating the lockfile', async () => {
    await fs.writeFile(lockfilePath, STALE_LOCKFILE);
    await materializeDependencies(packageDir, { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } });
    const after = await fs.readFile(lockfilePath, 'utf-8');
    expect(after).toEqual(STALE_LOCKFILE);
  });

  it('does not introduce a lockfile where none was committed', async () => {
    await materializeDependencies(packageDir, { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } });
    await expect(fs.access(lockfilePath)).rejects.toThrow();
  });

  it('leaves a pre-dirty lockfile at exactly its pre-install content', async () => {
    const preDirty = STALE_LOCKFILE.replace('"requires": true', '"requires": true, "dirty": "someone-elses"');
    await fs.writeFile(lockfilePath, preDirty);
    await materializeDependencies(packageDir, { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } });
    const after = await fs.readFile(lockfilePath, 'utf-8');
    expect(after).toEqual(preDirty);
  });

  it('in CI, the install updates the lockfile — CI commits its own fallout', async () => {
    process.env.CI = 'true';
    await fs.writeFile(lockfilePath, STALE_LOCKFILE);
    await materializeDependencies(packageDir, { omitLogs: { stdout: { omit: true }, stderr: { omit: true } } });
    const after = await fs.readFile(lockfilePath, 'utf-8');
    expect(after).not.toEqual(STALE_LOCKFILE);
  });
});
