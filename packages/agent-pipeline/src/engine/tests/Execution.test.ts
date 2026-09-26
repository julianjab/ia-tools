import { describe, expect, it } from 'vitest';
import { InMemoryExecutionStore } from '../Execution.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('InMemoryExecutionStore', () => {
  it('opens a running execution per task and closes it on finish', async () => {
    const store = new InMemoryExecutionStore();
    const execution = await store.start({ key: 'task-1', pipelineId: 'build', depth: 1 });

    expect(execution.status).toBe('running');
    expect(store.running('task-1')).toBe(execution);
    expect(store.stats).toEqual({ running: 1, waiting: 0 });

    store.finish(execution, 'done');
    await tick();
    expect(execution.status).toBe('done');
    expect(store.running('task-1')).toBeUndefined();
    expect(store.stats).toEqual({ running: 0, waiting: 0 });
  });

  it('never runs two executions of the same task at once — the second waits for the first', async () => {
    const store = new InMemoryExecutionStore();
    const first = await store.start({ key: 'task-1', pipelineId: 'build', depth: 1 });
    let secondStarted = false;
    const second = store
      .start({ key: 'task-1', pipelineId: 'ci-red', depth: 1 })
      .then((execution) => {
        secondStarted = true;
        return execution;
      });

    await tick();
    expect(secondStarted).toBe(false);
    expect(store.stats.waiting).toBe(1);

    store.finish(first, 'failed');
    const started = await second;
    expect(started.pipelineId).toBe('ci-red');
    expect(store.running('task-1')).toBe(started);
  });

  it('runs different tasks in parallel, up to the global cap', async () => {
    const store = new InMemoryExecutionStore({ maxConcurrent: 1 });
    const a = await store.start({ key: 'task-a', pipelineId: 'p', depth: 1 });
    let bStarted = false;
    const b = store.start({ key: 'task-b', pipelineId: 'p', depth: 1 }).then((execution) => {
      bStarted = true;
      return execution;
    });

    await tick();
    expect(bStarted).toBe(false);
    store.finish(a, 'done');
    expect((await b).key).toBe('task-b');
    expect(store.stats.running).toBe(1);
  });

  it('delivers messages in order and drains them once', async () => {
    const store = new InMemoryExecutionStore();
    const execution = await store.start({ key: 'task-1', pipelineId: 'build', depth: 1 });

    execution.deliver('primero');
    execution.deliver('segundo');
    expect(execution.drain()).toEqual(['primero', 'segundo']);
    expect(execution.drain()).toEqual([]);
  });

  it('ignores a second finish and rejects a cap below one', async () => {
    const store = new InMemoryExecutionStore();
    const execution = await store.start({ key: 'task-1', pipelineId: 'build', depth: 1 });
    store.finish(execution, 'done');
    store.finish(execution, 'failed');
    expect(execution.status).toBe('done');
    expect(() => new InMemoryExecutionStore({ maxConcurrent: 0 })).toThrow(/maxConcurrent/);
  });
});
