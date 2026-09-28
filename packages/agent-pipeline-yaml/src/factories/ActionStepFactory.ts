import type { Action } from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import type { StepBuildContext, StepFactory } from '../StepFactory.js';
import { lookup } from '../YamlCatalogs.js';

const Node = z.strictObject({
  action: z.string().min(1),
  /** Campos del input que fija la config (`Action.bind`): el agente no los ve. */
  with: z.record(z.string(), z.unknown()).optional(),
});

/** `{ action: addLabel, with: { label: blocked } }`: una acción del catálogo. */
export class ActionStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'action';
  readonly schema = Node;

  create(node: z.infer<typeof Node>, context: StepBuildContext): Action {
    const action = lookup(context.catalogs.actions, node.action, 'una acción');
    return node.with ? action.bind(node.with as Partial<unknown>) : action;
  }
}
