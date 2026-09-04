import * as path from 'path';
import * as fs from 'fs/promises';
import { PackageProcessError } from '../src/PackageProcessRunner';
import { PackageStamps } from '../src/PackageStamps';
import { WorkspaceFixture } from './WorkspaceFixture';

/**
 * build-workspace: incremental + concurrent (DEV_INFRA_PLAN "Sandbox scalability levers" (c)).
 * Every assertion is an OUTCOME — which dists changed, which build processes ran, in what order,
 * which are still alive — never "function X was called".
 *
 * The chain: a ← b ← c, plus d (independent). All four run with --no-install (their workspace
 * deps are unpublished); `solo` (dependency-free, real lockfile) covers the install stamps.
 */
describe('WorkspaceBuilder', () => {
  // Every run spawns real `npm run build` processes (≈1 s each); several tests run twice or thrice.
  jest.setTimeout(120_000);
  let fixture: WorkspaceFixture;
  const chain = ['a', 'b', 'c', 'd'];
  const names = chain.map((n) => `@test/${n}`);
  const noInstall = { noInstall: names };

  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e.code !== 'ESRCH';
    }
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    fixture = await WorkspaceFixture.create();
    await fixture.addPackage('a');
    await fixture.addPackage('b', { deps: ['a'] });
    await fixture.addPackage('c', { deps: ['b'] });
    await fixture.addPackage('d');
    fixture.commit();
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  describe('cold build', () => {
    it('builds every package in dependency order; dependents see their dependencies’ outputs', async () => {
      const summary = await fixture.run({ args: noInstall });

      expect(summary.built.sort()).toEqual([...names].sort());
      expect(summary.upToDate).toEqual([]);
      const started = await fixture.builtNames();
      expect(started.indexOf('@test/a')).toBeLessThan(started.indexOf('@test/b'));
      expect(started.indexOf('@test/b')).toBeLessThan(started.indexOf('@test/c'));
      // c's dist embeds b's dist which embeds a's — built against the live outputs.
      const c = JSON.parse((await fixture.readDist('c'))!.replace(/^module\.exports = /, '').replace(/;$/, ''));
      expect(c.deps.b.deps.a.src).toBe('a v1');
      for (const name of chain) {
        expect(await new PackageStamps(fixture.packageDir(name)).readBuild()).toBeDefined();
      }
    });
  });

  describe('the strict no-op tripwire', () => {
    it('a second run with nothing changed runs no build at all and leaves every dist byte-identical', async () => {
      await fixture.run({ args: noInstall });
      const dists = await Promise.all(chain.map((n) => fixture.readDist(n)));
      await fixture.clearBuildLog();

      const summary = await fixture.run({ args: noInstall });

      expect(summary.built).toEqual([]);
      expect(summary.upToDate.sort()).toEqual([...names].sort());
      expect(await fixture.builtNames()).toEqual([]);
      expect(await Promise.all(chain.map((n) => fixture.readDist(n)))).toEqual(dists);
    });
  });

  describe('the one-file-change tripwire', () => {
    it('one source change in b rebuilds exactly b and its dependent c — a and d untouched', async () => {
      await fixture.run({ args: noInstall });
      const [distA, , , distD] = await Promise.all(chain.map((n) => fixture.readDist(n)));
      await fixture.clearBuildLog();
      await fixture.writeSource('b', 'b v2');

      const summary = await fixture.run({ args: noInstall });

      expect(summary.built).toEqual(['@test/b', '@test/c']);
      expect(summary.upToDate.sort()).toEqual(['@test/a', '@test/d']);
      expect(await fixture.builtNames()).toEqual(['@test/b', '@test/c']);
      expect(await fixture.readDist('a')).toBe(distA);
      expect(await fixture.readDist('d')).toBe(distD);
      const c = JSON.parse((await fixture.readDist('c'))!.replace(/^module\.exports = /, '').replace(/;$/, ''));
      expect(c.deps.b.src).toBe('b v2');
    });

    it('a new untracked source file counts as a change; a CHANGELOG.md or version bump does not', async () => {
      await fixture.run({ args: noInstall });
      await fs.writeFile(path.join(fixture.packageDir('d'), 'CHANGELOG.md'), '# 1.0.1\n');
      const packageJsonPath = path.join(fixture.packageDir('d'), 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
      await fs.writeFile(packageJsonPath, JSON.stringify({ ...packageJson, version: '1.0.1' }, null, 2));
      expect((await fixture.run({ args: noInstall })).built).toEqual([]);

      await fs.writeFile(path.join(fixture.packageDir('d'), 'src', 'extra.txt'), 'new');
      expect((await fixture.run({ args: noInstall })).built).toEqual(['@test/d']);
    });

    it('a dist removed behind the stamp is rebuilt (outputs are verified, not trusted)', async () => {
      await fixture.run({ args: noInstall });
      await fs.rm(path.join(fixture.packageDir('b'), 'dist'), { recursive: true });

      const summary = await fixture.run({ args: noInstall });

      // b's new dist carries a new nonce, so c's inputs changed too.
      expect(summary.built).toEqual(['@test/b', '@test/c']);
      expect(await fixture.readDist('b')).toBeDefined();
    });
  });

  describe('--force', () => {
    it('rebuilds everything regardless of stamps', async () => {
      await fixture.run({ args: noInstall });
      const dists = await Promise.all(chain.map((n) => fixture.readDist(n)));

      const summary = await fixture.run({ args: { ...noInstall, force: true } });

      expect(summary.built.sort()).toEqual([...names].sort());
      for (let i = 0; i < chain.length; i++) {
        expect(await fixture.readDist(chain[i])).not.toBe(dists[i]);
      }
    });
  });

  describe('concurrency', () => {
    it('independent packages build in parallel up to the bound, and never beyond it', async () => {
      await fixture.run({ args: noInstall, concurrency: 2 }, { FIXTURE_BUILD_SLEEP_MS: '400' });
      const rows = await fixture.buildLogRows();
      const window = (name: string) => ({
        start: rows.find((r) => r.name === name && r.event === 'start')!.at,
        end: rows.find((r) => r.name === name && r.event === 'end')!.at,
      });
      const a = window('@test/a');
      const d = window('@test/d');
      // a and d overlap under concurrency 2 …
      expect(Math.max(a.start, d.start)).toBeLessThan(Math.min(a.end, d.end));
      // … while b (needs a) never overlaps a.
      const b = window('@test/b');
      expect(b.start).toBeGreaterThanOrEqual(a.end);

      await fixture.clearBuildLog();
      await fixture.run({ args: { ...noInstall, force: true }, concurrency: 1 }, { FIXTURE_BUILD_SLEEP_MS: '200' });
      const serial = await fixture.buildLogRows();
      let inFlight = 0;
      for (const row of serial) {
        if (row.event === 'start') {
          inFlight++;
          expect(inFlight).toBe(1);
        } else if (row.event === 'end') {
          inFlight--;
        }
      }
    });

    it('every output line carries the package name', async () => {
      await fixture.run({ args: noInstall });
      const lines = fixture.output
        .join('')
        .split('\n')
        .filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(4);
      for (const line of lines) {
        expect(line).toMatch(/^\[@test\/[abcd]\] /);
      }
      expect(lines).toContain('[@test/c] building @test/c');
    });
  });

  describe('failure', () => {
    it('stops the graph cleanly: names the failed package, never starts its dependents, kills the sibling still running', async () => {
      // a sleeps so d (independent, hanging) is certainly in flight when b fails.
      const run = fixture.run(
        { args: noInstall, concurrency: 2 },
        { FIXTURE_BUILD_FAIL: '@test/b', FIXTURE_BUILD_HANG: '@test/d', FIXTURE_BUILD_SLEEP_MS: '300' }
      );
      await expect(run).rejects.toBeInstanceOf(PackageProcessError);
      const error = (await run.then(
        () => undefined,
        (e) => e
      )) as PackageProcessError;

      expect(error.label).toBe('@test/b');
      expect(error.code).toBe(3);
      expect(error.aborted).toBe(false);
      expect(error.message).toContain('boom from @test/b');
      expect(error.tail).toContain('boom from @test/b');

      const started = await fixture.builtNames();
      expect(started).toContain('@test/d');
      expect(started).not.toContain('@test/c');

      // The hanging sibling's node process (npm → sh → node) is gone: the whole group was killed.
      const hangPid = Number(await fs.readFile(path.join(fixture.pidDir, 'hang.pid'), 'utf-8'));
      for (let i = 0; i < 50 && pidAlive(hangPid); i++) {
        await sleep(100);
      }
      expect(pidAlive(hangPid)).toBe(false);

      // Neither the failed nor the aborted build left a stamp claiming fresh outputs.
      expect(await new PackageStamps(fixture.packageDir('b')).readBuild()).toBeUndefined();
      expect(await new PackageStamps(fixture.packageDir('d')).readBuild()).toBeUndefined();
    });
  });

  describe('flags', () => {
    it('--skip drops the package from the set; --no-build leaves its build unrun', async () => {
      const summary = await fixture.run({ args: { ...noInstall, skip: ['@test/d'], noBuild: ['@test/c'] } });
      expect(summary.packages).toEqual(['@test/a', '@test/b', '@test/c']);
      expect(summary.buildsSkipped).toEqual(['@test/c']);
      expect(summary.built.sort()).toEqual(['@test/a', '@test/b']);
      expect(await fixture.readDist('c')).toBeUndefined();
      expect(await fixture.readDist('d')).toBeUndefined();
    });
  });

  describe('install stamps', () => {
    beforeEach(async () => {
      await fixture.addPackage('solo');
      await fixture.npmInstall('solo');
      fixture.commit('solo');
    });

    const soloOnly = { skip: names };

    it('installs once, then reports the install satisfied while the lock and toolchain are unchanged', async () => {
      const lockBefore = await fixture.readLock('solo');
      const first = await fixture.run({ args: soloOnly });
      expect(first.installed).toEqual(['@test/solo']);
      expect(await new PackageStamps(fixture.packageDir('solo')).readInstall()).toBeDefined();
      // The implicit install preserved the committed lockfile.
      expect(await fixture.readLock('solo')).toBe(lockBefore);

      const second = await fixture.run({ args: soloOnly });
      expect(second.installed).toEqual([]);
      expect(second.installsSatisfied).toEqual(['@test/solo']);
    });

    it('a lock change reinstalls; a release-bookkeeping-only lock change does not', async () => {
      await fixture.run({ args: soloOnly });
      const lock = JSON.parse(await fixture.readLock('solo'));

      await fixture.writeLock(
        'solo',
        JSON.stringify(
          { ...lock, version: '9.9.9', packages: { ...lock.packages, '': { ...lock.packages[''], version: '9.9.9' } } },
          null,
          2
        )
      );
      expect((await fixture.run({ args: soloOnly })).installsSatisfied).toEqual(['@test/solo']);

      await fixture.writeLock('solo', JSON.stringify({ ...lock, requires: false }, null, 2));
      expect((await fixture.run({ args: soloOnly })).installed).toEqual(['@test/solo']);
    });

    it('a satisfied install with intact workspace symlinks re-links nothing; a clobbered link is restored', async () => {
      // `linked` depends on `solo` by file: path — npm links it offline, so its install can run.
      await fixture.addPackage('linked', { fileDeps: ['solo'] });
      await fixture.npmInstall('linked');
      fixture.commit('linked');
      const link = path.join(fixture.packageDir('linked'), 'node_modules', '@test', 'solo');
      const args = { skip: names };

      const first = await fixture.run({ args });
      expect(first.relinked).toContain('@test/linked');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(link)).toBe(await fs.realpath(fixture.packageDir('solo')));
      // Stamp the link itself with a time no fresh link carries: re-linking removes and re-creates
      // it (PackageUtil.symlinkPackage), which stamps `now`. Inode identity is NOT the signal —
      // ext4 hands a re-created link the inode it just freed (the CI runner), APFS never does
      // (a Mac); the mtime stamp reads the same on both.
      const stamp = new Date('2000-01-01T00:00:00Z');
      await fs.lutimes(link, stamp, stamp);

      // Nothing changed: the link is left exactly as it was — never re-created.
      const second = await fixture.run({ args });
      expect(second.installsSatisfied).toContain('@test/linked');
      expect(second.relinked).not.toContain('@test/linked');
      expect(Math.round((await fs.lstat(link)).mtimeMs)).toBe(stamp.getTime());

      // A bare npm install's clobber (a real directory where the link was) is repaired.
      await fs.rm(link, { recursive: true, force: true });
      await fs.mkdir(link, { recursive: true });
      await fs.writeFile(path.join(link, 'package.json'), JSON.stringify({ name: '@test/solo', version: '1.0.0' }));
      const third = await fixture.run({ args });
      expect(third.installsSatisfied).toContain('@test/linked');
      expect(third.relinked).toContain('@test/linked');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(link)).toBe(await fs.realpath(fixture.packageDir('solo')));
    });

    it('a toolchain major change reinstalls; --force reinstalls', async () => {
      await fixture.run({ args: soloOnly });
      const stamps = new PackageStamps(fixture.packageDir('solo'));
      await stamps.writeInstall({ ...(await stamps.readInstall())!, node: '0' });
      expect((await fixture.run({ args: soloOnly })).installed).toEqual(['@test/solo']);

      expect((await fixture.run({ args: { ...soloOnly, force: true } })).installed).toEqual(['@test/solo']);
    });
  });
});
