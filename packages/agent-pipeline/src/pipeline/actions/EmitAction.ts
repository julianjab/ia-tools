import type { ToolInputSchema } from '../../agent/SchemaTool.js';
import { deriveEvent } from '../../events/DomainEvent.js';
import { type PipelineExecutionContext, Runnable, type RunnableProps } from '../Runnable.js';

export interface EmitActionProps extends RunnableProps {
  type: string;
  payload?:
    | Record<string, unknown>
    | ((
        ctx: PipelineExecutionContext,
        input: Record<string, unknown> | undefined,
      ) => Record<string, unknown>);
  /** Opcional: qué puede entregarle un agente a este paso como destino de una ruta. Sin
   *  `payload`, el input validado ES el payload del evento derivado. */
  input?: ToolInputSchema;
}

/** Publica un DomainEvent derivado — sin llamar a ningún Agent. Útil para "traducir" un paso
 *  en un evento que otro Pipeline escucha, sin acoplar los dos directamente. */
export class EmitAction extends Runnable {
  readonly type: string;
  readonly payload?: EmitActionProps['payload'];
  readonly input?: ToolInputSchema;

  constructor(props: EmitActionProps) {
    super(props);
    this.type = props.type;
    this.payload = props.payload;
    this.input = props.input;
  }

  override acceptsInput(): ToolInputSchema | undefined {
    return this.input;
  }

  async run(ctx: PipelineExecutionContext, input?: unknown): Promise<unknown> {
    const parsed = this.parseInput(this.input, input);
    const payload =
      typeof this.payload === 'function'
        ? this.payload(ctx, parsed)
        : (this.payload ?? parsed ?? {});
    const event = deriveEvent(ctx.event, this.type, payload);
    await ctx.bus.publish(event);
    return event;
  }
}
