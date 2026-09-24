import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SchemaTool } from '../SchemaTool.js';

const EchoInput = z.strictObject({
  text: z.string().describe('Texto a repetir'),
  times: z.number().int().positive().optional(),
});

class EchoTool extends SchemaTool<typeof EchoInput> {
  readonly name = 'echo';
  readonly description = 'repite texto';
  readonly input = EchoInput;
  calls = 0;

  protected execute(input: z.infer<typeof EchoInput>): string {
    this.calls++;
    return input.text.repeat(input.times ?? 1);
  }
}

describe('SchemaTool', () => {
  it('derives inputSchema from the zod schema, without $schema', () => {
    const tool = new EchoTool();

    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Texto a repetir' },
        times: { type: 'integer', exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
      required: ['text'],
      additionalProperties: false,
    });
  });

  it('memoizes inputSchema', () => {
    const tool = new EchoTool();

    expect(tool.inputSchema).toBe(tool.inputSchema);
  });

  it('runs execute with the parsed input when valid', async () => {
    const tool = new EchoTool();

    expect(await tool.handler({ text: 'ab', times: 2 })).toBe('abab');
  });

  it('throws a readable error and skips execute when a required field is missing', () => {
    const tool = new EchoTool();

    expect(() => tool.handler({})).toThrow(/echo: input inválido[\s\S]*→ at text/);
    expect(tool.calls).toBe(0);
  });

  it('rejects keys the schema does not declare', () => {
    const tool = new EchoTool();

    expect(() => tool.handler({ text: 'a', extra: 1 })).toThrow(/Unrecognized key: "extra"/);
    expect(tool.calls).toBe(0);
  });

  it('rejects a non-object input', () => {
    const tool = new EchoTool();

    expect(() => tool.handler(undefined)).toThrow(/echo: input inválido/);
  });
});
