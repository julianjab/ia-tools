import { describe, expect, it } from 'vitest';
import { createEvent } from '../../../events/DomainEvent.js';
import { EventBus } from '../../../events/EventBus.js';
import type { PipelineExecutionContext } from '../../Runnable.js';
import { FunctionAction } from '../FunctionAction.js';

function makeCtx(): PipelineExecutionContext {
  return {
    event: createEvent('t', { a: 1 }),
    steps: {},
    bus: new EventBus(),
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
