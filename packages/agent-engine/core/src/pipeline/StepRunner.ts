import { createLogger, traced } from '@ia-tools/telemetry';
import { type ErrorRoute, type ExitDefaults, routeTargets } from '../routing/ExitRoutes.js';
import type { StepRun, StepVia } from './Pipeline.js';
import type { PipelineGraph } from './PipelineGraph.js';
import type { PipelineExecutionContext, Runnable } from './Runnable.js';
import type { Pause } from './actions/Pause.js';
import { stepTrace } from './tracing.js';

/**
 * Corre UN paso de una pipeline y lo que su resultado pide: si eligió una salida, su `report`
 * (el cierre del turno, ANTES que los destinos: el siguiente agente tiene que ver ese comentario)
 * y sus destinos en orden; si tiró, el `onError` que le toca. Cada paso que corre abre su span.
 */
export class StepRunner {
  readonly log = createLogger('agent-engine.pipeline');

  constructor(
    private readonly pipelineId: string,
    private readonly graph: PipelineGraph,
    private readonly defaults: ExitDefaults,
  ) {}

  /**
   * Corre `step` si su `when` lo deja. Devuelve la pausa si el paso —o un destino de la salida que
   * eligió— pidió pausar: la pipeline corta ahí.
   *
   * `handleErrors: false` para los pasos que corren DENTRO de un `onError`: si fallara, por
   * ejemplo, el `+blocked` del proyecto, volver a aplicar ese mismo `onError` sería un loop.
   */
  async run(
    step: Runnable,
    input: unknown,
    ctx: PipelineExecutionContext,
    via: StepVia,
    handleErrors = true,
  ): Promise<Pause | undefined> {
    return (await this.attempt(step, input, ctx, via, handleErrors)).paused;
  }

  /** Como `run`, y además si el paso corrió o su `when`/`whenText` lo salteó — lo que necesita
   *  una pipeline `firstMatch` para saber cuándo cortar. */
  async attempt(
    step: Runnable,
    input: unknown,
    ctx: PipelineExecutionContext,
    via: StepVia,
    handleErrors = true,
  ): Promise<{ ran: boolean; paused?: Pause }> {
    if (!step.shouldRun(ctx)) return { ran: false };
    const payload = ctx.event.payload;
    const subject = typeof payload === 'object' && payload !== null ? payload : {};
    const textMismatch = await step.explainText(subject, ctx.classifier, ctx.event);
    if (textMismatch) {
      this.log.info(`${this.pipelineId}: ${step.id ?? 'paso'} no corre — ${textMismatch}`);
      return { ran: false };
    }
    const run = await this.runDue(step, input, ctx, via, handleErrors);
    return 'paused' in run && run.paused ? { ran: true, paused: run.paused } : { ran: true };
  }

  @traced(stepTrace)
  private async runDue(
    step: Runnable,
    input: unknown,
    ctx: PipelineExecutionContext,
    _via: StepVia,
    handleErrors = true,
  ): Promise<StepRun> {
    let out: unknown;
    try {
      out = await step.run(ctx, input);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const handling = handleErrors ? this.errorHandling(step, ctx) : null;
      if (!handling && !step.continueOnError) throw err;
      if (!handling) return { error, handledBy: 'continueOnError' };
      if (step.id) ctx.steps[step.id] = { error: error.message };
      await this.runErrorRoute(handling.report, handling.route, error, ctx);
      return { error, handledBy: 'onError' };
    }
    const outcome = step.outcome(out);
    if (outcome.kind === 'pause') {
      return { output: outcome.pause.describe(), paused: outcome.pause };
    }
    if (step.id) ctx.steps[step.id] = out;
    if (outcome.kind === 'output') return { output: out };

    const exit = this.graph.resolve(step, ctx.defaults).exits.find((e) => e.name === outcome.exit);
    if (!exit) return { output: out };
    const { payload } = outcome;
    let paused = exit.report
      ? await this.run(exit.report, payload.report, ctx, `report:${exit.name}`)
      : undefined;
    for (const target of exit.targets) {
      paused =
        (await this.run(
          target,
          target.id ? payload[target.id] : undefined,
          ctx,
          `exit:${exit.name}`,
        )) ?? paused;
      if (paused) break;
    }
    return { output: out, exit: { exit, payload }, ...(paused ? { paused } : {}) };
  }

  /** El `onError` que aplica a un paso, y el `report` con el que se anuncia. Un paso que elige
   *  salidas usa su cascada completa; cualquier otro: el suyo > el de la pipeline > el del
   *  proyecto. */
  private errorHandling(
    step: Runnable,
    ctx: PipelineExecutionContext,
  ): { route: ErrorRoute; report: Runnable | null } | null {
    if (step.exitRoutes !== undefined) {
      const resolved = this.graph.resolve(step, ctx.defaults);
      return resolved.onError
        ? { route: resolved.onError.route, report: resolved.report?.target ?? null }
        : null;
    }
    const route = firstSet(step.onError, this.defaults.onError, ctx.defaults?.onError);
    if (!route) return null;
    return { route, report: firstSet(this.defaults.report, ctx.defaults?.report) ?? null };
  }

  private async runErrorRoute(
    report: Runnable | null,
    route: ErrorRoute,
    error: Error,
    ctx: PipelineExecutionContext,
  ): Promise<void> {
    const reportPaused =
      report && route.report
        ? await this.run(report, route.report(error), ctx, 'onError.report', false)
        : undefined;
    for (const target of routeTargets(route.to)) {
      // El `onError` del proyecto recién se conoce al correr: lo que el grafo no pudo validar.
      if ((await this.run(target, route.input?.(error), ctx, 'onError', false)) ?? reportPaused) {
        throw new Error(
          `Pipeline(${this.pipelineId}): un \`onError\` no puede pausar la ejecución`,
        );
      }
    }
  }
}

/** El primer valor definido, del nivel más específico al más general. `null` corta: "ninguno". */
function firstSet<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return null;
}
