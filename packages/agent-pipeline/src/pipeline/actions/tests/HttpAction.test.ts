import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../../../agent/AgentRegistry.js';
import { createEvent } from '../../../events/DomainEvent.js';
import { EventBus } from '../../../events/EventBus.js';
import { HttpAction } from '../HttpAction.js';
import type { PipelineExecutionContext } from '../PipelineAction.js';

function makeCtx(): PipelineExecutionContext {
  return {
    event: createEvent('t', {}),
    steps: {},
    bus: new EventBus(),
    agents: new AgentRegistry(),
    pipelineId: 'p1',
  };
}

function textResponse(
  body: string,
  opts: { ok?: boolean; status?: number; contentType?: string } = {},
) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: new Headers({ 'content-type': opts.contentType ?? 'application/json' }),
    text: async () => body,
  } as Response;
}

function jsonResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  return textResponse(JSON.stringify(body), opts);
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
      signal: expect.any(AbortSignal),
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
      signal: expect.any(AbortSignal),
    });
  });

  it('returns text when the response is not application/json', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(textResponse('plain body', { contentType: 'text/plain' })),
    );

    const result = await new HttpAction({ url: 'https://api.example.com' }).run(makeCtx());
    expect(result).toBe('plain body');
  });

  it('throws with the status code and a body snippet when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, { ok: false, status: 500 })),
    );

    await expect(
      new HttpAction({ url: 'https://api.example.com', method: 'POST' }).run(makeCtx()),
    ).rejects.toThrow('HttpAction: POST https://api.example.com → 500: {"error":"nope"}');
  });

  it('a non-ok response with an empty body does not crash trying to parse it as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse('', { ok: false, status: 502 })));

    await expect(new HttpAction({ url: 'https://api.example.com' }).run(makeCtx())).rejects.toThrow(
      'HttpAction: GET https://api.example.com → 502',
    );
  });

  it('a non-ok response with an HTML body (proxy error page) surfaces the status, not a JSON parse error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(textResponse('<html>Bad Gateway</html>', { ok: false, status: 502 })),
    );

    await expect(new HttpAction({ url: 'https://api.example.com' }).run(makeCtx())).rejects.toThrow(
      /502: <html>Bad Gateway<\/html>/,
    );
  });

  it('a 204-style empty body on a successful response resolves to undefined instead of throwing on JSON.parse', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse('', { status: 204 })));

    const result = await new HttpAction({ url: 'https://api.example.com' }).run(makeCtx());
    expect(result).toBeUndefined();
  });

  it('never sends a body on GET, even if one was configured — fetch throws a TypeError otherwise', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await new HttpAction({ url: 'https://api.example.com', method: 'GET', body: { x: 1 } }).run(
      makeCtx(),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com',
      expect.objectContaining({ method: 'GET', body: undefined }),
    );
  });

  it('never sends a body on DELETE either', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await new HttpAction({ url: 'https://api.example.com', method: 'DELETE', body: { x: 1 } }).run(
      makeCtx(),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com',
      expect.objectContaining({ method: 'DELETE', body: undefined }),
    );
  });

  it('aborts the request once timeoutMs elapses, so a hung host cannot block the pipeline forever', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const run = new HttpAction({ url: 'https://api.example.com', timeoutMs: 50 }).run(makeCtx());
    const assertion = expect(run).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    await assertion;

    expect(capturedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
