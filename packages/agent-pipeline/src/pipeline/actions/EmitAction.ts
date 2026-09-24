import { deriveEvent } from '../../events/DomainEvent.js';
import { type PipelineExecutionContext, Runnable, type RunnableProps } from '../Runnable.js';

export interface EmitActionProps extends RunnableProps {
  type: string;
  payload?: Record<string, unknown> | ((ctx: PipelineExecutionContext) => Record<string, unknown>);
}

/** Publica un DomainEvent derivado — sin llamar a ningún Agent. Útil para "traducir" un paso
 *  en un evento que otro Pipeline escucha, sin acoplar los dos directamente. */
export class EmitAction extends Runnable {
  readonly type: string;
  readonly payload?: EmitActionProps['payload'];

  constructor(props: EmitActionProps) {
    super(props);
    this.type = props.type;
    this.payload = props.payload;
  }

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    const payload = typeof this.payload === 'function' ? this.payload(ctx) : (this.payload ?? {});
    const event = deriveEvent(ctx.event, this.type, payload);
    await ctx.bus.publish(event);
    return event;
  }
}
