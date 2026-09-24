import { describe, expect, it } from 'vitest';
import { readAnthropicSseStream } from '../sse.js';

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body);
}

function frame(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('readAnthropicSseStream', () => {
  it('reassembles a text response from message_start/content_block_*/message_delta', async () => {
    const res = sseResponse([
      frame('message_start', { message: { id: 'msg_1', usage: { input_tokens: 5 } } }),
      frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hola ' } }),
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'mundo' } }),
      frame('content_block_stop', { index: 0 }),
      frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
      frame('message_stop', {}),
    ]);

    const message = await readAnthropicSseStream(res);

    expect(message.stop_reason).toBe('end_turn');
    expect(message.content).toEqual([{ type: 'text', text: 'Hola mundo' }]);
    expect(message.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
  });

  it('reassembles a tool_use block from streamed input_json_delta', async () => {
    const res = sseResponse([
      frame('message_start', { message: {} }),
      frame('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
      }),
      frame('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      }),
      frame('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"x"}' },
      }),
      frame('content_block_stop', { index: 0 }),
      frame('message_delta', { delta: { stop_reason: 'tool_use' } }),
    ]);

    const message = await readAnthropicSseStream(res);

    expect(message.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } },
    ]);
  });

  it('falls back to an empty object when the streamed tool input JSON is malformed', async () => {
    const res = sseResponse([
      frame('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'x', input: {} },
      }),
      frame('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{not json' },
      }),
      frame('content_block_stop', { index: 0 }),
    ]);

    const message = await readAnthropicSseStream(res);

    expect((message.content as Array<Record<string, unknown>>)[0].input).toEqual({});
  });

  it('throws on an `error` SSE event', async () => {
    const res = sseResponse([frame('error', { error: { message: 'overloaded' } })]);

    await expect(readAnthropicSseStream(res)).rejects.toThrow('overloaded');
  });

  it('throws when the response has no body', async () => {
    const res = new Response(null);
    // `new Response(null)` still gives a body in some runtimes — force the case explicitly.
    Object.defineProperty(res, 'body', { value: null });

    await expect(readAnthropicSseStream(res)).rejects.toThrow('sin body');
  });
});
