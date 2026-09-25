import type {
  EventBus,
  PipelineExecutionContext,
  ProviderRunContext,
  Tool,
} from '@ia-tools/agent-pipeline';
import { createEvent } from '@ia-tools/agent-pipeline';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../AnthropicProvider.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ctxFor(overrides: Partial<ProviderRunContext> = {}): ProviderRunContext {
  const execCtx = {
    event: createEvent('a', {}),
    steps: {},
    bus: {} as EventBus,
    pipelineId: 'p',
  } satisfies PipelineExecutionContext;

  return {
    agentId: 'x',
    prompt: 'hola',
    systemPrompts: [],
    variables: {},
    providerConfig: {},
    mcpServers: [],
    tools: [],
    ctx: execCtx,
    ...overrides,
  };
}

describe('AnthropicProvider.run', () => {
  it('returns success with the final text on end_turn', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' }),
    );
    const provider = new AnthropicProvider({
      id: 'anthropic-api',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.run(ctxFor());

    expect(result).toEqual({ outcome: 'success', summary: 'listo' });
  });

  it('resolveOutcome overrides the default success outcome', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [{ type: 'text', text: 'actionable' }], stop_reason: 'end_turn' }),
    );
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      resolveOutcome: (text) => text,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.run(ctxFor());

    expect(result.outcome).toBe('actionable');
  });

  it('returns truncated (no bump) when bumpMaxTokensOnTruncation is false', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }),
    );
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      bumpMaxTokensOnTruncation: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.run(ctxFor());

    expect(result).toEqual({ outcome: 'truncated', summary: 'partial' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bumps max_tokens once on truncation and succeeds if the retry converges', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls++;
      const body = JSON.parse(init.body as string);
      if (calls === 1) {
        expect(body.max_tokens).toBe(1000);
        return jsonResponse({
          content: [{ type: 'text', text: 'cut' }],
          stop_reason: 'max_tokens',
        });
      }
      expect(body.max_tokens).toBe(2000);
      return jsonResponse({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
    });
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      maxTokens: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.run(ctxFor());

    expect(result).toEqual({ outcome: 'success', summary: 'done' });
    expect(calls).toBe(2);
  });

  it('runs a tool_use round trip and feeds tool_result back', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls++;
      const body = JSON.parse(init.body as string);
      if (calls === 1) {
        expect(body.tools).toEqual([{ name: 'add', description: 'suma', input_schema: {} }]);
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'add', input: { a: 1, b: 2 } }],
          stop_reason: 'tool_use',
        });
      }
      // Segunda vuelta: el tool_result tiene que estar en el último mensaje user.
      const lastMessage = body.messages[body.messages.length - 1];
      expect(lastMessage).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '3' }],
      });
      return jsonResponse({
        content: [{ type: 'text', text: 'suma: 3' }],
        stop_reason: 'end_turn',
      });
    });

    const tool: Tool = {
      name: 'add',
      description: 'suma',
      inputSchema: {},
      handler: (input: { a: number; b: number }) => String(input.a + input.b),
    };
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      onToolCall,
      onToolResult,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.run(ctxFor({ tools: [tool] }));

    expect(result).toEqual({ outcome: 'success', summary: 'suma: 3' });
    expect(onToolCall).toHaveBeenCalledWith('add', { a: 1, b: 2 }, 'tu_1');
    expect(onToolResult).toHaveBeenCalledWith('add', '3', 'tu_1');
  });

  it('reports an unknown tool name as an is_error tool_result instead of throwing', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) {
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'missing', input: {} }],
          stop_reason: 'tool_use',
        });
      }
      const body = JSON.parse(init.body as string);
      const lastMessage = body.messages[body.messages.length - 1];
      expect(lastMessage.content[0].is_error).toBe(true);
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    });
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.run(ctxFor());

    expect(result.outcome).toBe('success');
  });

  it('reports a throwing tool handler as an is_error tool_result instead of crashing the run', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) {
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'boom', input: {} }],
          stop_reason: 'tool_use',
        });
      }
      const body = JSON.parse(init.body as string);
      const lastMessage = body.messages[body.messages.length - 1];
      expect(lastMessage.content[0]).toMatchObject({ is_error: true, content: 'Error: kaboom' });
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    });
    const tool: Tool = {
      name: 'boom',
      description: 'd',
      inputSchema: {},
      handler: () => {
        throw new Error('kaboom');
      },
    };
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.run(ctxFor({ tools: [tool] }));

    expect(result.outcome).toBe('success');
  });

  it('throws on an unexpected stop_reason instead of guessing success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ content: [], stop_reason: null }));
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.run(ctxFor())).rejects.toThrow('null');
  });

  it('resends the conversation and continues on pause_turn instead of throwing', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) {
        return jsonResponse({
          content: [{ type: 'text', text: 'a mitad' }],
          stop_reason: 'pause_turn',
        });
      }
      const body = JSON.parse(init.body as string);
      const lastMessage = body.messages[body.messages.length - 1];
      expect(lastMessage).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'a mitad' }],
      });
      return jsonResponse({ content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' });
    });
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.run(ctxFor());

    expect(result).toEqual({ outcome: 'success', summary: 'listo' });
    expect(calls).toBe(2);
  });

  it('throws once maxToolRounds is exceeded without converging', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'noop', input: {} }],
        stop_reason: 'tool_use',
      }),
    );
    const tool: Tool = { name: 'noop', description: 'd', inputSchema: {}, handler: () => 'x' };
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      maxToolRounds: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.run(ctxFor({ tools: [tool] }))).rejects.toThrow('maxToolRounds');
  });

  it('clamps a provider-level thinking budget under maxTokens instead of sending it as-is', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      // budgetTokens (8192) is bigger than maxTokens (4096) — an unclamped value would violate
      // the API's budget_tokens < max_tokens requirement and 400.
      expect(body.max_tokens).toBe(4096);
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 3072 });
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    });
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      maxTokens: 4096,
      thinking: { type: 'enabled', budgetTokens: 8192 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.run(ctxFor());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('omits thinking entirely when even a clamped budget cannot fit under maxTokens', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      // Default maxTokens is 1024 — the API requires budget_tokens >= 1024 AND < max_tokens, so
      // no budget fits. Silently omitting thinking (not sending an invalid request) is correct.
      expect(body.max_tokens).toBe(1024);
      expect(body.thinking).toBeUndefined();
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    });
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      thinking: { type: 'enabled', budgetTokens: 2048 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.run(ctxFor());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes an adaptive provider-level thinking config through unchanged', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.thinking).toEqual({ type: 'adaptive' });
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    });
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      thinking: { type: 'adaptive' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.run(ctxFor());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('builds mcp_servers from McpServerRef config and defers its tools by default', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.mcp_servers).toEqual([
        { name: 'gh', type: 'url', url: 'https://mcp.example/gh', authorization_token: 'tok' },
      ]);
      expect(body.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool_search_tool_regex_20251119' }),
          expect.objectContaining({ type: 'mcp_toolset', mcp_server_name: 'gh' }),
        ]),
      );
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    });
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.run(
      ctxFor({
        mcpServers: [
          { id: 'gh', config: { url: 'https://mcp.example/gh', authorizationToken: 'tok' } },
        ],
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('calls onCheckpoint with the running conversation before each request', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'noop', input: {} }],
          stop_reason: 'tool_use',
        });
      }
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    });
    const tool: Tool = { name: 'noop', description: 'd', inputSchema: {}, handler: () => 'x' };
    const onCheckpoint = vi.fn();
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      onCheckpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.run(ctxFor({ tools: [tool] }));

    expect(onCheckpoint).toHaveBeenCalledTimes(2);
    expect((onCheckpoint.mock.calls[0][0] as unknown[]).length).toBe(1);
    expect((onCheckpoint.mock.calls[1][0] as unknown[]).length).toBe(3);
  });

  it('resumes from providerConfig.resumeMessages instead of the prompt', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.messages).toEqual([{ role: 'user', content: 'mensaje previo' }]);
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    });
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.run(
      ctxFor({
        providerConfig: { resumeMessages: [{ role: 'user', content: 'mensaje previo' }] },
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('per-agent providerConfig overrides the provider-level model/maxTokens', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('claude-override');
      expect(body.max_tokens).toBe(50);
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    });
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-default',
      maxTokens: 1000,
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.run(ctxFor({ providerConfig: { model: 'claude-override', maxTokens: 50 } }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  describe('terminal tools (submit_<exit>)', () => {
    const submit = (name: string, required: string[] = [], onCall = vi.fn()): Tool => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {}, required },
      handler: (input: unknown) => {
        onCall(input);
        return 'ok';
      },
      terminal: true,
    });

    function providerWith(fetchImpl: unknown) {
      return new AnthropicProvider({
        id: 'x',
        model: 'claude-x',
        apiKey: 'sk',
        stream: false,
        fetchImpl: fetchImpl as typeof fetch,
      });
    }

    it('ends the turn as soon as a terminal tool succeeds, without another request', async () => {
      const onCall = vi.fn();
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          content: [
            { type: 'text', text: 'PRD listo' },
            { type: 'tool_use', id: 'tu_1', name: 'submit_done', input: { x: 1 } },
          ],
          stop_reason: 'tool_use',
        }),
      );

      const result = await providerWith(fetchImpl).run(
        ctxFor({ tools: [submit('submit_done', [], onCall), submit('submit_back')] }),
      );

      expect(result).toEqual({ outcome: 'success', summary: 'PRD listo' });
      expect(onCall).toHaveBeenCalledWith({ x: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('keeps looping when the terminal tool rejects its input, so the model can fix it', async () => {
      let calls = 0;
      const rejecting: Tool = {
        ...submit('submit_done'),
        handler: () => {
          throw new Error('input inválido');
        },
      };
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        calls++;
        if (calls === 1) {
          return jsonResponse({
            content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_done', input: {} }],
            stop_reason: 'tool_use',
          });
        }
        if (calls === 2) {
          const body = JSON.parse(init.body as string);
          expect(body.messages.at(-1).content[0]).toMatchObject({
            type: 'tool_result',
            is_error: true,
          });
        }
        return jsonResponse({
          content: [{ type: 'text', text: 'me rindo' }],
          stop_reason: 'end_turn',
        });
      });

      await providerWith(fetchImpl).run(ctxFor({ tools: [rejecting, submit('submit_back')] }));

      expect(fetchImpl).toHaveBeenCalledTimes(3); // rechazo → end_turn → una insistencia
    });

    it('nudges once when the model ends without calling any terminal tool', async () => {
      let calls = 0;
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        calls++;
        if (calls === 1) {
          return jsonResponse({
            content: [{ type: 'text', text: 'listo' }],
            stop_reason: 'end_turn',
          });
        }
        const body = JSON.parse(init.body as string);
        expect(body.messages.at(-1)).toEqual({
          role: 'user',
          content:
            'Para terminar tu turno tenés que llamar a una de estas tools: submit_done, submit_back.',
        });
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_done', input: {} }],
          stop_reason: 'tool_use',
        });
      });

      const result = await providerWith(fetchImpl).run(
        ctxFor({ tools: [submit('submit_done'), submit('submit_back')] }),
      );

      expect(result.outcome).toBe('success');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('nudges only once: a second end_turn returns and lets the Agent decide', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ content: [{ type: 'text', text: 'no' }], stop_reason: 'end_turn' }),
      );

      const result = await providerWith(fetchImpl).run(
        ctxFor({ tools: [submit('submit_done'), submit('submit_back')] }),
      );

      expect(result).toEqual({ outcome: 'success', summary: 'no' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('does not nudge for a single terminal tool that asks for no data', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ content: [{ type: 'text', text: 'hola' }], stop_reason: 'end_turn' }),
      );

      await providerWith(fetchImpl).run(ctxFor({ tools: [submit('submit_done')] }));

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('nudges for a single terminal tool with required fields', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ content: [{ type: 'text', text: 'hola' }], stop_reason: 'end_turn' }),
      );

      await providerWith(fetchImpl).run(ctxFor({ tools: [submit('submit_done', ['report'])] }));

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});
