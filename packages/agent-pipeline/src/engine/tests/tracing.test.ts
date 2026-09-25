import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../agent/Agent.js';
import { ProviderRegistry } from '../../agent/Provider.js';
import { Condition } from '../../condition/Condition.js';
import { Engine } from '../../engine/Engine.js';
import { StaticPipelineSource } from '../../engine/PipelineSource.js';
import { createEvent } from '../../events/DomainEvent.js';
import { EventBus } from '../../events/EventBus.js';
import { Pipeline } from '../../pipeline/Pipeline.js';
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js';

const spans = new InMemorySpanExporter();
const logRecords = new InMemoryLogRecordExporter();
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }),
  );
  logs.setGlobalLoggerProvider(
    new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logRecords })] }),
  );
});

afterAll(() => {
  trace.disable();
  logs.disable();
  context.disable();
});

beforeEach(() => {
  spans.reset();
  logRecords.reset();
});

const byName = (name: string): ReadableSpan => {
  const span = spans.getFinishedSpans().find((s) => s.name === name);
  if (!span)
    throw new Error(`no hay span "${name}": ${spans.getFinishedSpans().map((s) => s.name)}`);
  return span;
};
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;

/** Un agente que elige `done` y una pipeline que lo rutea a `mark` — el caso de todos los días. */
function refineSetup(provider = async () => ({ outcome: 'success' as const })) {
  const registry = new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx) => {
      await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({});
      return provider();
    },
  });
  const mark = new FunctionAction({ id: 'mark', fn: async () => 'marcado' });
  const refiner = new Agent(
    { id: 'refiner', provider: 'fake', prompt: 'refiná', routes: { done: { to: mark } } },
    registry,
  );
  const refine = new Pipeline({
    id: 'refine',
    on: ['issue.status_changed'],
    when: [new Condition({ field: 'status', op: 'eq', value: 'Refine' })],
    do: [refiner, mark],
  });
  const build = new Pipeline({
    id: 'build',
    on: ['issue.status_changed'],
    when: [new Condition({ field: 'status', op: 'eq', value: 'Build' })],
    do: [new FunctionAction({ id: 'noop', fn: async () => null })],
  });
  const other = new Pipeline({ id: 'other', on: ['issue_comment'], do: [] });
  return new Engine({
    bus: new EventBus(),
    pipelines: new StaticPipelineSource([refine, build, other]),
  });
}

const EVENT = () =>
  createEvent(
    'issue.status_changed',
    { status: 'Refine' },
    { scope: { projectId: 'lahaus', repo: 'la-haus/front', issue: 'la-haus/front#4190' } },
  );

describe('Engine tracing', () => {
  it('hangs everything an event causes from one trace, rooted at the event', async () => {
    await refineSetup().dispatch(EVENT());

    const root = byName('event issue.status_changed');
    const pipeline = byName('pipeline refine');
    const agent = byName('agent refiner');
    const mark = byName('action mark');

    expect(parentOf(root)).toBeUndefined();
    expect(parentOf(pipeline)).toBe(root.spanContext().spanId);
    expect(parentOf(agent)).toBe(pipeline.spanContext().spanId);
    // El destino de una salida cuelga del agente que la eligió.
    expect(parentOf(mark)).toBe(agent.spanContext().spanId);
    const traceIds = new Set(spans.getFinishedSpans().map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  it('stamps the event scope on every span, so any of them filters by project/repo/issue', async () => {
    await refineSetup().dispatch(EVENT());

    for (const span of spans.getFinishedSpans()) {
      expect(span.attributes).toMatchObject({
        'ia.projectId': 'lahaus',
        'ia.repo': 'la-haus/front',
        'ia.issue': 'la-haus/front#4190',
        'ia.event.type': 'issue.status_changed',
      });
    }
    expect(byName('agent refiner').attributes['ia.pipeline.id']).toBe('refine');
    // Lo que corre por la salida de un agente sabe de qué agente viene.
    expect(byName('action mark').attributes).toMatchObject({
      'ia.agent.id': 'refiner',
      'ia.step.id': 'mark',
    });
  });

  it('records the exit the agent chose and why each step ran', async () => {
    await refineSetup().dispatch(EVENT());

    const agent = byName('agent refiner');
    expect(agent.attributes).toMatchObject({
      'ia.step.via': 'do',
      'ia.agent.exit': 'done',
      'ia.agent.outcome': 'success',
      'ia.agent.provider': 'fake',
    });
    expect(agent.events.find((e) => e.name === 'route')?.attributes).toMatchObject({
      'ia.route.exit': 'done',
      'ia.route.targets': ['mark'],
    });
    expect(byName('action mark').attributes).toMatchObject({
      'ia.step.via': 'exit:done',
      'ia.step.output': 'marcado',
    });
  });

  it('explains why each pipeline listening to the event did not run', async () => {
    await refineSetup().dispatch(EVENT());

    const root = byName('event issue.status_changed');
    const matches = root.events.filter((e) => e.name === 'pipeline.match').map((e) => e.attributes);
    expect(matches).toEqual([
      { 'ia.pipeline.id': 'refine', 'ia.pipeline.runs': true },
      {
        'ia.pipeline.id': 'build',
        'ia.pipeline.runs': false,
        'ia.pipeline.skip_reason': 'no cumple: status eq "Build" (vino "Refine")',
      },
    ]);
    expect(root.attributes['ia.pipelines.run']).toEqual(['refine']);
  });

  it('keeps a trace for an event nothing reacts to — "why did nothing happen" is the common question', async () => {
    const outcome = await refineSetup().dispatch(
      createEvent('issue.status_changed', { status: 'Done' }),
    );

    expect(outcome).toBe('skipped');
    const root = byName('event issue.status_changed');
    expect(root.attributes['ia.dispatch.outcome']).toBe('skipped');
    expect(logRecords.getFinishedLogRecords().map((r) => r.body)).toContain(
      'evento "issue.status_changed": ninguna pipeline corre',
    );
  });

  it('marks the failing step as an error even when an onError handles it', async () => {
    const registry = new ProviderRegistry().register({
      id: 'fake',
      run: async () => {
        throw new Error('se cayó la API');
      },
    });
    const blocked = new FunctionAction({ id: 'blocked', fn: async () => 'bloqueado' });
    const agent = new Agent(
      { id: 'refiner', provider: 'fake', prompt: 'x', onError: { to: blocked } },
      registry,
    );
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({ id: 'refine', on: ['e'], do: [agent, blocked] }),
      ]),
    });

    await engine.dispatch(createEvent('e', {}));

    const failed = byName('agent refiner');
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.attributes['ia.step.error_handled']).toBe('onError');
    expect(byName('action blocked').attributes['ia.step.via']).toBe('onError');
    expect(byName('event e').status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('correlates logs with the trace and carries the scope attributes', async () => {
    await refineSetup().dispatch(EVENT());

    const chose = logRecords
      .getFinishedLogRecords()
      .find((r) => r.body === 'agente "refiner" eligió "done" → mark');
    expect(chose?.attributes).toMatchObject({
      'ia.issue': 'la-haus/front#4190',
      'ia.pipeline.id': 'refine',
      'ia.agent.exit': 'done',
    });
    expect(chose?.spanContext?.traceId).toBe(byName('agent refiner').spanContext().traceId);
  });
});
