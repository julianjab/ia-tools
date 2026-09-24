import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../agent/AgentRegistry.js';
import { functionAgent } from '../agent/FunctionAgent.js';
import { Condition } from '../condition/Condition.js';
import { createEvent } from '../events/DomainEvent.js';
import { EventBus } from '../events/EventBus.js';
import { Pipeline } from '../pipeline/Pipeline.js';
import { AgentAction } from '../pipeline/actions/AgentAction.js';
import { EmitAction } from '../pipeline/actions/EmitAction.js';
import { FunctionAction } from '../pipeline/actions/FunctionAction.js';
import { DEFAULT_MAX_EVENT_DEPTH, Engine } from './Engine.js';
import { StaticPipelineSource } from './PipelineSource.js';

describe('Engine.dispatch', () => {
  it('returns "skipped" when no pipeline matches the event type', async () => {
    const engine = new Engine({
      bus: new EventBus(),
      agents: new AgentRegistry(),
      pipelines: new StaticPipelineSource([new Pipeline({ id: 'p', on: ['other'], do: [] })]),
    });
    expect(await engine.dispatch(createEvent('a', {}))).toBe('skipped');
  });

  it('returns "skipped" once the event is at or past maxEventDepth', async () => {
    const engine = new Engine({
      bus: new EventBus(),
      agents: new AgentRegistry(),
      pipelines: new StaticPipelineSource([new Pipeline({ id: 'p', on: ['a'], do: [] })]),
      maxEventDepth: 2,
    });
    expect(await engine.dispatch(createEvent('a', {}, { depth: 2 }))).toBe('skipped');
  });

  it('defaults maxEventDepth to DEFAULT_MAX_EVENT_DEPTH', async () => {
    const engine = new Engine({
      bus: new EventBus(),
      agents: new AgentRegistry(),
      pipelines: new StaticPipelineSource([new Pipeline({ id: 'p', on: ['a'], do: [] })]),
    });
    expect(await engine.dispatch(createEvent('a', {}, { depth: DEFAULT_MAX_EVENT_DEPTH }))).toBe(
      'skipped',
    );
  });

  it('dispatches a matching pipeline and chains steps through ctx.steps', async () => {
    const agents = new AgentRegistry()
      .register(
        functionAgent('triage', (input) => ({
          output: { actionable: (input.event.payload as { title: string }).title.includes('bug') },
          exit: 'success',
        })),
      )
      .register(functionAgent('fix', () => ({ output: 'patched', exit: 'success' })));

    const seen: unknown[] = [];
    const pipeline = new Pipeline({
      id: 'github-triage',
      on: ['github.issue.opened'],
      do: [
        new AgentAction({ id: 'triage', agentId: 'triage' }),
        new AgentAction({
          id: 'fix',
          agentId: 'fix',
          when: Condition.fromRows([
            { field: 'steps.triage.output.actionable', op: 'eq', value: true },
          ]),
        }),
        new FunctionAction({ fn: (ctx) => seen.push(ctx.steps.fix) }),
      ],
    });

    const engine = new Engine({
      bus: new EventBus(),
      agents,
      pipelines: new StaticPipelineSource([pipeline]),
    });
    const outcome = await engine.dispatch(createEvent('github.issue.opened', { title: 'fix bug' }));

    expect(outcome).toBe('dispatched');
    expect(seen).toEqual([{ output: 'patched', exit: 'success' }]);
  });

  it('skips a step whose when does not match, and does not run its agent', async () => {
    const agents = new AgentRegistry();
    let ran = false;
    agents.register(
      functionAgent('fix', () => {
        ran = true;
        return 'patched';
      }),
    );

    const pipeline = new Pipeline({
      id: 'github-triage',
      on: ['github.issue.opened'],
      do: [
        new AgentAction({
          id: 'fix',
          agentId: 'fix',
          when: Condition.fromRows([{ field: 'actionable', op: 'eq', value: true }]),
        }),
      ],
    });

    const engine = new Engine({
      bus: new EventBus(),
      agents,
      pipelines: new StaticPipelineSource([pipeline]),
    });
    await engine.dispatch(createEvent('github.issue.opened', { actionable: false }));

    expect(ran).toBe(false);
  });

  it('runs all matching non-exclusive pipelines in parallel', async () => {
    const ranPipelines: string[] = [];
    const p1 = new Pipeline({
      id: 'p1',
      on: ['a'],
      do: [new FunctionAction({ fn: () => ranPipelines.push('p1') })],
    });
    const p2 = new Pipeline({
      id: 'p2',
      on: ['a'],
      do: [new FunctionAction({ fn: () => ranPipelines.push('p2') })],
    });

    const engine = new Engine({
      bus: new EventBus(),
      agents: new AgentRegistry(),
      pipelines: new StaticPipelineSource([p1, p2]),
    });
    await engine.dispatch(createEvent('a', {}));

    expect(ranPipelines.sort()).toEqual(['p1', 'p2']);
  });

  it('an exclusive pipeline runs alone, chosen by lowest position, and suppresses non-exclusive matches', async () => {
    const ranPipelines: string[] = [];
    const low = new Pipeline({
      id: 'low',
      on: ['x'],
      exclusive: true,
      position: 10,
      do: [new FunctionAction({ fn: () => ranPipelines.push('low') })],
    });
    const high = new Pipeline({
      id: 'high',
      on: ['x'],
      exclusive: true,
      position: 0,
      do: [new FunctionAction({ fn: () => ranPipelines.push('high') })],
    });
    const nonExclusive = new Pipeline({
      id: 'non-exclusive',
      on: ['x'],
      do: [new FunctionAction({ fn: () => ranPipelines.push('non-exclusive') })],
    });

    const engine = new Engine({
      bus: new EventBus(),
      agents: new AgentRegistry(),
      pipelines: new StaticPipelineSource([low, high, nonExclusive]),
    });
    await engine.dispatch(createEvent('x', {}));

    expect(ranPipelines).toEqual(['high']);
  });

  it('start() subscribes to the bus so a plain publish triggers a dispatch', async () => {
    const bus = new EventBus();
    let ran = false;
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          fn: () => {
            ran = true;
          },
        }),
      ],
    });
    const engine = new Engine({
      bus,
      agents: new AgentRegistry(),
      pipelines: new StaticPipelineSource([pipeline]),
    });

    const stop = engine.start();
    await bus.publish(createEvent('a', {}));
    stop();

    expect(ran).toBe(true);
  });

  it('stops a self-emitting pipeline once maxEventDepth is hit', async () => {
    const bus = new EventBus();
    let pingCount = 0;
    bus.subscribe('ping', () => {
      pingCount++;
    });

    // Un pipeline que se re-emite a sí mismo (EmitAction 'ping' sobre on: ['ping']) es
    // exactamente el ciclo sin fondo que maxEventDepth existe para cortar.
    const pipeline = new Pipeline({
      id: 'loop',
      on: ['ping'],
      do: [new EmitAction({ type: 'ping' })],
    });
    const engine = new Engine({
      bus,
      agents: new AgentRegistry(),
      pipelines: new StaticPipelineSource([pipeline]),
      maxEventDepth: 3,
    });
    const stop = engine.start();

    await bus.publish(createEvent('ping', {}));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    // depth 0 (inicial) + 3 derivados (depth 1,2,3) llegan a publish; el dispatch en
    // depth 3 ve `depth >= maxEventDepth` y no deriva un cuarto — la cadena no es infinita.
    expect(pingCount).toBe(4);
  });

  it('start() returns an unsubscribe that stops future dispatches', async () => {
    const bus = new EventBus();
    let calls = 0;
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          fn: () => {
            calls++;
          },
        }),
      ],
    });
    const engine = new Engine({
      bus,
      agents: new AgentRegistry(),
      pipelines: new StaticPipelineSource([pipeline]),
    });

    const stop = engine.start();
    stop();
    await bus.publish(createEvent('a', {}));

    expect(calls).toBe(0);
  });
});
