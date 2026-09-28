import { Condition, EmitAction } from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import type { StepBuildContext, StepFactory } from '../StepFactory.js';
import { CommonStepShape } from '../schema.js';

const Node = z.strictObject({
  emit: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  scope: z.record(z.string(), z.unknown()).optional(),
  ...CommonStepShape,
});

/** `{ emit: issue.ready, payload: {...} }`: publica un evento derivado (`EmitAction`). */
export class EmitStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'emit';
  readonly schema = Node;

  create(node: z.infer<typeof Node>, _context: StepBuildContext): EmitAction {
    return new EmitAction({
      type: node.emit,
      ...(node.payload ? { payload: node.payload } : {}),
      ...(node.scope ? { scope: node.scope } : {}),
      id: node.id,
      when: Condition.fromRows(node.when),
      continueOnError: node.continueOnError,
    });
  }
}
