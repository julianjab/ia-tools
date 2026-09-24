import { deriveEvent } from '../../events/DomainEvent.js';
import {
  PipelineAction,
  type PipelineActionProps,
  type PipelineExecutionContext,
} from './PipelineAction.js';

export interface AgentActionProps extends PipelineActionProps {
  agentId: string;
  /** Instrucción de este paso puntual — string fijo, o derivada del contexto en runtime. */
  brief?: string | ((ctx: PipelineExecutionContext) => string);
  /**
   * Si se setea, al terminar emite un DomainEvent derivado con `type: emitOn(exit)` —
   * el patrón "onFinish"/"onError" de v1, generalizado: vos decidís el nombre del evento
   * derivado a partir del `exit` que devolvió el Agent.
   */
  emitOn?: (exit: string) => string | undefined;
}

/** Corre un Agent registrado y, opcionalmente, deriva un evento a partir de su `exit`. */
export class AgentAction extends PipelineAction {
  readonly agentId: string;
  readonly brief?: string | ((ctx: PipelineExecutionContext) => string);
  readonly emitOn?: (exit: string) => string | undefined;

  constructor(props: AgentActionProps) {
    super(props);
    this.agentId = props.agentId;
    this.brief = props.brief;
    this.emitOn = props.emitOn;
  }

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    const agent = ctx.agents.get(this.agentId);
    if (agent == null) {
      throw new Error(`AgentAction: no hay ningún Agent registrado con id "${this.agentId}"`);
    }
    const brief = typeof this.brief === 'function' ? this.brief(ctx) : this.brief;
    const result = await agent.run({ event: ctx.event, steps: ctx.steps, brief });

    const derivedType = this.emitOn?.(result.exit ?? 'success');
    if (derivedType) {
      const basePayload =
        typeof result.output === 'object' && result.output !== null
          ? (result.output as Record<string, unknown>)
          : { output: result.output };
      await ctx.bus.publish(
        deriveEvent(ctx.event, derivedType, { ...basePayload, agentId: this.agentId }),
      );
    }
    return result;
  }
}
