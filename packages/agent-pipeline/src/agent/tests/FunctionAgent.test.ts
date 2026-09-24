import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events/DomainEvent.js';
import { functionAgent, withExit } from '../FunctionAgent.js';

describe('functionAgent', () => {
  it('wraps a plain return value as { output, exit: "success" }', async () => {
    const agent = functionAgent('plain', () => 'hello');
    const result = await agent.run({ event: createEvent('t', {}), steps: {} });
    expect(result).toEqual({ output: 'hello', exit: 'success' });
  });

  it('passes through an explicit withExit() output unchanged', async () => {
    const agent = functionAgent('shaped', () => withExit({ x: 1 }, 'needs_review'));
    const result = await agent.run({ event: createEvent('t', {}), steps: {} });
    expect(result.output).toEqual({ x: 1 });
    expect(result.exit).toBe('needs_review');
  });

  it('withExit defaults exit to "success"', async () => {
    const agent = functionAgent('shaped', () => withExit('patched'));
    const result = await agent.run({ event: createEvent('t', {}), steps: {} });
    expect(result).toEqual({ output: 'patched', exit: 'success' });
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

  it('does not mistake a plain object output for an AgentRunOutput', async () => {
    const agent = functionAgent<{ label: string }>('object-output', () => ({ label: 'bug' }));
    const result = await agent.run({ event: createEvent('t', {}), steps: {} });
    expect(result).toEqual({ output: { label: 'bug' }, exit: 'success' });
  });

  it('a domain object that happens to have its own "output" key is NOT mistaken for an AgentRunOutput', async () => {
    // Antes de la marca por Symbol, cualquier objeto de dominio con una clave `output`
    // (plausible: `{ output: 'usd', amountCents: 500 }`) se confundía con el AgentRunOutput
    // real y perdía el resto de sus campos. Sin `withExit`, ahora se envuelve tal cual.
    const domainOutput = { output: 'usd', amountCents: 500 };
    const agent = functionAgent<typeof domainOutput>('currency', () => domainOutput);
    const result = await agent.run({ event: createEvent('t', {}), steps: {} });
    expect(result).toEqual({ output: domainOutput, exit: 'success' });
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
