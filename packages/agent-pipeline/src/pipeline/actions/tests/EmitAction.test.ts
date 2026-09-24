import { describe, expect, it, vi } from 'vitest';
import { createEvent } from '../../../events/DomainEvent.js';
import { EventBus } from '../../../events/EventBus.js';
import type { PipelineExecutionContext } from '../../Runnable.js';
import { EmitAction } from '../EmitAction.js';

function makeCtx(bus = new EventBus()): PipelineExecutionContext {
  return {
    event: createEvent('t', {}, { depth: 1 }),
    steps: {},
    bus,
    pipelineId: 'p1',
  };
}

describe('EmitAction', () => {
  it('publishes a derived event with a fixed payload', async () => {
    const bus = new EventBus();
    const publishSpy = vi.spyOn(bus, 'publish');

    const event = await new EmitAction({ type: 'wait.resumed', payload: { ok: true } }).run(
      makeCtx(bus),
    );

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({ type: 'wait.resumed', payload: { ok: true }, depth: 2 });
  });

  it('defaults to an empty payload when none is given', async () => {
    const event = await new EmitAction({ type: 'x' }).run(makeCtx());
    expect(event).toMatchObject({ type: 'x', payload: {} });
  });

  it('resolves a payload function against the execution context', async () => {
    const ctx = makeCtx();
    ctx.steps.triage = { output: { label: 'bug' } };

    const event = await new EmitAction({
      type: 'triaged',
      payload: (c) => ({ label: (c.steps.triage as { output: { label: string } }).output.label }),
    }).run(ctx);

    expect(event).toMatchObject({ type: 'triaged', payload: { label: 'bug' } });
  });
});
