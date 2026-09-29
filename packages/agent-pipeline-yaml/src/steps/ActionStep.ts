import {
  type Action,
  type PipelineExecutionContext,
  Runnable,
  type RunnableProps,
} from '@ia-tools/agent-pipeline';
import { render, templateRoot } from '../Template.js';

export interface ActionStepProps extends RunnableProps {
  action: Action;
  /** El input de la acción; sus `{{...}}` se resuelven al correr. */
  with: Record<string, unknown>;
}

/**
 * Una acción del catálogo como paso, con un `with` que depende del evento: se resuelve contra el
 * payload y los `steps` en cada corrida, y la acción lo valida contra su schema como a cualquier
 * input. (Un `with` fijo no necesita esto: es `Action.bind`, validado al cargar.)
 */
export class ActionStep extends Runnable {
  private readonly action: Action;
  private readonly args: Record<string, unknown>;

  constructor(props: ActionStepProps) {
    super(props);
    this.action = props.action;
    this.args = props.with;
  }

  run(ctx: PipelineExecutionContext): Promise<unknown> {
    return this.action.run(ctx, render(this.args, templateRoot(ctx)));
  }
}
