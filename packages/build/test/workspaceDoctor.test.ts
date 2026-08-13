import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { PackageUtil } from '@proteinjs/util-node';
import { WorkspaceDoctor } from '../src/WorkspaceDoctor';

/**
 * Hermetic fixture workspace (no npm, no network): lib <- consumer, symlinked the same way
 * symlink-workspace does it. Each finding kind is produced by staging its real-world cause and
 * asserting the doctor names it; fix() is exercised for the two remediations that do not need
 * the network (re-symlink, rebuild).
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('WorkspaceDoctor', () => {
  let workspacePath: string;
  let libDir: string;
  let consumerDir: string;

  const writeJson = async (filePath: string, value: unknown) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2));
  };

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-doctor-test-'));
    // Workspace root package (excluded from diagnosis like the metarepo root).
    await writeJson(path.join(workspacePath, 'package.json'), { name: 'root', private: true });

    libDir = path.join(workspacePath, 'packages', 'lib');
    // A build script that stamps dist — lets fix() rebuild without npm/network. The build also
    // regenerates dist fully, mirroring tsc output freshness.
    await writeJson(path.join(libDir, 'package.json'), {
      name: '@test/lib',
      version: '1.0.0',
      scripts: {
        build:
          "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.js','')\"",
      },
    });
    await fs.mkdir(path.join(libDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(libDir, 'src', 'index.ts'), 'export const x = 1;');
    await fs.mkdir(path.join(libDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(libDir, 'dist', 'index.js'), '');

    consumerDir = path.join(workspacePath, 'packages', 'consumer');
    await writeJson(path.join(consumerDir, 'package.json'), {
      name: '@test/consumer',
      version: '1.0.0',
      dependencies: { '@test/lib': '1.0.0', 'left-pad': '^1.0.0' },
    });
    // The external dep is "installed" as a real directory, as npm would leave it.
    await writeJson(path.join(consumerDir, 'node_modules', 'left-pad', 'package.json'), {
      name: 'left-pad',
      version: '1.3.0',
    });

    // Link the workspace the same way symlink-workspace does.
    const { packageMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
    await PackageUtil.symlinkDependencies(packageMap['@test/consumer'], packageMap);
    // Ensure dist mtimes are >= src mtimes after setup ordering.
    await fs.utimes(path.join(libDir, 'dist', 'index.js'), new Date(), new Date(Date.now() + 1000));
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it('a freshly linked workspace diagnoses clean', async () => {
    const doctor = new WorkspaceDoctor(workspacePath);
    expect(await doctor.diagnose()).toEqual([]);
  });

  it('a workspace dep replaced by a real directory (bare npm install) is CLOBBERED — and fix() restores the symlink', async () => {
    const entry = path.join(consumerDir, 'node_modules', '@test', 'lib');
    await fs.rm(entry, { recursive: true, force: true });
    // What npm leaves behind: a real extracted copy.
    await writeJson(path.join(entry, 'package.json'), { name: '@test/lib', version: '1.0.0' });

    const doctor = new WorkspaceDoctor(workspacePath);
    const findings = await doctor.diagnose();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ packageName: '@test/consumer', kind: 'clobbered-symlink' });
    expect(findings[0].detail).toContain('@test/lib');

    const remaining = await doctor.fix(findings);
    expect(remaining).toEqual([]);
    const stat = await fs.lstat(entry);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('a missing workspace link (pruned) is CLOBBERED', async () => {
    await fs.rm(path.join(consumerDir, 'node_modules', '@test', 'lib'), { recursive: true, force: true });
    const doctor = new WorkspaceDoctor(workspacePath);
    const findings = await doctor.diagnose();
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('clobbered-symlink');
    expect(findings[0].detail).toContain('missing from node_modules');
  });

  it('a declared external dep with no node_modules entry (pulled dependency addition) is MISSING-INSTALL', async () => {
    await fs.rm(path.join(consumerDir, 'node_modules', 'left-pad'), { recursive: true, force: true });
    const doctor = new WorkspaceDoctor(workspacePath);
    const findings = await doctor.diagnose();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ packageName: '@test/consumer', kind: 'missing-install' });
    expect(findings[0].detail).toContain('left-pad');
  });

  it('src newer than dist is STALE-DIST — and fix() rebuilds it', async () => {
    await sleep(5); // mtime resolution guard
    const future = new Date(Date.now() + 2000);
    await fs.utimes(path.join(libDir, 'src', 'index.ts'), future, future);

    const doctor = new WorkspaceDoctor(workspacePath);
    const findings = await doctor.diagnose();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ packageName: '@test/lib', kind: 'stale-dist' });

    // fix() runs the package's build; the fixture build rewrites dist, making it newest again...
    // except our src mtime is 2s in the future. Re-stamp src to NOW before fixing so the rebuild
    // genuinely lands newer (mirrors real life, where src edits are in the past by build time).
    const now = new Date();
    await fs.utimes(path.join(libDir, 'src', 'index.ts'), now, now);
    const remaining = await doctor.fix(await doctor.diagnose());
    expect(remaining).toEqual([]);
  });

  it('--for scoping covers the named package AND its transitive closure, nothing else', async () => {
    // Break BOTH packages: clobber consumer's lib link and make lib's dist stale.
    await fs.rm(path.join(consumerDir, 'node_modules', '@test', 'lib'), { recursive: true, force: true });
    const future = new Date(Date.now() + 2000);
    await fs.utimes(path.join(libDir, 'src', 'index.ts'), future, future);

    const doctor = new WorkspaceDoctor(workspacePath);
    // Scoped to lib only: consumer's clobber is out of scope.
    const libFindings = await doctor.diagnose(['@test/lib']);
    expect(libFindings.map((f) => f.kind)).toEqual(['stale-dist']);
    // Scoped to consumer: closure pulls lib in, so BOTH findings surface.
    const consumerFindings = await doctor.diagnose(['@test/consumer']);
    expect(consumerFindings.map((f) => f.kind).sort()).toEqual(['clobbered-symlink', 'stale-dist']);
  });

  it('findWorkspaceRoot resolves the OUTERMOST package dir from a nested package', async () => {
    expect(await WorkspaceDoctor.findWorkspaceRoot(consumerDir)).toBe(workspacePath);
  });

  it('fix() survives a failing build — the failure lands on the finding and later packages still build', async () => {
    // downstream depends on broken, so broken builds FIRST and fails; downstream's build must
    // still run (continuation), and broken's finding must survive carrying the failure output.
    const brokenDir = path.join(workspacePath, 'packages', 'broken');
    await writeJson(path.join(brokenDir, 'package.json'), {
      name: '@test/broken',
      version: '1.0.0',
      scripts: { build: 'node -e "console.error(\'TS2322: boom\'); process.exit(1)"' },
    });
    await fs.mkdir(path.join(brokenDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(brokenDir, 'src', 'index.ts'), 'export const broken = 1;');

    const downstreamDir = path.join(workspacePath, 'packages', 'downstream');
    await writeJson(path.join(downstreamDir, 'package.json'), {
      name: '@test/downstream',
      version: '1.0.0',
      dependencies: { '@test/broken': '1.0.0' },
      scripts: {
        build:
          "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.js','')\"",
      },
    });
    await fs.mkdir(path.join(downstreamDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(downstreamDir, 'src', 'index.ts'), 'export const downstream = 1;');
    const { packageMap } = await PackageUtil.getWorkspaceMetadata(workspacePath);
    await PackageUtil.symlinkDependencies(packageMap['@test/downstream'], packageMap);

    const doctor = new WorkspaceDoctor(workspacePath);
    const findings = await doctor.diagnose();
    expect(findings.map((f) => `${f.packageName}:${f.kind}`).sort()).toEqual([
      '@test/broken:stale-dist',
      '@test/downstream:stale-dist',
    ]);

    const remaining = await doctor.fix(findings);
    // Continuation outcome: downstream's build ran (and succeeded) after broken's failed one.
    await fs.access(path.join(downstreamDir, 'dist', 'index.js'));
    // broken's build never emits, so its stale-dist finding SURVIVES re-diagnosis and takes the
    // annotation path — the failure lands on that finding, not a synthesized build-failed one.
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ packageName: '@test/broken', kind: 'stale-dist' });
    expect(remaining[0].detail).toContain('build FAILED');
    expect(remaining[0].detail).toContain('TS2322: boom');
  }, 30000);

  it('a failed build that still EMITS dist surfaces as BUILD-FAILED — and a re-fix retries the build', async () => {
    // Without noEmitOnError, tsc emits before exiting nonzero: dist freshens, the stale-dist
    // finding vanishes on re-diagnosis, and pre-synthesis the failure was silently certified
    // coherent. The build script mirrors that: emit dist, log the attempt, fail until the
    // "type error" is fixed (marker file).
    const emittingDir = path.join(workspacePath, 'packages', 'emitting-broken');
    await writeJson(path.join(emittingDir, 'package.json'), {
      name: '@test/emitting-broken',
      version: '1.0.0',
      scripts: {
        build:
          "node -e \"const fs=require('fs');fs.appendFileSync('build-attempts.log','run\\n');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.js','x');if(!fs.existsSync('fixed.marker')){console.error('TS2322: boom');process.exit(1)}\"",
      },
    });
    await fs.mkdir(path.join(emittingDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(emittingDir, 'src', 'index.ts'), 'export const emitting = 1;');

    const doctor = new WorkspaceDoctor(workspacePath);
    const findings = await doctor.diagnose();
    expect(findings.map((f) => `${f.packageName}:${f.kind}`)).toEqual(['@test/emitting-broken:stale-dist']);

    const remaining = await doctor.fix(findings);
    // dist got emitted (fresh), so no stale-dist survives — the failure must surface anyway.
    await fs.access(path.join(emittingDir, 'dist', 'index.js'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ packageName: '@test/emitting-broken', kind: 'build-failed' });
    expect(remaining[0].detail).toContain('TS2322: boom');
    expect(remaining[0].remediation).toContain('npm run build');

    // Re-fix with the build-failed finding retries the build (attempt #2); with the "type error"
    // fixed the retry succeeds and the workspace certifies coherent.
    await fs.writeFile(path.join(emittingDir, 'fixed.marker'), '');
    const afterRefix = await doctor.fix(remaining);
    expect(afterRefix).toEqual([]);
    const attempts = await fs.readFile(path.join(emittingDir, 'build-attempts.log'), 'utf8');
    expect(attempts.trim().split('\n')).toHaveLength(2);
  }, 30000);

  it('the build package tsconfig blocks emit on type errors (noEmitOnError)', async () => {
    // Compile a type-broken fixture through THIS package's actual tsconfig: a failed build
    // must not freshen dist, or the doctor's stale-dist check certifies broken output.
    const buildPackageDir = path.join(__dirname, '..');
    const fixtureDir = path.join(workspacePath, 'noemit-fixture');
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.copyFile(path.join(buildPackageDir, 'tsconfig.json'), path.join(fixtureDir, 'tsconfig.json'));
    await fs.writeFile(path.join(fixtureDir, 'index.ts'), 'export const n: number = "not a number";\n');
    await fs.symlink(path.join(buildPackageDir, 'node_modules'), path.join(fixtureDir, 'node_modules'));

    const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', '.'], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    // The failure must be the TYPE error — a tsconfig/harness breakage exiting nonzero for some
    // other reason would green this test vacuously. tsc reports type errors on stdout.
    expect(result.stdout).toContain('TS2322');
    await expect(fs.access(path.join(fixtureDir, 'dist'))).rejects.toThrow();
  }, 30000);
});
