import {
  PipelineAction,
  type PipelineActionProps,
  type PipelineExecutionContext,
} from './PipelineAction.js';

export interface FunctionActionProps extends PipelineActionProps {
  fn: (ctx: PipelineExecutionContext) => Promise<unknown> | unknown;
}

/**
 * Corre una función arbitraria del proceso con el contexto completo — el reemplazo de
 * `ScriptAction` (que en engine-v2/v1 ejecuta un script de shell del repo). Acá no hay
 * shell de por medio: es código TypeScript normal, así que no hereda el riesgo de comandos
 * arbitrarios ni necesita una allow-list de env vars.
 */
export class FunctionAction extends PipelineAction {
  readonly fn: FunctionActionProps['fn'];

  constructor(props: FunctionActionProps) {
    super(props);
    this.fn = props.fn;
  }

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    return this.fn(ctx);
  }
}
