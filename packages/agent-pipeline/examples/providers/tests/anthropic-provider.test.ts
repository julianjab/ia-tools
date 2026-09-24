import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRunContext } from '../../agent.js';
import { anthropicProvider } from '../anthropic-provider.js';

function textResponse(text: string, stopReason: 'end_turn' = 'end_turn') {
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }], stop_reason: stopReason }),
  } as Response;
}

function toolUseResponse(name: string, id: string, input: unknown) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'tool_use', id, name, input }],
      stop_reason: 'tool_use',
    }),
  } as Response;
}

function makeCtx(overrides: Partial<ProviderRunContext> = {}): ProviderRunContext {
  return {
    agentId: 'a',
    prompt: 'hola',
    systemPrompts: ['sys'],
    variables: {},
    providerConfig: {},
    mcpServers: [],
    tools: [],
    input: { event: { type: 't', payload: {}, depth: 0, occurredAt: '' }, steps: {} },
    ...overrides,
  };
}

afterEach(() => {
  // `process.env.X = undefined` NO limpia la env var — Node la coerce a la string "undefined",
  // que sigue siendo truthy para el `??` de anthropicProvider. Hace falta borrar la propiedad
  // de verdad, evitando el operador `delete` que biome desaconseja por performance.
  Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
});

describe('anthropicProvider', () => {
  it('throws a clear error when no API key is configured', async () => {
    const provider = anthropicProvider({ id: 'a', model: 'claude-x', apiKey: undefined });
    await expect(provider.run(makeCtx())).rejects.toThrow(/falta ANTHROPIC_API_KEY/);
  });

  it('returns the final text as outcome "success" on a single-turn response (no tools)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('hola'));
    const provider = anthropicProvider({
      id: 'a',
      model: 'claude-x',
      apiKey: 'test-key',
      fetchImpl,
    });

    const result = await provider.run(makeCtx());

    expect(result).toEqual({ outcome: 'success', summary: 'hola' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolveOutcome derives the outcome from the final text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('needs_review'));
    const provider = anthropicProvider({
      id: 'a',
      model: 'claude-x',
      apiKey: 'test-key',
      fetchImpl,
      resolveOutcome: (text) => text,
    });

    const result = await provider.run(makeCtx());
    expect(result.outcome).toBe('needs_review');
  });

  it('sends the joined systemPrompts and the already-interpolated prompt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse('ok'));
    const provider = anthropicProvider({
      id: 'a',
      model: 'claude-x',
      apiKey: 'test-key',
      fetchImpl,
    });

    await provider.run(makeCtx({ systemPrompts: ['uno', 'dos'], prompt: 'ya interpolado' }));

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.system).toBe('uno\n\ndos');
    expect(body.messages[0]).toEqual({ role: 'user', content: 'ya interpolado' });
  });

  it('runs the tool loop: calls the matching handler and sends its result back', async () => {
    const handler = vi.fn().mockResolvedValue('42 degrees');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse('get_weather', 'tu_1', { city: 'BOG' }))
      .mockResolvedValueOnce(textResponse('Hace 42 grados'));

    const provider = anthropicProvider({
      id: 'weather',
      model: 'claude-x',
      apiKey: 'test-key',
      fetchImpl,
    });

    const result = await provider.run(
      makeCtx({
        tools: [
          {
            name: 'get_weather',
            description: 'Clima de una ciudad',
            inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
            handler,
          },
        ],
      }),
    );

    expect(handler).toHaveBeenCalledWith({ city: 'BOG' });
    expect(result).toEqual({ outcome: 'success', summary: 'Hace 42 grados' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const secondCallBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(secondCallBody.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '42 degrees' }],
    });
  });

  it('an unrecognized tool name sends an error tool_result instead of crashing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse('unknown_tool', 'tu_1', {}))
      .mockResolvedValueOnce(textResponse('ok'));

    const provider = anthropicProvider({
      id: 'a',
      model: 'claude-x',
      apiKey: 'test-key',
      fetchImpl,
    });

    await provider.run(makeCtx());

    const secondCallBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(secondCallBody.messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'Error: no existe una tool registrada con nombre "unknown_tool"',
      is_error: true,
    });
  });

  it('a tool handler that throws sends an is_error tool_result instead of crashing the loop', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse('flaky', 'tu_1', {}))
      .mockResolvedValueOnce(textResponse('recovered'));

    const provider = anthropicProvider({
      id: 'a',
      model: 'claude-x',
      apiKey: 'test-key',
      fetchImpl,
    });

    const result = await provider.run(
      makeCtx({
        tools: [
          {
            name: 'flaky',
            description: '',
            inputSchema: {},
            handler: () => {
              throw new Error('input inválido');
            },
          },
        ],
      }),
    );

    expect(result).toEqual({ outcome: 'success', summary: 'recovered' });
    const secondCallBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(secondCallBody.messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'Error: input inválido',
      is_error: true,
    });
  });

  it('throws once maxToolRounds is exceeded without converging', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(toolUseResponse('loop', 'tu_1', {}));
    const provider = anthropicProvider({
      id: 'a',
      model: 'claude-x',
      apiKey: 'test-key',
      fetchImpl,
      maxToolRounds: 2,
    });

    await expect(
      provider.run(
        makeCtx({
          tools: [{ name: 'loop', description: '', inputSchema: {}, handler: () => 'x' }],
        }),
      ),
    ).rejects.toThrow(/superó maxToolRounds/);
  });

  it('surfaces the response body on a non-ok API response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: async () => 'invalid api key' });
    const provider = anthropicProvider({ id: 'a', model: 'claude-x', apiKey: 'bad', fetchImpl });

    await expect(provider.run(makeCtx())).rejects.toThrow(/401: invalid api key/);
  });
});
