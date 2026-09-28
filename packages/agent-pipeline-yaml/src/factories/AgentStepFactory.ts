import type { Agent } from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import type { StepBuildContext, StepFactory } from '../StepFactory.js';

const Node = z.strictObject({ agent: z.string().min(1) });

/** `{ agent: implementer }`: el agente del proyecto (`agents/*.yaml`) con ese id. */
export class AgentStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'agent';
  readonly schema = Node;

  create(node: z.infer<typeof Node>, context: StepBuildContext): Agent {
    return context.agent(node.agent);
  }
}
