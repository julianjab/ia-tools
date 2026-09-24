import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../../src/agent/AgentRegistry.js';
import { createEvent } from '../../../src/events/DomainEvent.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { FunctionAction } from '../../../src/pipeline/actions/FunctionAction.js';
import type { PipelineExecutionContext } from '../../../src/pipeline/actions/PipelineAction.js';

function makeCtx(): PipelineExecutionContext {
  return {
    event: createEvent('t', { a: 1 }),
    steps: {},
    bus: new EventBus(),
    agents: new AgentRegistry(),
    pipelineId: 'p1',
  };
}

describe('FunctionAction', () => {
  it('runs the given function with the full execution context', async () => {
    let receivedCtx: PipelineExecutionContext | undefined;
    const ctx = makeCtx();

    await new FunctionAction({
      fn: (c) => {
        receivedCtx = c;
        return 'done';
      },
    }).run(ctx);

    expect(receivedCtx).toBe(ctx);
  });

  it('returns whatever the function returns', async () => {
    const result = await new FunctionAction({ fn: () => ({ ok: true }) }).run(makeCtx());
    expect(result).toEqual({ ok: true });
  });

  it('awaits an async function', async () => {
    const result = await new FunctionAction({
      fn: async () => {
        await Promise.resolve();
        return 'async-done';
      },
    }).run(makeCtx());
    expect(result).toBe('async-done');
  });
});
