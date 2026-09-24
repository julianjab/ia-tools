import { describe, expect, it } from 'vitest';
import { Condition } from '../../condition/Condition.js';
import { createEvent } from '../../events/DomainEvent.js';
import { EventBus } from '../../events/EventBus.js';
import type { PipelineExecutionContext } from '../../pipeline/Runnable.js';
import { Agent } from '../Agent.js';
import { ERROR_EXIT, SUCCESS_EXIT } from '../AgentDefinition.js';
import type { Provider, ProviderRunContext } from '../Provider.js';
import { ProviderRegistry } from '../Provider.js';

function registerFakeProvider(id: string, run: Provider['run']): ProviderRegistry {
  return new ProviderRegistry().register({ id, run });
}

function ctxFor(
  payload: Record<string, unknown> = {},
  steps: Record<string, unknown> = {},
): PipelineExecutionContext {
  return { event: createEvent('t', payload), steps, bus: new EventBus(), pipelineId: 'p1' };
}

describe('Agent', () => {
  it('is a Runnable — inherits id/when/continueOnError from the definition', () => {
    const registry = registerFakeProvider('fake', async () => ({ outcome: SUCCESS_EXIT }));
    const agent = new Agent(
      {
        id: 'x',
        provider: 'fake',
        prompt: 'p',
        when: Condition.fromRows([{ field: 'go', op: 'eq', value: true }]),
        continueOnError: true,
      },
      registry,
    );

    expect(agent.id).toBe('x');
    expect(agent.continueOnError).toBe(true);
    expect(agent.shouldRun(ctxFor({ go: true }))).toBe(true);
    expect(agent.shouldRun(ctxFor({ go: false }))).toBe(false);
  });

  it('throws a clear error when the provider id is not registered', async () => {
    const agent = new Agent(
      { id: 'x', provider: 'does-not-exist', prompt: 'hola' },
      new ProviderRegistry(),
    );
    await expect(agent.run(ctxFor())).rejects.toThrow(/provider desconocido "does-not-exist"/);
  });

  it('interpolates {{path}} in the prompt against the event payload', async () => {
    let receivedPrompt = '';
    const registry = registerFakeProvider('fake', async (ctx) => {
      receivedPrompt = ctx.prompt;
      return { outcome: SUCCESS_EXIT };
    });

    const agent = new Agent(
      { id: 'x', provider: 'fake', prompt: 'Hola {{name}}, tu issue es {{title}}' },
      registry,
    );
    await agent.run(ctxFor({ name: 'Julian', title: 'bug X' }));

    expect(receivedPrompt).toBe('Hola Julian, tu issue es bug X');
  });

  it('interpolates {{variables.x}} against the agent-declared variables', async () => {
    let receivedPrompt = '';
    const registry = registerFakeProvider('fake', async (ctx) => {
      receivedPrompt = ctx.prompt;
      return { outcome: SUCCESS_EXIT };
    });

    const agent = new Agent(
      {
        id: 'x',
        provider: 'fake',
        prompt: 'Repo: {{variables.repo}}',
        variables: { repo: 'julianjab/accountant' },
      },
      registry,
    );
    await agent.run(ctxFor());

    expect(receivedPrompt).toBe('Repo: julianjab/accountant');
  });

  it('an unresolved placeholder is left as-is (fail-open), not thrown', async () => {
    let receivedPrompt = '';
    const registry = registerFakeProvider('fake', async (ctx) => {
      receivedPrompt = ctx.prompt;
      return { outcome: SUCCESS_EXIT };
    });

    const agent = new Agent({ id: 'x', provider: 'fake', prompt: 'Valor: {{typo}}' }, registry);
    await agent.run(ctxFor());

    expect(receivedPrompt).toBe('Valor: {{typo}}');
  });

  it('joins systemPrompts by resolved text, dropping refs with neither text nor a match', async () => {
    let received: string[] = [];
    const registry = registerFakeProvider('fake', async (ctx) => {
      received = ctx.systemPrompts;
      return { outcome: SUCCESS_EXIT };
    });

    const agent = new Agent(
      {
        id: 'x',
        provider: 'fake',
        prompt: 'p',
        systemPrompts: [{ text: 'uno' }, { id: 'no-catalog-here' }, { text: 'dos' }],
      },
      registry,
    );
    await agent.run(ctxFor());

    expect(received).toEqual(['uno', 'dos']);
  });

  it('matches the outcome against exits and returns the resolved exit string', async () => {
    const registry = registerFakeProvider('fake', async () => ({ outcome: 'actionable' }));

    const agent = new Agent(
      {
        id: 'x',
        provider: 'fake',
        prompt: 'p',
        exits: { actionable: 'actionable', 'not-actionable': 'not-actionable' },
      },
      registry,
    );
    const result = (await agent.run(ctxFor())) as { output: unknown; exit?: string };

    expect(result.exit).toBe('actionable');
    expect(result.output).toEqual({ outcome: 'actionable' });
  });

  it('an outcome not declared in exits falls back to the ERROR_EXIT entry', async () => {
    const registry = registerFakeProvider('fake', async () => ({
      outcome: 'something-unexpected',
    }));

    const agent = new Agent(
      {
        id: 'x',
        provider: 'fake',
        prompt: 'p',
        exits: { [SUCCESS_EXIT]: SUCCESS_EXIT, [ERROR_EXIT]: 'failed' },
      },
      registry,
    );
    const result = (await agent.run(ctxFor())) as { exit?: string };

    expect(result.exit).toBe('failed');
  });

  it('cancelled/truncated outcomes resolve to no exit at all (NO_TRANSITION_OUTCOMES)', async () => {
    const registry = registerFakeProvider('fake', async () => ({ outcome: 'cancelled' }));

    const agent = new Agent(
      { id: 'x', provider: 'fake', prompt: 'p', exits: { [ERROR_EXIT]: 'failed' } },
      registry,
    );
    const result = (await agent.run(ctxFor())) as { exit?: string };

    expect(result.exit).toBeUndefined();
  });

  it('passes tools, providerConfig and mcpServers through to the provider untouched', async () => {
    let received: ProviderRunContext | undefined;
    const registry = registerFakeProvider('fake', async (ctx) => {
      received = ctx;
      return { outcome: SUCCESS_EXIT };
    });

    const tool = { name: 't', description: 'd', inputSchema: {}, handler: () => 'x' };
    const agent = new Agent(
      {
        id: 'x',
        provider: 'fake',
        prompt: 'p',
        tools: [tool],
        providerConfig: { model: 'x' },
        mcpServers: [{ id: 'gh', config: { url: 'https://x' } }],
      },
      registry,
    );
    await agent.run(ctxFor());

    expect(received?.tools).toEqual([tool]);
    expect(received?.providerConfig).toEqual({ model: 'x' });
    expect(received?.mcpServers).toEqual([{ id: 'gh', config: { url: 'https://x' } }]);
  });

  it('emitOn publishes a derived event named after the resolved exit', async () => {
    const registry = registerFakeProvider('fake', async () => ({ outcome: 'triaged' }));
    const bus = new EventBus();
    const published: string[] = [];
    bus.subscribe('*', (event) => {
      published.push(event.type);
    });

    const agent = new Agent(
      {
        id: 'triage',
        provider: 'fake',
        prompt: 'p',
        exits: { triaged: 'triaged' },
        emitOn: (exit) => `agent.${exit}`,
      },
      registry,
    );
    await agent.run({ ...ctxFor(), bus });

    expect(published).toEqual(['agent.triaged']);
  });

  it('without emitOn, nothing gets published', async () => {
    const registry = registerFakeProvider('fake', async () => ({ outcome: SUCCESS_EXIT }));
    const bus = new EventBus();
    const publishSpy = { called: false };
    bus.subscribe('*', () => {
      publishSpy.called = true;
    });

    const agent = new Agent({ id: 'x', provider: 'fake', prompt: 'p' }, registry);
    await agent.run({ ...ctxFor(), bus });

    expect(publishSpy.called).toBe(false);
  });

  it('a downstream publish failure propagates and aborts this step (documented coupling)', async () => {
    const registry = registerFakeProvider('fake', async () => ({ outcome: SUCCESS_EXIT }));
    const bus = new EventBus();
    bus.subscribe('derived', () => {
      throw new Error('downstream boom');
    });

    const agent = new Agent(
      { id: 'x', provider: 'fake', prompt: 'p', emitOn: () => 'derived' },
      registry,
    );

    await expect(agent.run({ ...ctxFor(), bus })).rejects.toThrow(AggregateError);
  });
});
