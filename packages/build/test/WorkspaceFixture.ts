import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { Writable } from 'stream';
import { spawnSync } from 'child_process';
import { Logger } from '@proteinjs/logger';
import { PackageProcessRunner } from '../src/PackageProcessRunner';
import { WorkspaceBuilder, WorkspaceBuilderOptions, WorkspaceBuildSummary } from '../src/WorkspaceBuilder';

/**
 * A hermetic workspace for build-workspace tests: a git repo (sources are git-derived) whose
 * packages build with the fixture's own `build.js` — no tsc, no registry. A build writes
 * `dist/index.js` from `src/index.txt` plus its fixture dependencies' dists (read by relative
 * path, so `--no-install` runs never need symlinks) plus a random nonce: a rebuild always
 * changes the dist, a skip never does — the OUTCOME every tripwire asserts on. Every build also
 * appends `<name> start|end|fail <ms> <pid>` to the build log, the record of what ran, in
 * what order, and overlapping what.
 *
 * Env knobs read by build.js: FIXTURE_BUILD_LOG, FIXTURE_BUILD_SLEEP_MS, FIXTURE_BUILD_FAIL
 * (package name that exits 3), FIXTURE_BUILD_HANG (package name that never exits; writes its
 * pid to FIXTURE_PID_DIR/hang.pid).
 */
export class WorkspaceFixture {
  static readonly BUILD_SCRIPT = `
const fs = require('fs');
const path = require('path');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const log = process.env.FIXTURE_BUILD_LOG;
const record = (event) => log && fs.appendFileSync(log, pkg.name + ' ' + event + ' ' + Date.now() + ' ' + process.pid + '\\n');
record('start');
console.log('building ' + pkg.name);
if (process.env.FIXTURE_BUILD_FAIL === pkg.name) {
  console.error('boom from ' + pkg.name);
  record('fail');
  process.exit(3);
}
if (process.env.FIXTURE_BUILD_HANG === pkg.name) {
  fs.writeFileSync(path.join(process.env.FIXTURE_PID_DIR, 'hang.pid'), String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const sleepMs = Number(process.env.FIXTURE_BUILD_SLEEP_MS || 0);
  if (sleepMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
  const src = fs.readFileSync('src/index.txt', 'utf8');
  const deps = {};
  for (const dep of pkg.fixtureDeps || []) deps[dep] = require(path.resolve('..', dep, 'dist', 'index.js'));
  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync('dist/index.js', 'module.exports = ' + JSON.stringify({ name: pkg.name, src, deps, nonce: Math.random() }) + ';');
  record('end');
}
`;

  readonly buildLog: string;
  readonly pidDir: string;
  readonly output: string[] = [];
  private runners: PackageProcessRunner[] = [];

  private constructor(readonly root: string) {
    this.buildLog = path.join(root, '.fixture', 'build.log');
    this.pidDir = path.join(root, '.fixture');
  }

  static async create(): Promise<WorkspaceFixture> {
    // macOS mkdtemp returns /var/... which is a symlink to /private/var — realpath so git and
    // cwd-derived paths agree.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'build-workspace-')));
    const fixture = new WorkspaceFixture(root);
    await fs.mkdir(fixture.pidDir, { recursive: true });
    fixture.git('init', '-q');
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\ndist/\n.fixture/\n');
    await fs.writeFile(path.join(root, 'build.js'), WorkspaceFixture.BUILD_SCRIPT);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }, null, 2));
    return fixture;
  }

  /** `packages/<name>` named `@test/<name>`, depending on the named fixture packages. */
  async addPackage(name: string, options: { deps?: string[]; src?: string; build?: boolean } = {}): Promise<void> {
    const dir = this.packageDir(name);
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    const dependencies: Record<string, string> = {};
    for (const dep of options.deps ?? []) {
      dependencies[`@test/${dep}`] = '1.0.0';
    }
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: `@test/${name}`,
          version: '1.0.0',
          dependencies,
          fixtureDeps: options.deps ?? [],
          // A compound command, like every real build script (`reflection-build && tsc`): npm's
          // `sh -c` must fork and wait, so a signal to the shell alone orphans the running step —
          // only a process-group kill reaches it.
          scripts: options.build === false ? {} : { build: 'node ../../build.js && true' },
        },
        null,
        2
      )
    );
    await fs.writeFile(path.join(dir, 'src', 'index.txt'), options.src ?? `${name} v1`);
  }

  /** A real `npm install` (dependency-free, offline) so the package carries a lockfile and node_modules. */
  async npmInstall(name: string): Promise<void> {
    const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: this.packageDir(name),
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(`fixture npm install failed for ${name}: ${result.stderr}`);
    }
  }

  commit(message = 'fixture'): void {
    this.git('add', '-A');
    this.git('-c', 'user.name=fixture', '-c', 'user.email=fixture@test', 'commit', '-q', '-m', message);
  }

  packageDir(name: string): string {
    return path.join(this.root, 'packages', name);
  }

  async writeSource(name: string, content: string): Promise<void> {
    await fs.writeFile(path.join(this.packageDir(name), 'src', 'index.txt'), content);
  }

  async readDist(name: string): Promise<string | undefined> {
    return fs.readFile(path.join(this.packageDir(name), 'dist', 'index.js'), 'utf-8').catch(() => undefined);
  }

  async readLock(name: string): Promise<string> {
    return fs.readFile(path.join(this.packageDir(name), 'package-lock.json'), 'utf-8');
  }

  async writeLock(name: string, content: string): Promise<void> {
    await fs.writeFile(path.join(this.packageDir(name), 'package-lock.json'), content);
  }

  /** `[name, event, ms, pid]` rows in append order */
  async buildLogRows(): Promise<Array<{ name: string; event: string; at: number; pid: number }>> {
    const text = await fs.readFile(this.buildLog, 'utf-8').catch(() => '');
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, event, at, pid] = line.split(' ');
        return { name, event, at: Number(at), pid: Number(pid) };
      });
  }

  async clearBuildLog(): Promise<void> {
    await fs.rm(this.buildLog, { force: true });
  }

  /** names of packages whose build ran (a `start` row), in start order */
  async builtNames(): Promise<string[]> {
    return (await this.buildLogRows()).filter((row) => row.event === 'start').map((row) => row.name);
  }

  /**
   * Run a WorkspaceBuilder against the fixture with the fixture env knobs applied for the
   * duration; child output is captured (ANSI stripped) into `output`, never printed.
   */
  async run(
    options: Partial<WorkspaceBuilderOptions> = {},
    env: Record<string, string> = {}
  ): Promise<WorkspaceBuildSummary> {
    const fixtureEnv: Record<string, string> = {
      FIXTURE_BUILD_LOG: this.buildLog,
      FIXTURE_PID_DIR: this.pidDir,
      ...env,
    };
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(fixtureEnv)) {
      saved[key] = process.env[key];
      process.env[key] = fixtureEnv[key];
    }
    const capture = new Writable({
      write: (chunk, _encoding, callback) => {
        // eslint-disable-next-line no-control-regex
        this.output.push(chunk.toString().replace(/\x1b\[[0-9;]*m/g, ''));
        callback();
      },
    });
    const runner = options.runner ?? new PackageProcessRunner({ stdout: capture, stderr: capture });
    this.runners.push(runner);
    try {
      return await new WorkspaceBuilder({
        workspacePath: this.root,
        concurrency: 2,
        logger: new Logger({ name: 'test', logLevel: 'error' }),
        ...options,
        runner,
      }).run();
    } finally {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  }

  async destroy(): Promise<void> {
    for (const runner of this.runners) {
      await runner.abort();
      runner.dispose();
    }
    await fs.rm(this.root, { recursive: true, force: true });
  }

  private git(...args: string[]): void {
    const result = spawnSync('git', args, { cwd: this.root, encoding: 'utf-8' });
    if (result.status !== 0) {
      throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`);
    }
  }
}
