import { afterEach, describe, expect, it } from 'vitest';
import { createEvent } from '../../src/index.js';
import {
  ERROR_EXIT,
  type Provider,
  type ProviderRunContext,
  SUCCESS_EXIT,
  agent,
  exitSet,
  providerRegistry,
} from '../agent.js';

function registerFakeProvider(id: string, run: Provider['run']): Provider {
  const provider: Provider = { id, run };
  providerRegistry.register(provider);
  return provider;
}

describe('exitSet', () => {
  it('returns undefined for undefined', () => {
    expect(exitSet(undefined)).toBeUndefined();
  });

  it('returns a short-form exit as-is', () => {
    expect(exitSet('actionable')).toBe('actionable');
  });

  it('reads `set` off a long-form exit', () => {
    expect(exitSet({ set: 'review', comment: 'pr' })).toBe('review');
  });
});

describe('agent()', () => {
  afterEach(() => {
    // El registry es un singleton module-level — lo dejamos limpio entre tests para que no
    // se pisen entre sí (cada test registra su propio provider fake con id único igual, pero
    // por prolijidad).
  });

  it('throws a clear error when the provider id is not registered', async () => {
    const a = agent({ id: 'x', provider: 'does-not-exist', prompt: 'hola' });
    await expect(a.run({ event: createEvent('t', {}), steps: {} })).rejects.toThrow(
      /provider desconocido "does-not-exist"/,
    );
  });

  it('interpolates {{path}} in the prompt against the event payload', async () => {
    let receivedPrompt = '';
    registerFakeProvider('fake-1', async (ctx) => {
      receivedPrompt = ctx.prompt;
      return { outcome: SUCCESS_EXIT };
    });

    const a = agent({
      id: 'x',
      provider: 'fake-1',
      prompt: 'Hola {{name}}, tu issue es {{title}}',
    });
    await a.run({ event: createEvent('t', { name: 'Julian', title: 'bug X' }), steps: {} });

    expect(receivedPrompt).toBe('Hola Julian, tu issue es bug X');
  });

  it('interpolates {{variables.x}} against the agent-declared variables', async () => {
    let receivedPrompt = '';
    registerFakeProvider('fake-2', async (ctx) => {
      receivedPrompt = ctx.prompt;
      return { outcome: SUCCESS_EXIT };
    });

    const a = agent({
      id: 'x',
      provider: 'fake-2',
      prompt: 'Repo: {{variables.repo}}',
      variables: { repo: 'julianjab/accountant' },
    });
    await a.run({ event: createEvent('t', {}), steps: {} });

    expect(receivedPrompt).toBe('Repo: julianjab/accountant');
  });

  it('an unresolved placeholder is left as-is (fail-open), not thrown', async () => {
    let receivedPrompt = '';
    registerFakeProvider('fake-3', async (ctx) => {
      receivedPrompt = ctx.prompt;
      return { outcome: SUCCESS_EXIT };
    });

    const a = agent({ id: 'x', provider: 'fake-3', prompt: 'Valor: {{typo}}' });
    await a.run({ event: createEvent('t', {}), steps: {} });

    expect(receivedPrompt).toBe('Valor: {{typo}}');
  });

  it('prepends the interpolated brief before the prompt when the step passes one', async () => {
    let receivedPrompt = '';
    registerFakeProvider('fake-4', async (ctx) => {
      receivedPrompt = ctx.prompt;
      return { outcome: SUCCESS_EXIT };
    });

    const a = agent({ id: 'x', provider: 'fake-4', prompt: 'prompt base' });
    await a.run({ event: createEvent('t', {}), steps: {} });
    expect(receivedPrompt).toBe('prompt base');

    await a.run({
      event: createEvent('t', { urgency: 'alta' }),
      steps: {},
      brief: 'Contexto: {{urgency}}',
    });
    expect(receivedPrompt).toBe('Contexto: alta\n\nprompt base');
  });

  it('joins systemPrompts by resolved text, dropping refs with neither text nor a match', async () => {
    let received: string[] = [];
    registerFakeProvider('fake-5', async (ctx) => {
      received = ctx.systemPrompts;
      return { outcome: SUCCESS_EXIT };
    });

    const a = agent({
      id: 'x',
      provider: 'fake-5',
      prompt: 'p',
      systemPrompts: [{ text: 'uno' }, { id: 'no-catalog-here' }, { text: 'dos' }],
    });
    await a.run({ event: createEvent('t', {}), steps: {} });

    expect(received).toEqual(['uno', 'dos']);
  });

  it('matches the outcome against exits and returns the resolved exit string', async () => {
    registerFakeProvider('fake-6', async () => ({ outcome: 'actionable' }));

    const a = agent({
      id: 'x',
      provider: 'fake-6',
      prompt: 'p',
      exits: { actionable: 'actionable', 'not-actionable': 'not-actionable' },
    });
    const result = await a.run({ event: createEvent('t', {}), steps: {} });

    expect(result.exit).toBe('actionable');
    expect(result.output).toEqual({ outcome: 'actionable' });
  });

  it('an outcome not declared in exits falls back to the ERROR_EXIT entry', async () => {
    registerFakeProvider('fake-7', async () => ({ outcome: 'something-unexpected' }));

    const a = agent({
      id: 'x',
      provider: 'fake-7',
      prompt: 'p',
      exits: { [SUCCESS_EXIT]: SUCCESS_EXIT, [ERROR_EXIT]: 'failed' },
    });
    const result = await a.run({ event: createEvent('t', {}), steps: {} });

    expect(result.exit).toBe('failed');
  });

  it('cancelled/truncated outcomes resolve to no exit at all (NO_TRANSITION_OUTCOMES)', async () => {
    registerFakeProvider('fake-8', async () => ({ outcome: 'cancelled' }));

    const a = agent({
      id: 'x',
      provider: 'fake-8',
      prompt: 'p',
      exits: { [ERROR_EXIT]: 'failed' },
    });
    const result = await a.run({ event: createEvent('t', {}), steps: {} });

    expect(result.exit).toBeUndefined();
  });

  it('passes tools, providerConfig and mcpServers through to the provider untouched', async () => {
    let received: ProviderRunContext | undefined;
    registerFakeProvider('fake-9', async (ctx) => {
      received = ctx;
      return { outcome: SUCCESS_EXIT };
    });

    const tool = { name: 't', description: 'd', inputSchema: {}, handler: () => 'x' };
    const a = agent({
      id: 'x',
      provider: 'fake-9',
      prompt: 'p',
      tools: [tool],
      providerConfig: { model: 'x' },
      mcpServers: [{ id: 'gh', config: { url: 'https://x' } }],
    });
    await a.run({ event: createEvent('t', {}), steps: {} });

    expect(received?.tools).toEqual([tool]);
    expect(received?.providerConfig).toEqual({ model: 'x' });
    expect(received?.mcpServers).toEqual([{ id: 'gh', config: { url: 'https://x' } }]);
  });
});
