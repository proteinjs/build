import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { Writable } from 'stream';
import { PackageProcessError, PackageProcessRunner } from '../src/PackageProcessRunner';

describe('PackageProcessRunner', () => {
  let dir: string;
  let output: string[];
  let runner: PackageProcessRunner;

  const capture = () =>
    new Writable({
      write: (chunk, _encoding, callback) => {
        output.push(chunk.toString());
        callback();
      },
    });

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
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'process-runner-'));
    output = [];
    const stream = capture();
    runner = new PackageProcessRunner({ stdout: stream, stderr: stream });
  });

  afterEach(async () => {
    await runner.abort();
    runner.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('prefixes every output line with the label, including a final partial line', async () => {
    await runner.run('node', ['-e', 'process.stdout.write("one\\ntwo\\nthree"); console.error("err")'], {
      cwd: dir,
      label: '@x/y',
      logPrefix: '[@x/y] ',
    });
    const lines = output
      .join('')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.sort()).toEqual(['[@x/y] err', '[@x/y] one', '[@x/y] three', '[@x/y] two']);
  });

  it('a non-zero exit rejects with the label, code, and the output tail', async () => {
    const run = runner.run('node', ['-e', 'console.log("ctx"); console.error("bad thing"); process.exit(7)'], {
      cwd: dir,
      label: '@x/y',
      logPrefix: '[@x/y] ',
    });
    await expect(run).rejects.toBeInstanceOf(PackageProcessError);
    const error = (await run.then(
      () => undefined,
      (e) => e
    )) as PackageProcessError;
    expect(error.label).toBe('@x/y');
    expect(error.code).toBe(7);
    expect(error.aborted).toBe(false);
    expect(error.tail).toContain('bad thing');
    expect(error.message).toContain("[@x/y] 'node -e");
    expect(error.message).toContain('exited with code 7');
    expect(error.message).toContain('bad thing');
  });

  it('abort kills the whole process group — the grandchild dies with the shell', async () => {
    const pidFile = path.join(dir, 'grandchild.pid');
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const run = runner.run('sh', ['-c', `node -e ${JSON.stringify(grandchild)}`], {
      cwd: dir,
      label: '@x/y',
      logPrefix: '[@x/y] ',
    });
    let pid = NaN;
    for (let i = 0; i < 50 && Number.isNaN(pid); i++) {
      await sleep(100);
      pid = Number(await fs.readFile(pidFile, 'utf-8').catch(() => 'NaN'));
    }
    expect(pidAlive(pid)).toBe(true);
    expect(runner.liveProcessCount).toBe(1);

    await runner.abort();

    const error = (await run.then(
      () => undefined,
      (e) => e
    )) as PackageProcessError;
    expect(error).toBeInstanceOf(PackageProcessError);
    expect(error.aborted).toBe(true);
    expect(error.message).toContain('stopped (workspace build aborted)');
    expect(runner.liveProcessCount).toBe(0);
    for (let i = 0; i < 50 && pidAlive(pid); i++) {
      await sleep(100);
    }
    expect(pidAlive(pid)).toBe(false);
  });
});
