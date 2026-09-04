import { ChildProcess, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';

export type PackageProcessOptions = {
  cwd: string;
  /** the package name — carried on the error so a failure names its package */
  label: string;
  /** prepended to every output line (e.g. `[@scope/name] `) */
  logPrefix: string;
  env?: NodeJS.ProcessEnv;
};

export class PackageProcessError extends Error {
  constructor(
    message: string,
    readonly label: string,
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
    /** the last `PackageProcessRunner.TAIL_BYTES` of combined stdout+stderr */
    readonly tail: string,
    /** true when this runner stopped the process itself (`abort`) — not a failure of the process's own */
    readonly aborted: boolean
  ) {
    super(message);
    // ES5 targets lose the subclass prototype on `super()` — restore it so `instanceof` holds.
    Object.setPrototypeOf(this, PackageProcessError.prototype);
    this.name = 'PackageProcessError';
  }
}

/** One spawned child and the hooks `abort` needs to stop it and settle its `run()` promise. */
type LiveProcess = {
  child: ChildProcess;
  /** resolves on the child's `exit` (the process is gone; its stdio may still be open) */
  exited: Promise<void>;
  settled: boolean;
  /** settle the `run()` promise from the exit status; idempotent */
  settle: (code: number | null, signal: NodeJS.Signals | null) => void;
};

/**
 * Runs a package's npm processes for `build-workspace`: output lines carry the package name,
 * and every child is its own process group so the whole tree it spawns (`npm run build` →
 * `sh -c` → `tsc`) can be stopped as one unit. `abort()` kills every live group — the
 * fail-fast path when another package's build fails — and `forwardSignals()` makes the CLI
 * do the same on SIGINT/SIGTERM/SIGHUP, so a killed `build-workspace` never leaves compilers
 * running behind it (node's own exec timeouts signal only the shell they spawned).
 */
export class PackageProcessRunner {
  static readonly TAIL_BYTES = 64 * 1024;
  /** SIGTERM first; a group still alive after this many ms gets SIGKILL */
  static readonly KILL_GRACE_MS = 5000;
  /**
   * After a killed child has exited, how long to wait for its stdio to close before releasing
   * our ends: pipes still open then are held by something outside the group (a daemon the
   * build left behind) — never a reason to hang the abort.
   */
  static readonly CLOSE_GRACE_MS = 1000;
  private static readonly SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
  };
  private static runners = new Set<PackageProcessRunner>();
  private static forwardingSignals = false;

  private live = new Map<ChildProcess, LiveProcess>();
  private aborting = false;

  constructor(private streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process) {
    PackageProcessRunner.runners.add(this);
  }

  /**
   * CLI entry points call this once: a SIGINT/SIGTERM/SIGHUP to the tool stops every live
   * process group across all runners first, then exits with the conventional 128+signal status.
   */
  static forwardSignals(): void {
    if (PackageProcessRunner.forwardingSignals) {
      return;
    }
    PackageProcessRunner.forwardingSignals = true;
    for (const signal of Object.keys(PackageProcessRunner.SIGNAL_NUMBERS) as NodeJS.Signals[]) {
      process.on(signal, () => {
        const live = Array.from(PackageProcessRunner.runners).reduce((n, runner) => n + runner.live.size, 0);
        process.stderr.write(
          `build-workspace: received ${signal} — stopping ${live} package process group${live !== 1 ? 's' : ''}\n`
        );
        Promise.all(Array.from(PackageProcessRunner.runners).map((runner) => runner.abort())).finally(() => {
          process.exit(128 + (PackageProcessRunner.SIGNAL_NUMBERS[signal] ?? 0));
        });
      });
    }
  }

  /** Resolves on exit 0; rejects with a `PackageProcessError` (tail attached) otherwise. */
  run(command: string, args: readonly string[], options: PackageProcessOptions): Promise<void> {
    const commandLine = `${command} ${args.join(' ')}`;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = this.tailBuffer();
    const stdout = this.linePrefixer(this.streams.stdout, options.logPrefix);
    const stderr = this.linePrefixer(this.streams.stderr, options.logPrefix);
    child.stdout?.on('data', (chunk: Buffer) => {
      tail.push(chunk);
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      tail.push(chunk);
      stderr.push(chunk);
    });
    return new Promise<void>((resolve, reject) => {
      const record: LiveProcess = {
        child,
        exited: new Promise<void>((done) => child.once('exit', () => done())),
        settled: false,
        settle: (code, signal) => {
          if (record.settled) {
            return;
          }
          record.settled = true;
          stdout.flush();
          stderr.flush();
          this.live.delete(child);
          if (code === 0) {
            resolve();
            return;
          }
          const aborted = this.aborting;
          const outcome = aborted
            ? `stopped (workspace build aborted)`
            : signal
              ? `terminated by signal ${signal}`
              : `exited with code ${code}`;
          const message = aborted
            ? `[${options.label}] '${commandLine}' ${outcome}`
            : `[${options.label}] '${commandLine}' ${outcome}\n${PackageProcessRunner.lastLines(tail.text(), 40)}`;
          reject(new PackageProcessError(message, options.label, code, signal, tail.text(), aborted));
        },
      };
      this.live.set(child, record);
      child.once('error', (error) => {
        if (record.settled) {
          return;
        }
        record.settled = true;
        this.live.delete(child);
        reject(
          new PackageProcessError(
            `[${options.label}] failed to spawn '${commandLine}': ${error.message}`,
            options.label,
            null,
            null,
            tail.text(),
            this.aborting
          )
        );
      });
      child.once('close', (code, signal) => record.settle(code, signal));
    });
  }

  /** Stop every live process group (SIGTERM, then SIGKILL after the grace) and wait for them to exit. */
  async abort(): Promise<void> {
    this.aborting = true;
    await Promise.all(Array.from(this.live.values()).map((record) => this.killGroup(record)));
  }

  get aborted(): boolean {
    return this.aborting;
  }

  get liveProcessCount(): number {
    return this.live.size;
  }

  /** Detach from signal forwarding (tests create many runners). */
  dispose(): void {
    PackageProcessRunner.runners.delete(this);
  }

  private async killGroup(record: LiveProcess): Promise<void> {
    const { child } = record;
    if (child.pid === undefined) {
      return;
    }
    const pid = child.pid;
    if (child.exitCode === null && child.signalCode === null) {
      const escalate = setTimeout(
        () => PackageProcessRunner.signalGroup(pid, 'SIGKILL'),
        PackageProcessRunner.KILL_GRACE_MS
      );
      PackageProcessRunner.signalGroup(pid, 'SIGTERM');
      await record.exited;
      clearTimeout(escalate);
    }
    if (record.settled) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PackageProcessRunner.CLOSE_GRACE_MS);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!record.settled) {
      // Exited, stdio still open: an orphan outside the group holds the pipes. Release our ends.
      child.stdout?.destroy();
      child.stderr?.destroy();
      record.settle(child.exitCode, child.signalCode);
    }
  }

  /** Signal the whole process group the child leads; a group already gone is not an error. */
  private static signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch (e: any) {
      if (e.code !== 'ESRCH') {
        throw e;
      }
    }
  }

  /** Whole lines only, each prefixed — interleaved packages stay readable line by line. */
  private linePrefixer(
    stream: NodeJS.WritableStream,
    prefix: string
  ): { push: (chunk: Buffer) => void; flush: () => void } {
    const decoder = new StringDecoder('utf8');
    let rest = '';
    return {
      push: (chunk: Buffer) => {
        rest += decoder.write(chunk);
        let newline = rest.indexOf('\n');
        while (newline >= 0) {
          stream.write(`${prefix}${rest.slice(0, newline + 1)}`);
          rest = rest.slice(newline + 1);
          newline = rest.indexOf('\n');
        }
      },
      flush: () => {
        rest += decoder.end();
        if (rest.length > 0) {
          stream.write(`${prefix}${rest}\n`);
          rest = '';
        }
      },
    };
  }

  private tailBuffer(): { push: (chunk: Buffer) => void; text: () => string } {
    const chunks: Buffer[] = [];
    let length = 0;
    return {
      push: (chunk: Buffer) => {
        chunks.push(chunk);
        length += chunk.length;
        while (length > PackageProcessRunner.TAIL_BYTES && chunks.length > 1) {
          length -= chunks.shift()!.length;
        }
      },
      text: () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        return text.length > PackageProcessRunner.TAIL_BYTES
          ? text.slice(text.length - PackageProcessRunner.TAIL_BYTES)
          : text;
      },
    };
  }

  private static lastLines(text: string, count: number): string {
    const lines = text.trimEnd().split('\n');
    return lines.slice(Math.max(0, lines.length - count)).join('\n');
  }
}
