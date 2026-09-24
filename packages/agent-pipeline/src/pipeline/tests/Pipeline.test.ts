import { describe, expect, it } from 'vitest';
import { Agent } from '../../agent/Agent.js';
import { ProviderRegistry } from '../../agent/Provider.js';
import { Condition } from '../../condition/Condition.js';
import { createEvent } from '../../events/DomainEvent.js';
import { EventBus } from '../../events/EventBus.js';
import { Pipeline, isAgent } from '../Pipeline.js';
import { FunctionAction } from '../actions/FunctionAction.js';

function fakeRegistry(outcome = 'success', summary = 'a-out') {
  return new ProviderRegistry().register({
    id: 'fake',
    run: async () => ({ outcome, summary }),
  });
}

describe('Pipeline.matches', () => {
  it('requires enabled', () => {
    const pipeline = new Pipeline({ id: 'p', on: ['a'], enabled: false, do: [] });
    expect(pipeline.matches(createEvent('a', {}))).toBe(false);
  });

  it('requires the event type to be in `on`', () => {
    const pipeline = new Pipeline({ id: 'p', on: ['a'], do: [] });
    expect(pipeline.matches(createEvent('b', {}))).toBe(false);
    expect(pipeline.matches(createEvent('a', {}))).toBe(true);
  });

  it('narrows by scope — every declared key must match exactly', () => {
    const pipeline = new Pipeline({ id: 'p', on: ['a'], scope: { channel: 'C1' }, do: [] });
    expect(pipeline.matches(createEvent('a', {}, { scope: { channel: 'C1' } }))).toBe(true);
    expect(pipeline.matches(createEvent('a', {}, { scope: { channel: 'C2' } }))).toBe(false);
    expect(pipeline.matches(createEvent('a', {}))).toBe(false);
  });

  it('with no scope declared, any event scope matches', () => {
    const pipeline = new Pipeline({ id: 'p', on: ['a'], do: [] });
    expect(pipeline.matches(createEvent('a', {}, { scope: { channel: 'C1' } }))).toBe(true);
  });

  it('evaluates `when` against the event payload', () => {
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      when: Condition.fromRows([{ field: 'urgent', op: 'eq', value: true }]),
      do: [],
    });
    expect(pipeline.matches(createEvent('a', { urgent: true }))).toBe(true);
    expect(pipeline.matches(createEvent('a', { urgent: false }))).toBe(false);
  });
});

describe('Pipeline.execute', () => {
  function ctxFor(pipeline: Pipeline, payload: Record<string, unknown> = {}) {
    return {
      event: createEvent('a', payload),
      steps: {},
      bus: new EventBus(),
      pipelineId: pipeline.id,
    };
  }

  it('accumulates named step outputs into ctx.steps', async () => {
    const registry = fakeRegistry();
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new Agent(
          { id: 'first', provider: 'fake', prompt: 'p', exits: { success: 'success' } },
          registry,
        ),
        new FunctionAction({ id: 'second', fn: (ctx) => ctx.steps.first }),
      ],
    });

    const steps = await pipeline.execute(ctxFor(pipeline));

    expect(steps.first).toEqual({
      output: { outcome: 'success', summary: 'a-out' },
      exit: 'success',
    });
    expect(steps.second).toEqual(steps.first);
  });

  it('sets ctx.pipelineId to its own id, overriding whatever was passed in', async () => {
    const pipeline = new Pipeline({
      id: 'real-id',
      on: ['a'],
      do: [new FunctionAction({ id: 'capture', fn: (ctx) => ctx.pipelineId })],
    });
    const steps = await pipeline.execute(ctxFor(pipeline));
    expect(steps.capture).toBe('real-id');
  });

  it('skips a step without recording it in ctx.steps', async () => {
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          id: 'skipped',
          when: Condition.fromRows([{ field: 'go', op: 'eq', value: true }]),
          fn: () => 'should-not-run',
        }),
      ],
    });
    const steps = await pipeline.execute(ctxFor(pipeline, { go: false }));
    expect(steps.skipped).toBeUndefined();
  });

  it('an unnamed step (no id) runs but leaves no trace in ctx.steps', async () => {
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
    const steps = await pipeline.execute(ctxFor(pipeline));
    expect(ran).toBe(true);
    expect(Object.keys(steps)).toHaveLength(0);
  });

  it('a throwing step aborts the pipeline by default', async () => {
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          id: 'boom',
          fn: () => {
            throw new Error('kaboom');
          },
        }),
        new FunctionAction({ id: 'never', fn: () => 'unreachable' }),
      ],
    });
    await expect(pipeline.execute(ctxFor(pipeline))).rejects.toThrow('kaboom');
  });

  it('continueOnError lets the pipeline proceed past a throwing step', async () => {
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          id: 'boom',
          continueOnError: true,
          fn: () => {
            throw new Error('kaboom');
          },
        }),
        new FunctionAction({ id: 'after', fn: () => 'still-runs' }),
      ],
    });
    const steps = await pipeline.execute(ctxFor(pipeline));
    expect(steps.boom).toBeUndefined();
    expect(steps.after).toBe('still-runs');
  });
});

describe('isAgent', () => {
  it('narrows a Runnable to Agent', () => {
    const agent = new Agent({ id: 'x', provider: 'fake', prompt: 'p' }, fakeRegistry());
    const functionAction = new FunctionAction({ fn: () => undefined });
    expect(isAgent(agent)).toBe(true);
    expect(isAgent(functionAction)).toBe(false);
  });
});
