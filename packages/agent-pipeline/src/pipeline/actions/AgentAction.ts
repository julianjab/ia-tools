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
      // ACOPLAMIENTO DELIBERADO: este `await` significa que si algún Pipeline que escucha
      // `derivedType` falla, ese fallo (un AggregateError — ver EventBus.publish) se propaga
      // hasta ACÁ y aborta este paso, aunque el Agent ya haya corrido con éxito (y con
      // cualquier efecto de lado que eso implique, ej. un PR ya abierto). El resultado del
      // Agent nunca llega a `ctx.steps` en ese caso. Es la misma garantía que le da
      // `Engine.dispatch` a quien llama `bus.publish` en la raíz — un fallo aguas abajo tiene
      // que ser visible, no tragado en silencio — a costa de que un `AgentAction` con
      // `emitOn` no sea "fire and forget". Si preferís que ESTE paso no dependa de lo que
      // pase después, envolvelo con `continueOnError: true` en el `do[]` del Pipeline.
      await ctx.bus.publish(
        deriveEvent(ctx.event, derivedType, { ...basePayload, agentId: this.agentId }),
      );
    }
    return result;
  }
}
