import { EventBus, FunctionAction, createEvent } from '@ia-tools/agent-engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { StepFactory } from '../StepFactory.js';
import { YamlPipelineSource } from '../YamlPipelineSource.js';
import { projectDir } from './fixtures.js';

const Node = z.strictObject({ log: z.string() });

/** Un tipo de paso propio de la app. */
class LogStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'log';
  readonly schema = Node;
  constructor(private readonly lines: string[]) {}
  create(node: z.infer<typeof Node>) {
    return new FunctionAction({ fn: () => this.lines.push(node.log) });
  }
}

describe('custom step types', () => {
  it('a registered factory adds a step keyword without touching the loader', async () => {
    const lines: string[] = [];
    const source = new YamlPipelineSource({
      dir: projectDir({ 'pipelines/p.yaml': 'id: p\non: [e]\ndo:\n  - { log: hola }\n' }),
      catalogs: { steps: [new LogStepFactory(lines)] },
    });
    const [pipeline] = source.list();
    await pipeline?.execute({
      event: createEvent('e', {}),
      steps: {},
      bus: new EventBus(),
      pipelineId: 'p',
    });
    expect(lines).toEqual(['hola']);
  });

  it('validates a step against its factory schema', () => {
    expect(
      () =>
        new YamlPipelineSource({
          dir: projectDir({
            'pipelines/p.yaml': 'id: p\non: [e]\ndo:\n  - { emit: x, typo: 1 }\n',
          }),
        }),
    ).toThrow(/do\[0\]: emit inválido/);
  });
});
