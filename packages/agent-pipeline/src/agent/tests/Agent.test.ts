import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events/DomainEvent.js';
import type { Agent, AgentRunInput } from '../Agent.js';

describe('Agent contract', () => {
  it('a conforming implementation receives steps/brief and returns output+exit', async () => {
    const echoAgent: Agent<string> = {
      id: 'echo',
      async run(input: AgentRunInput) {
        return { output: `${input.brief ?? ''}:${JSON.stringify(input.steps)}`, exit: 'success' };
      },
    };

    const result = await echoAgent.run({
      event: createEvent('test.event', { a: 1 }),
      steps: { prev: { output: 'x' } },
      brief: 'hola',
    });

    expect(result).toEqual({ output: 'hola:{"prev":{"output":"x"}}', exit: 'success' });
  });

  it('exit is optional on the returned output', async () => {
    const agent: Agent<number> = {
      id: 'no-exit',
      async run() {
        return { output: 42 };
      },
    };

    const result = await agent.run({ event: createEvent('t', {}), steps: {} });
    expect(result.output).toBe(42);
    expect(result.exit).toBeUndefined();
  });
});
