import type { Action } from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import type { StepBuildContext, StepFactory } from '../StepFactory.js';

const Node = z.strictObject({
  action: z.string().min(1),
  /** Campos del input que fija la config (`Action.bind`): el agente no los ve. */
  with: z.record(z.string(), z.unknown()).optional(),
  /** Para una acción que el catálogo arma a pedido (`ActionProvider`). */
  options: z.record(z.string(), z.unknown()).optional(),
});

/** `{ action: addLabel, with: { label: blocked } }`: una acción del catálogo. */
export class ActionStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'action';
  readonly schema = Node;

  create(node: z.infer<typeof Node>, context: StepBuildContext): Action {
    const built = context.action(node.action, node.options);
    if (Array.isArray(built)) {
      throw new Error(
        `la acción "${node.action}" arma ${built.length} acciones: como paso tiene que ser una sola`,
      );
    }
    return node.with ? built.bind(node.with as Partial<unknown>) : built;
  }
}
