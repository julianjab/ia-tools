import { Condition, PauseAction, type PauseBranchProps } from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import type { StepBuildContext, StepFactory } from '../StepFactory.js';
import { ConditionRows, RouteToNode } from '../schema.js';

const Node = z.strictObject({
  /** El id de la pausa: el checkpoint la busca por él al reanudar. */
  pause: z.string().min(1),
  branches: z
    .record(
      z.string(),
      z.strictObject({
        on: z.array(z.string().min(1)).min(1),
        when: ConditionRows.optional(),
        to: RouteToNode.optional(),
      }),
    )
    .optional(),
  timeout: z
    .strictObject({ afterMs: z.number().int().positive(), to: RouteToNode.optional() })
    .optional(),
  when: ConditionRows.optional(),
});

/** `{ pause: wait-ci, branches: { green: { on: [...], to: [...] } }, timeout: {...} }`. */
export class PauseStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'pause';
  readonly schema = Node;

  create(node: z.infer<typeof Node>, context: StepBuildContext): PauseAction {
    const branches: Record<string, PauseBranchProps> = {};
    for (const [name, branch] of Object.entries(node.branches ?? {})) {
      const to = context.routeTo(branch.to, `${context.where}.branches.${name}.to`);
      branches[name] = {
        on: branch.on,
        when: Condition.fromRows(branch.when),
        ...(to !== undefined ? { to } : {}),
      };
    }
    const timeoutTo = node.timeout
      ? context.routeTo(node.timeout.to, `${context.where}.timeout.to`)
      : undefined;
    return new PauseAction({
      id: node.pause,
      branches,
      ...(node.timeout
        ? {
            timeout: {
              afterMs: node.timeout.afterMs,
              ...(timeoutTo !== undefined ? { to: timeoutTo } : {}),
            },
          }
        : {}),
      when: Condition.fromRows(node.when),
    });
  }
}
