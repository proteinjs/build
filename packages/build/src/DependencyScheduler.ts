export type ScheduledTask = {
  id: string;
  /** ids that must have completed before this task starts */
  dependsOn: readonly string[];
  /** lower runs first among ready tasks (default 0); ties keep declaration order */
  priority?: number;
  run: () => Promise<void>;
};

export type SchedulerFailure = { id: string; error: unknown };

/**
 * Runs a dependency graph of tasks with at most `concurrency` in flight. A task starts only once
 * everything it depends on has completed; among ready tasks, priority then declaration order.
 * The first failure stops the graph: nothing new starts, `onFailure` runs once (the builder
 * kills its live process groups there), the tasks still in flight are awaited, and the first
 * error is thrown. Later failures (siblings stopped by the abort) are never surfaced over it.
 */
export class DependencyScheduler {
  constructor(private options: { concurrency: number; onFailure?: (failure: SchedulerFailure) => Promise<void> }) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error(`DependencyScheduler: concurrency must be a positive integer, got ${options.concurrency}`);
    }
  }

  async run(tasks: readonly ScheduledTask[]): Promise<void> {
    const byId = new Map<string, ScheduledTask>();
    const declarationOrder = new Map<string, number>();
    tasks.forEach((task, index) => {
      if (byId.has(task.id)) {
        throw new Error(`DependencyScheduler: duplicate task id ${task.id}`);
      }
      byId.set(task.id, task);
      declarationOrder.set(task.id, index);
    });
    for (const task of tasks) {
      for (const dependency of task.dependsOn) {
        if (!byId.has(dependency)) {
          throw new Error(`DependencyScheduler: task ${task.id} depends on unknown task ${dependency}`);
        }
      }
    }

    const pending = new Set(byId.keys());
    const done = new Set<string>();
    const running = new Map<string, Promise<{ id: string; error?: unknown; failed: boolean }>>();
    let failure: SchedulerFailure | undefined;
    while (pending.size > 0 || running.size > 0) {
      if (!failure) {
        const ready = Array.from(pending)
          .filter((id) => byId.get(id)!.dependsOn.every((dependency) => done.has(dependency)))
          .sort(
            (a, b) =>
              (byId.get(a)!.priority ?? 0) - (byId.get(b)!.priority ?? 0) ||
              declarationOrder.get(a)! - declarationOrder.get(b)!
          );
        while (running.size < this.options.concurrency && ready.length > 0) {
          const id = ready.shift()!;
          pending.delete(id);
          running.set(
            id,
            byId
              .get(id)!
              .run()
              .then(
                () => ({ id, failed: false }),
                (error) => ({ id, error, failed: true })
              )
          );
        }
        if (running.size === 0) {
          throw new Error(
            `DependencyScheduler: no runnable task — ${Array.from(pending)
              .map(
                (id) =>
                  `${id} waits on ${byId
                    .get(id)!
                    .dependsOn.filter((d) => !done.has(d))
                    .join(', ')}`
              )
              .join('; ')}`
          );
        }
      } else if (running.size === 0) {
        break;
      }
      const settled = await Promise.race(running.values());
      running.delete(settled.id);
      if (!settled.failed) {
        done.add(settled.id);
        continue;
      }
      if (!failure) {
        failure = { id: settled.id, error: settled.error };
        if (this.options.onFailure) {
          await this.options.onFailure(failure);
        }
      }
    }
    if (failure) {
      throw failure.error;
    }
  }
}
