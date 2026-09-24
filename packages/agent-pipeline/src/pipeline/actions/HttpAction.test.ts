import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { createEvent } from '../../events/DomainEvent.js';
import { EventBus } from '../../events/EventBus.js';
import { HttpAction } from './HttpAction.js';
import type { PipelineExecutionContext } from './PipelineAction.js';

function makeCtx(): PipelineExecutionContext {
  return {
    event: createEvent('t', {}),
    steps: {},
    bus: new EventBus(),
    agents: new AgentRegistry(),
    pipelineId: 'p1',
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpAction', () => {
  it('defaults to a GET request with a json content-type header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new HttpAction({ url: 'https://api.example.com/x' }).run(makeCtx());

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/x', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      body: undefined,
    });
    expect(result).toEqual({ ok: true });
  });

  it('resolves url/headers/body functions against the execution context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = makeCtx();
    ctx.steps.triage = { output: { id: 42 } };

    await new HttpAction({
      url: (c) =>
        `https://api.example.com/${(c.steps.triage as { output: { id: number } }).output.id}`,
      method: 'POST',
      headers: () => ({ authorization: 'Bearer x' }),
      body: (c: PipelineExecutionContext) => ({ steps: c.steps }),
    }).run(ctx);

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/42', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: JSON.stringify({ steps: ctx.steps }),
    });
  });

  it('returns text when the response is not application/json', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        json: async () => {
          throw new Error('should not be called');
        },
        text: async () => 'plain body',
      }),
    );

    const result = await new HttpAction({ url: 'https://api.example.com' }).run(makeCtx());
    expect(result).toBe('plain body');
  });

  it('throws with the status code when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, false, 500)));

    await expect(
      new HttpAction({ url: 'https://api.example.com', method: 'POST' }).run(makeCtx()),
    ).rejects.toThrow('HttpAction: POST https://api.example.com → 500');
  });
});
