import { describe, expect, it } from 'vitest';
import { Agent } from '../../agent/Agent.js';
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
    expect(store.stats).toEqual({ running: 1, waiting: 0, paused: 0 });

    execution.close('done');
    await tick();
    expect(execution.status).toBe('done');
    expect(store.current('task-1')).toBeUndefined();
    expect(store.busy('task-1')).toBe(false);
    expect(store.stats).toEqual({ running: 0, waiting: 0, paused: 0 });
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

    first.close('failed');
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
    a.close('done');
    expect((await b).key).toBe('task-b');
    expect(store.stats.running).toBe(1);
  });

  it('offers an event to its active step, and hands out each accepted message once', async () => {
    const store = new InMemoryExecutionStore();
    const execution = await store.start({ key: 'task-1', pipelineId: 'build' });
    const comment = createEvent('issue_comment', {});
    const implementer = new Agent({
      id: 'implementer',
      provider: 'fake',
      prompt: 'p',
      injects: [{ on: ['issue_comment'] }],
    });
    const reviewer = new Agent({ id: 'reviewer', provider: 'fake', prompt: 'p' });

    expect(execution.active).toBeUndefined();
    // Sin paso en su loop no hay quién lo lea.
    expect(execution.inject('antes', comment)).toBe(false);
    // Un paso que no acepta ese evento tampoco.
    execution.enter(reviewer);
    expect(execution.inject('otro', comment)).toBe(false);
    execution.leave();

    execution.enter(implementer);
    expect(execution.active).toBe(implementer);
    expect(execution.inject('otro tipo', createEvent('label', {}))).toBe(false);
    expect(execution.inject('primero', comment)).toBe(true);
    expect(execution.inject('segundo', comment)).toBe(true);
    expect(execution.drain()).toEqual(['primero', 'segundo']);
    expect(execution.drain()).toEqual([]);
    expect(execution.takeUnread()).toEqual([]);

    expect(execution.inject('tarde', comment)).toBe(true);
    execution.leave();
    expect(execution.active).toBeUndefined();
    expect(execution.takeUnread()).toEqual([comment]);
    // Se toman una sola vez.
    expect(execution.takeUnread()).toEqual([]);
  });

  it('knows the events born inside it', async () => {
    const execution = await new InMemoryExecutionStore().start({ key: 't', pipelineId: 'p' });
    expect(execution.owns(createEvent('x', {}, { executionId: execution.id }))).toBe(true);
    expect(execution.owns(createEvent('x', {}, { executionId: 'exec-otra' }))).toBe(false);
    expect(execution.owns(createEvent('x', {}))).toBe(false);
  });

  it('runs work as the execution: done on success, failed on a throw — and frees the task', async () => {
    const store = new InMemoryExecutionStore();
    const ok = await store.start({ key: 'task-1', pipelineId: 'build' });
    expect(await ok.run(async () => 'listo')).toBe('listo');
    expect(ok.status).toBe('done');

    const bad = await store.start({ key: 'task-1', pipelineId: 'build' });
    await expect(bad.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(bad.status).toBe('failed');
    await tick();
    expect(store.busy('task-1')).toBe(false);
  });

  it('ignores a second close and rejects a cap below one', async () => {
    const store = new InMemoryExecutionStore();
    const execution = await store.start({ key: 'task-1', pipelineId: 'build' });
    execution.close('done');
    execution.close('failed');
    expect(execution.status).toBe('done');
    expect(() => new InMemoryExecutionStore({ maxConcurrent: 0 })).toThrow(/maxConcurrent/);
  });
});
