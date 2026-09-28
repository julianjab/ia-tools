import { Condition, FunctionAction } from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import type { StepBuildContext, StepFactory } from '../StepFactory.js';
import { lookup } from '../YamlCatalogs.js';
import { CommonStepShape } from '../schema.js';

const Node = z.strictObject({
  function: z.string().min(1),
  ...CommonStepShape,
});

/** `{ function: resolveItem }`: una función del catálogo, como `FunctionAction`. */
export class FunctionStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'function';
  readonly schema = Node;

  create(node: z.infer<typeof Node>, context: StepBuildContext): FunctionAction {
    return new FunctionAction({
      fn: lookup(context.catalogs.functions, node.function, 'una función'),
      id: node.id ?? node.function,
      when: Condition.fromRows(node.when),
      continueOnError: node.continueOnError,
    });
  }
}
