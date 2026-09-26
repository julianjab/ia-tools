import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events/DomainEvent.js';
import { InMemoryExecutionStore } from '../Execution.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('InMemoryExecutionStore', () => {
  it('opens a running execution per task and closes it on finish', async () => {
    const store = new InMemoryExecutionStore();
    const execution = await store.start({ key: 'task-1', pipelineId: 'build' });

    expect(execution.status).toBe('running');
    expect(store.current('task-1')).toBe(execution);
    expect(store.busy('task-1')).toBe(true);
    expect(store.stats).toEqual({ running: 1, waiting: 0 });

    store.finish(execution, 'done');
    await tick();
    expect(execution.status).toBe('done');
    expect(store.current('task-1')).toBeUndefined();
    expect(store.busy('task-1')).toBe(false);
    expect(store.stats).toEqual({ running: 0, waiting: 0 });
  });

  it('marks the task busy in the same tick start is called, before it gets its turn', () => {
    const store = new InMemoryExecutionStore();
    void store.start({ key: 'task-1', pipelineId: 'build' });
    expect(store.busy('task-1')).toBe(true);
    expect(store.current('task-1')).toBeUndefined();
  });

  it('never runs two executions of the same task at once — the second waits for the first', async () => {
    const store = new InMemoryExecutionStore();
    const first = await store.start({ key: 'task-1', pipelineId: 'build' });
    let secondStarted = false;
    const second = store.start({ key: 'task-1', pipelineId: 'ci-red' }).then((execution) => {
      secondStarted = true;
      return execution;
    });

    await tick();
    expect(secondStarted).toBe(false);
    expect(store.stats.waiting).toBe(1);

    store.finish(first, 'failed');
    const started = await second;
    expect(started.pipelineId).toBe('ci-red');
    expect(store.current('task-1')).toBe(started);
  });

  it('runs different tasks in parallel, up to the global cap', async () => {
    const store = new InMemoryExecutionStore({ maxConcurrent: 1 });
    const a = await store.start({ key: 'task-a', pipelineId: 'p' });
    let bStarted = false;
    const b = store.start({ key: 'task-b', pipelineId: 'p' }).then((execution) => {
      bStarted = true;
      return execution;
    });

    await tick();
    expect(bStarted).toBe(false);
    expect(store.busy('task-b')).toBe(true);
    store.finish(a, 'done');
    expect((await b).key).toBe('task-b');
    expect(store.stats.running).toBe(1);
  });

  it('knows which agent is in its loop, and hands out each message once', async () => {
    const store = new InMemoryExecutionStore();
    const execution = await store.start({ key: 'task-1', pipelineId: 'build' });
    const comment = createEvent('issue_comment', {});

    expect(execution.activeAgent).toBeUndefined();
    execution.enter('implementer');
    expect(execution.activeAgent).toBe('implementer');

    execution.deliver('primero', comment, 'comment-build');
    execution.deliver('segundo', comment, 'comment-build');
    expect(execution.drain()).toEqual(['primero', 'segundo']);
    expect(execution.drain()).toEqual([]);
    expect(execution.unread()).toEqual([]);

    execution.deliver('tarde', comment, 'comment-build');
    execution.leave();
    expect(execution.activeAgent).toBeUndefined();
    expect(execution.unread()).toEqual([{ event: comment, pipelineId: 'comment-build' }]);
  });

  it('ignores a second finish and rejects a cap below one', async () => {
    const store = new InMemoryExecutionStore();
    const execution = await store.start({ key: 'task-1', pipelineId: 'build' });
    store.finish(execution, 'done');
    store.finish(execution, 'failed');
    expect(execution.status).toBe('done');
    expect(() => new InMemoryExecutionStore({ maxConcurrent: 0 })).toThrow(/maxConcurrent/);
  });
});
