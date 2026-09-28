import { Condition } from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import type { StepBuildContext, StepFactory } from '../StepFactory.js';
import { CommonStepShape } from '../schema.js';
import { EmitStep } from '../steps/EmitStep.js';

const Node = z.strictObject({
  emit: z.string().min(1),
  /** Un objeto, o una plantilla entera (`'{{steps.task.payload}}'`). */
  payload: z.unknown().optional(),
  scope: z.unknown().optional(),
  /** Un evento por elemento de esta lista; las plantillas lo ven como `item`. */
  forEach: z.string().min(1).optional(),
  ...CommonStepShape,
});

/**
 * `{ emit: issue.ready, payload: {...} }`: publica un evento derivado (`EmitStep`). Tipo, payload
 * y scope admiten `{{...}}`, resueltos al correr contra el payload y los `steps`.
 */
export class EmitStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'emit';
  readonly schema = Node;

  create(node: z.infer<typeof Node>, _context: StepBuildContext): EmitStep {
    return new EmitStep({
      type: node.emit,
      ...(node.payload !== undefined ? { payload: node.payload } : {}),
      ...(node.scope !== undefined ? { scope: node.scope } : {}),
      ...(node.forEach ? { forEach: node.forEach } : {}),
      id: node.id,
      when: Condition.fromRows(node.when),
      continueOnError: node.continueOnError,
    });
  }
}
