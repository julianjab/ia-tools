import { Condition, HttpAction } from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import type { StepBuildContext, StepFactory } from '../StepFactory.js';
import { CommonStepShape } from '../schema.js';

const Node = z.strictObject({
  http: z.url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().positive().optional(),
  ...CommonStepShape,
});

/**
 * `{ http: https://…, method: POST, body: {...} }`: un request (`HttpAction`). Sólo valores
 * fijos: un secreto no va en el YAML — un paso que lo necesita es una acción del catálogo.
 */
export class HttpStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'http';
  readonly schema = Node;

  create(node: z.infer<typeof Node>, _context: StepBuildContext): HttpAction {
    return new HttpAction({
      url: node.http,
      ...(node.method ? { method: node.method } : {}),
      ...(node.headers ? { headers: node.headers } : {}),
      ...(node.body !== undefined ? { body: node.body as Record<string, unknown> } : {}),
      ...(node.timeoutMs ? { timeoutMs: node.timeoutMs } : {}),
      id: node.id,
      when: Condition.fromRows(node.when),
      continueOnError: node.continueOnError,
    });
  }
}
