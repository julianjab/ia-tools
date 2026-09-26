import { describe, expect, it } from 'vitest';
import { Agent } from '../../agent/Agent.js';
import { ProviderRegistry, type ProviderRunContext } from '../../agent/Provider.js';
import { type DomainEvent, createEvent } from '../../events/DomainEvent.js';
import { EventBus } from '../../events/EventBus.js';
import { type IfRunning, Pipeline } from '../../pipeline/Pipeline.js';
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js';
import { Engine, scopeExecutionKey } from '../Engine.js';
import { InMemoryExecutionStore } from '../Execution.js';
import { StaticPipelineSource } from '../PipelineSource.js';

const TASK = { projectId: 'p', repo: 'la-haus/subscriptions', issue: 1640 };
const event = (type: string, payload: Record<string, unknown> = {}, depth = 1): DomainEvent =>
  createEvent(type, payload, { scope: TASK, depth });

/**
 * Un implementer que queda corriendo hasta que el test lo suelta (`release`), y que ANTES de
 * terminar lee su inbox — como el provider real, que lo vacía antes de cada vuelta.
 */
function heldImplementer() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const inbox: string[][] = [];
  const runs: string[] = [];
  const registry = new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx: ProviderRunContext) => {
      runs.push(ctx.ctx.pipelineId);
      started();
      await gate;
      inbox.push(ctx.inbox?.() ?? []);
      return { outcome: 'success' };
    },
  });
  const agent = new Agent({ id: 'implementer', provider: 'fake', prompt: 'p' }, registry);
  return { agent, release, running, inbox, runs };
}

function engineWith(pipelines: Pipeline[], store = new InMemoryExecutionStore()) {
  return {
    store,
    engine: new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource(pipelines),
      executions: store,
      formatMessage: (e) => `${e.type}: ${String((e.payload as { body?: string }).body)}`,
    }),
  };
}

const rule = (id: string, on: string, agent: Agent, ifRunning?: IfRunning) =>
  new Pipeline({ id, on: [on], do: [agent], ...(ifRunning ? { ifRunning } : {}) });

describe('Engine with executions', () => {
  it('injects an event into the running execution of its task instead of starting another', async () => {
    const implementer = heldImplementer();
    const { engine } = engineWith([
      rule('build', 'build', implementer.agent),
      rule('comment-build', 'issue_comment', implementer.agent, 'inject'),
    ]);

    const build = engine.dispatch(event('build'));
    await implementer.running;
    const outcome = await engine.dispatch(event('issue_comment', { body: 'usá el enum' }));
    implementer.release();
    await build;

    expect(outcome).toBe('injected');
    expect(implementer.runs).toEqual(['build']);
    expect(implementer.inbox).toEqual([['issue_comment: usá el enum']]);
  });

  it('with no execution running, the same rule starts one', async () => {
    const implementer = heldImplementer();
    const { engine } = engineWith([
      rule('comment-build', 'issue_comment', implementer.agent, 'inject'),
    ]);
    implementer.release();

    expect(await engine.dispatch(event('issue_comment', { body: 'x' }))).toBe('dispatched');
    expect(implementer.runs).toEqual(['comment-build']);
  });

  it('waits by default: the second run of a task starts after the first finishes', async () => {
    const implementer = heldImplementer();
    const { engine, store } = engineWith([
      rule('build', 'build', implementer.agent),
      rule('ci-red', 'ci', implementer.agent),
    ]);

    const build = engine.dispatch(event('build'));
    await implementer.running;
    const ci = engine.dispatch(event('ci'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.stats.waiting).toBe(1);

    implementer.release();
    await Promise.all([build, ci]);
    expect(implementer.runs).toEqual(['build', 'ci-red']);
  });

  it('skip drops the event while the task is running', async () => {
    const implementer = heldImplementer();
    const { engine } = engineWith([
      rule('build', 'build', implementer.agent),
      rule('noise', 'label', implementer.agent, 'skip'),
    ]);

    const build = engine.dispatch(event('build'));
    await implementer.running;
    expect(await engine.dispatch(event('label'))).toBe('skipped');
    implementer.release();
    await build;
    expect(implementer.runs).toEqual(['build']);
  });

  it('a deeper event, born inside the running execution, does not wait for it', async () => {
    const implementer = heldImplementer();
    const ran: string[] = [];
    const nested = new Pipeline({
      id: 'nested',
      on: ['derived'],
      do: [
        new Agent(
          { id: 'helper', provider: 'fake-helper', prompt: 'p' },
          new ProviderRegistry().register({
            id: 'fake-helper',
            run: async () => {
              ran.push('helper');
              return { outcome: 'success' };
            },
          }),
        ),
      ],
    });
    const { engine } = engineWith([rule('build', 'build', implementer.agent), nested]);

    const build = engine.dispatch(event('build'));
    await implementer.running;
    await engine.dispatch(event('derived', {}, 2));
    expect(ran).toEqual(['helper']);
    implementer.release();
    await build;
  });

  it('leaves pipelines without agents and events without a task untouched', async () => {
    const implementer = heldImplementer();
    const actions: string[] = [];
    const plain = new Pipeline({
      id: 'plain',
      on: ['label'],
      ifRunning: 'skip',
      do: [new FunctionAction({ fn: () => actions.push('plain') })],
    });
    const { engine } = engineWith([
      rule('build', 'build', implementer.agent),
      plain,
      rule('any', 'untracked', implementer.agent, 'skip'),
    ]);

    const build = engine.dispatch(event('build'));
    await implementer.running;
    await engine.dispatch(event('label'));
    expect(actions).toEqual(['plain']);

    implementer.release();
    await build;
    // Sin scope no hay task: corre como siempre, aunque la regla diga `skip`.
    await engine.dispatch(createEvent('untracked', {}, { depth: 1 }));
    expect(implementer.runs).toEqual(['build', 'any']);
  });

  it('marks the execution failed when the pipeline throws, and frees the task', async () => {
    const registry = new ProviderRegistry().register({
      id: 'boom',
      run: async () => {
        throw new Error('se cayó');
      },
    });
    const agent = new Agent({ id: 'implementer', provider: 'boom', prompt: 'p' }, registry);
    const { engine, store } = engineWith([rule('build', 'build', agent)]);

    await expect(engine.dispatch(event('build'))).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.running(scopeExecutionKey(event('build')) as string)).toBeUndefined();
    expect(store.stats).toEqual({ running: 0, waiting: 0 });
  });
});

describe('scopeExecutionKey', () => {
  it('is the same for the same task regardless of key order, and undefined without scope', () => {
    const a = createEvent('x', {}, { scope: { repo: 'r', issue: 1 } });
    const b = createEvent('y', {}, { scope: { issue: 1, repo: 'r' } });
    expect(scopeExecutionKey(a)).toBe(scopeExecutionKey(b));
    expect(scopeExecutionKey(createEvent('z', {}))).toBeUndefined();
  });
});
