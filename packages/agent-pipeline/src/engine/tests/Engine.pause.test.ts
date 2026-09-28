import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent/Agent.js';
import { ProviderRegistry } from '../../agent/Provider.js';
import { Condition } from '../../condition/Condition.js';
import { type DomainEvent, createEvent } from '../../events/DomainEvent.js';
import { EventBus } from '../../events/EventBus.js';
import { Pipeline } from '../../pipeline/Pipeline.js';
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js';
import { PauseAction } from '../../pipeline/actions/PauseAction.js';
import { Engine, scopeExecutionKey } from '../Engine.js';
import { InMemoryExecutionStore } from '../Execution.js';
import { StaticPipelineSource } from '../PipelineSource.js';

const TASK = { projectId: 'p', issue: 7 };
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK });
const ci = (conclusion: string) => event('check_suite', { conclusion });
const KEY = scopeExecutionKey(event('x')) as string;

/** Un agente que elige `done` siempre. */
function implementer(ran: string[]) {
  return (routes: Record<string, unknown>) =>
    new Agent(
      { id: 'implementer', provider: 'done', prompt: 'p', routes: routes as never },
      new ProviderRegistry().register({
        id: 'done',
        run: async (ctx) => {
          ran.push(`implementer:${ctx.ctx.event.type}`);
          await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({});
          return { outcome: 'success' };
        },
      }),
    );
}

const action = (id: string, ran: string[]) =>
  new FunctionAction({ id, fn: (ctx) => ran.push(`${id}:${ctx.event.type}`) });

/** El gate de CI: el implementer termina, se asegura el PR y espera el CI. Verde → Review. */
function ciGate(options: { timeoutMs?: number; maxConcurrent?: number; extra?: Pipeline[] } = {}) {
  const ran: string[] = [];
  const review = action('review', ran);
  const expiredNote = action('expired-note', ran);
  const waitCi = new PauseAction({
    id: 'wait-ci',
    branches: {
      green: {
        on: ['check_suite'],
        when: [new Condition({ field: 'conclusion', op: 'eq', value: 'success' })],
        to: review,
      },
    },
    ...(options.timeoutMs ? { timeout: { afterMs: options.timeoutMs, to: expiredNote } } : {}),
  });
  const build = new Pipeline({
    id: 'build',
    on: ['build'],
    do: [implementer(ran)({ done: { to: [action('ensure-pr', ran), waitCi] } })],
  });
  // CI rojo no es una rama de la pausa: lo levanta su propia regla, que la reemplaza.
  const ciRed = new Pipeline({
    id: 'ci-red',
    on: ['check_suite'],
    when: [new Condition({ field: 'conclusion', op: 'eq', value: 'failure' })],
    do: [implementer(ran)({ done: { to: action('pushed', ran) } })],
  });
  const store = new InMemoryExecutionStore(
    options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {},
  );
  // Una fuente que se puede romper a mitad del test (`broken.now = true`).
  const broken = { now: false };
  const pipelines = [build, ciRed, ...(options.extra ?? [])];
  const engine = new Engine({
    bus: new EventBus(),
    pipelines: {
      list: () => {
        if (broken.now) throw new Error('no pude leer el roster');
        return pipelines;
      },
    },
    executions: store,
  });
  return { engine, store, ran, broken };
}

describe('Engine with pauses', () => {
  it('pauses where the PauseAction is, frees the task and keeps the execution waiting', async () => {
    const { engine, store, ran } = ciGate();
    expect(await engine.dispatch(event('build'))).toBe('dispatched');

    expect(ran).toEqual(['implementer:build', 'ensure-pr:build']);
    const paused = store.current(KEY);
    expect(paused?.status).toBe('paused');
    expect(paused?.pausedOn?.pauseId).toBe('wait-ci');
    // Una pausa no ocupa la task ni un lugar bajo el tope.
    expect(store.busy(KEY)).toBe(false);
    expect(store.stats).toEqual({ running: 0, waiting: 0, paused: 1 });
  });

  it('an event that matches a branch resumes it: runs the branch and closes', async () => {
    const { engine, store, ran } = ciGate();
    await engine.dispatch(event('build'));
    const execution = store.current(KEY);

    expect(await engine.dispatch(ci('success'))).toBe('resumed');
    expect(ran).toEqual(['implementer:build', 'ensure-pr:build', 'review:check_suite']);
    expect(execution?.status).toBe('done');
    expect(store.current(KEY)).toBeUndefined();
  });

  it('an event that matches no branch goes through the rules; a new run supersedes the pause', async () => {
    const { engine, store, ran } = ciGate();
    await engine.dispatch(event('build'));
    const paused = store.current(KEY);

    expect(await engine.dispatch(ci('failure'))).toBe('dispatched');
    expect(paused?.status).toBe('superseded');
    expect(ran).toEqual([
      'implementer:build',
      'ensure-pr:build',
      'implementer:check_suite',
      'pushed:check_suite',
    ]);
    // Ya no hay nada que el verde pueda reanudar.
    expect(await engine.dispatch(ci('success'))).toBe('skipped');
  });

  it('a pause resumes once: a second matching event finds nothing to wake', async () => {
    const { engine, ran } = ciGate();
    await engine.dispatch(event('build'));
    const [first, second] = await Promise.all([
      engine.dispatch(ci('success')),
      engine.dispatch(ci('success')),
    ]);
    expect([first, second].sort()).toEqual(['resumed', 'skipped']);
    expect(ran.filter((step) => step.startsWith('review'))).toHaveLength(1);
  });

  it('if the rules cannot be read, the pause is not woken and the task stays free', async () => {
    const { engine, store, broken } = ciGate();
    await engine.dispatch(event('build'));
    broken.now = true;

    await expect(engine.dispatch(ci('success'))).rejects.toThrow('no pude leer el roster');
    expect(store.current(KEY)?.status).toBe('paused');
    expect(store.busy(KEY)).toBe(false);

    broken.now = false;
    expect(await engine.dispatch(ci('success'))).toBe('resumed');
  });

  it('a pause is not woken while a run for its task is queued: that run supersedes it', async () => {
    // Otra task ocupa el único lugar; el `ci-red` de ESTA task queda en cola.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const holding = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocker = new Pipeline({
      id: 'blocker',
      on: ['other'],
      do: [
        new Agent(
          { id: 'other', provider: 'held', prompt: 'p' },
          new ProviderRegistry().register({
            id: 'held',
            run: async () => {
              started();
              await held;
              return { outcome: 'success' };
            },
          }),
        ),
      ],
    });
    const { engine, store, ran } = ciGate({ maxConcurrent: 1, extra: [blocker] });
    await engine.dispatch(event('build'));
    const paused = store.current(KEY);

    const other = engine.dispatch(createEvent('other', {}, { scope: { issue: 'otra' } }));
    await holding;
    const red = engine.dispatch(ci('failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.busy(KEY)).toBe(true);

    // El verde llega con el `ci-red` en cola: no la despierta.
    expect(await engine.dispatch(ci('success'))).toBe('skipped');
    engine.tick(Date.now() + 10 * 60 * 60_000);
    release();
    await Promise.all([other, red]);

    expect(paused?.status).toBe('superseded');
    expect(ran).not.toContain('review:check_suite');
    expect(ran.at(-1)).toBe('pushed:check_suite');
  });

  it('an expired pause resumes through its timeout branch on the next tick', async () => {
    const { engine, store, ran } = ciGate({ timeoutMs: 1_000 });
    await engine.dispatch(event('build'));
    const execution = store.current(KEY);

    engine.tick(Date.now());
    expect(execution?.status).toBe('paused');
    engine.tick(Date.now() + 2_000);
    await vi.waitFor(() => expect(execution?.status).toBe('done'));
    expect(ran.at(-1)).toBe('expired-note:execution.expired');
  });

  it('after the branch, the pipeline goes on with the rest of do[]', async () => {
    const ran: string[] = [];
    const pipeline = new Pipeline({
      id: 'steps',
      on: ['start'],
      do: [
        implementer(ran)({ done: { to: action('before', ran) } }),
        new PauseAction({
          id: 'wait',
          branches: { go: { on: ['go'], to: action('branch', ran) } },
        }),
        action('after', ran),
      ],
    });
    const store = new InMemoryExecutionStore();
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([pipeline]),
      executions: store,
    });

    await engine.dispatch(event('start'));
    expect(ran).toEqual(['implementer:start', 'before:start']);
    await engine.dispatch(event('go'));
    expect(ran).toEqual(['implementer:start', 'before:start', 'branch:go', 'after:go']);
  });

  it('a pause needs executions: without them the pipeline fails loudly', async () => {
    const ran: string[] = [];
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({
          id: 'build',
          on: ['build'],
          do: [
            implementer(ran)({
              done: { to: new PauseAction({ id: 'wait', branches: { go: { on: ['go'] } } }) },
            }),
          ],
        }),
      ]),
    });
    await expect(engine.dispatch(event('build'))).rejects.toThrow();
  });
});

describe('PauseAction', () => {
  it('needs a branch or a timeout, and reserves the timeout branch name', () => {
    expect(() => new PauseAction({ id: 'p' })).toThrow(/nunca se reanudaría/);
    expect(() => new PauseAction({ id: 'p', branches: { timeout: { on: ['x'] } } })).toThrow(
      /rama de `timeout`/,
    );
  });

  it('its Pause says which branch an event wakes, and when it expires', async () => {
    const pause = await new PauseAction({
      id: 'p',
      branches: {
        green: {
          on: ['check_suite'],
          when: [new Condition({ field: 'conclusion', op: 'eq', value: 'success' })],
        },
        review: { on: ['pull_request_review'] },
      },
      timeout: { afterMs: 60_000 },
    }).run({} as never);

    expect(pause.match(ci('success'))).toBe('green');
    expect(pause.match(event('pull_request_review'))).toBe('review');
    expect(pause.match(ci('failure'))).toBeUndefined();
    expect(pause.expired(Date.now())).toBe(false);
    expect(pause.expired(Date.now() + 120_000)).toBe(true);
  });
});
