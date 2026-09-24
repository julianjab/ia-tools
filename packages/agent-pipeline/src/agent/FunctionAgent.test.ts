import { describe, expect, it } from 'vitest';
import { createEvent } from '../events/DomainEvent.js';
import { functionAgent } from './FunctionAgent.js';

describe('functionAgent', () => {
  it('wraps a plain return value as { output, exit: "success" }', async () => {
    const agent = functionAgent('plain', () => 'hello');
    const result = await agent.run({ event: createEvent('t', {}), steps: {} });
    expect(result).toEqual({ output: 'hello', exit: 'success' });
  });

  it('passes through an explicit AgentRunOutput unchanged', async () => {
    const agent = functionAgent('shaped', () => ({ output: { x: 1 }, exit: 'needs_review' }));
    const result = await agent.run({ event: createEvent('t', {}), steps: {} });
    expect(result).toEqual({ output: { x: 1 }, exit: 'needs_review' });
  });

  it('supports an async function', async () => {
    const agent = functionAgent('async', async () => {
      await Promise.resolve();
      return 7;
    });
    const result = await agent.run({ event: createEvent('t', {}), steps: {} });
    expect(result).toEqual({ output: 7, exit: 'success' });
  });

  it('sets the agent id', () => {
    const agent = functionAgent('my-id', () => null);
    expect(agent.id).toBe('my-id');
  });

  it('does not mistake a plain object output for an AgentRunOutput unless it has "output"', async () => {
    const agent = functionAgent<{ label: string }>('object-output', () => ({ label: 'bug' }));
    const result = await agent.run({ event: createEvent('t', {}), steps: {} });
    expect(result).toEqual({ output: { label: 'bug' }, exit: 'success' });
  });

  it('forwards the run input (event/steps/brief) to the function', async () => {
    let received: unknown;
    const agent = functionAgent('capture', (input) => {
      received = input;
      return 'ok';
    });
    const event = createEvent('t', { a: 1 });
    await agent.run({ event, steps: { prev: 'x' }, brief: 'do it' });
    expect(received).toEqual({ event, steps: { prev: 'x' }, brief: 'do it' });
  });
});
