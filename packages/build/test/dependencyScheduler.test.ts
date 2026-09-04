import { DependencyScheduler, ScheduledTask } from '../src/DependencyScheduler';

describe('DependencyScheduler', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Tasks that record start/end and the in-flight high-water mark. */
  const instrument = () => {
    const events: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const task = (
      id: string,
      dependsOn: string[],
      options: { ms?: number; fail?: boolean; priority?: number } = {}
    ): ScheduledTask => ({
      id,
      dependsOn,
      priority: options.priority,
      run: async () => {
        events.push(`start ${id}`);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(options.ms ?? 20);
        inFlight--;
        events.push(`end ${id}`);
        if (options.fail) {
          throw new Error(`${id} failed`);
        }
      },
    });
    return { events, task, peak: () => peak };
  };

  it('starts a task only after its dependencies completed, and never exceeds the bound', async () => {
    const { events, task, peak } = instrument();
    await new DependencyScheduler({ concurrency: 2 }).run([
      task('a', []),
      task('b', ['a']),
      task('c', ['b']),
      task('d', []),
      task('e', []),
    ]);
    expect(events.indexOf('end a')).toBeLessThan(events.indexOf('start b'));
    expect(events.indexOf('end b')).toBeLessThan(events.indexOf('start c'));
    expect(peak()).toBe(2);
    expect(events.filter((e) => e.startsWith('end')).length).toBe(5);
  });

  it('prefers lower priority among ready tasks, then declaration order', async () => {
    const { events, task } = instrument();
    await new DependencyScheduler({ concurrency: 1 }).run([
      task('install-x', [], { priority: 1 }),
      task('build-y', [], { priority: 0 }),
      task('install-z', [], { priority: 1 }),
    ]);
    expect(events.filter((e) => e.startsWith('start'))).toEqual([
      'start build-y',
      'start install-x',
      'start install-z',
    ]);
  });

  it('the first failure stops the graph: onFailure once, nothing new starts, in-flight awaited, first error thrown', async () => {
    const { events, task } = instrument();
    const failures: string[] = [];
    const scheduler = new DependencyScheduler({
      concurrency: 2,
      onFailure: async (failure) => {
        failures.push(failure.id);
      },
    });
    await expect(
      scheduler.run([
        task('a', [], { ms: 10, fail: true }),
        task('slow', [], { ms: 150 }),
        task('b', ['a']),
        task('c', []),
        task('d', [], { fail: true }),
      ])
    ).rejects.toThrow('a failed');
    expect(failures).toEqual(['a']);
    // slow was in flight when a failed and was awaited to its end; nothing else ever started.
    expect(events).toContain('end slow');
    expect(events.filter((e) => e.startsWith('start')).sort()).toEqual(['start a', 'start slow']);
  });

  it('rejects unknown dependencies, duplicate ids, cycles, and a bad bound', async () => {
    const { task } = instrument();
    await expect(new DependencyScheduler({ concurrency: 1 }).run([task('a', ['ghost'])])).rejects.toThrow(
      /unknown task ghost/
    );
    await expect(new DependencyScheduler({ concurrency: 1 }).run([task('a', []), task('a', [])])).rejects.toThrow(
      /duplicate task id a/
    );
    await expect(new DependencyScheduler({ concurrency: 1 }).run([task('a', ['b']), task('b', ['a'])])).rejects.toThrow(
      /no runnable task/
    );
    expect(() => new DependencyScheduler({ concurrency: 0 })).toThrow(/positive integer/);
  });
});
