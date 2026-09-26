import { createLogger, tagged, traced } from '@ia-tools/telemetry';
import type { DomainEvent } from '../events/DomainEvent.js';
import type { EventBus, Unsubscribe } from '../events/EventBus.js';
import type { Pipeline } from '../pipeline/Pipeline.js';
import type { ExecutionHandle } from '../pipeline/Runnable.js';
import type { ExecutionStore } from './Execution.js';
import type { PipelineSource } from './PipelineSource.js';
import { dispatchTrace, planTag } from './tracing.js';

/** Tope de la cadena de derivación de eventos (EmitAction, Agent.emitOn). Sin esto un
 *  Pipeline que se re-emite a sí mismo —directo o vía un ciclo de N pipelines— no tiene fondo. */
export const DEFAULT_MAX_EVENT_DEPTH = 10;

export interface EngineOptions {
  bus: EventBus;
  /** Una fuente, o varias (ej. un `Project` por proyecto): cada una con su propio `when` y sus
   *  defaults. La prioridad `exclusive`/`position` se decide entre TODAS. */
  pipelines: PipelineSource | PipelineSource[];
  maxEventDepth?: number;
  /**
   * Con esto, cada corrida de una pipeline con agentes es una EJECUCIÓN de la task del evento:
   * una task nunca corre dos a la vez, y un evento para una task con una ejecución en curso se
   * resuelve con el `ifRunning` de la pipeline (esperar, inyectárselo o descartarlo). Sin esto,
   * el comportamiento es el de siempre: todo lo que matchea corre en paralelo.
   */
  executions?: ExecutionStore;
  /** A qué task pertenece un evento. Default: el `scope` del evento (sin scope, no hay task y no
   *  hay ejecución). */
  executionKey?: (event: DomainEvent<any>) => string | undefined;
  /** Cómo se lee un evento inyectado en la conversación del agente. Default: tipo + payload. */
  formatMessage?: (event: DomainEvent<any>) => string;
}

/** `injected`: nada arrancó, pero el evento le llegó a una ejecución en curso. */
export type DispatchOutcome = 'dispatched' | 'injected' | 'skipped';

/** La task de un evento: su `scope` con las claves ordenadas — dos eventos de la misma task
 *  dan la misma clave aunque el scope se haya armado en otro orden. */
export function scopeExecutionKey(event: DomainEvent<any>): string | undefined {
  const scope = event.scope ?? {};
  const keys = Object.keys(scope).sort();
  if (keys.length === 0) return undefined;
  return JSON.stringify(keys.map((key) => [key, scope[key]]));
}

function defaultMessage(event: DomainEvent<any>): string {
  return `Evento ${event.type}: ${JSON.stringify(event.payload)}`;
}

/** Una pipeline con la fuente de la que salió — sus defaults son los de ESA fuente. */
interface Candidate {
  pipeline: Pipeline;
  source: PipelineSource;
  /** Por qué no corre, si no corre por la fuente o por la propia pipeline. */
  mismatch?: string;
}

/** Qué corre para un evento, y lo necesario para explicar por qué no corre el resto. */
export interface DispatchPlan {
  candidates: Candidate[];
  toRun: Candidate[];
  winningExclusive?: Pipeline;
}

/**
 * Dueño de despachar cada evento del bus contra el roster de Pipeline vivo. No sabe nada de
 * GitHub, Slack ni viajes — todo eso vive en cómo cada app traduce su mundo a `DomainEvent`
 * y en qué Agents registra. Esto es el harness; el dominio lo trae quien lo usa.
 */
export class Engine {
  readonly log = createLogger('agent-pipeline.engine');
  private readonly bus: EventBus;
  private readonly sources: PipelineSource[];
  readonly maxEventDepth: number;
  readonly executions?: ExecutionStore;
  private readonly executionKey: (event: DomainEvent<any>) => string | undefined;
  private readonly formatMessage: (event: DomainEvent<any>) => string;

  constructor(opts: EngineOptions) {
    this.bus = opts.bus;
    this.sources = [opts.pipelines].flat();
    this.maxEventDepth = opts.maxEventDepth ?? DEFAULT_MAX_EVENT_DEPTH;
    this.executions = opts.executions;
    this.executionKey = opts.executionKey ?? scopeExecutionKey;
    this.formatMessage = opts.formatMessage ?? defaultMessage;
  }

  /**
   * Suscribe el Engine a todo el bus. Llamalo una vez al bootear la app.
   *
   * A diferencia de una llamada directa a `dispatch`, acá no hay quien reciba la promesa —
   * por eso SE LA DEVOLVEMOS al handler en vez de descartarla con `void`: `EventBus.publish`
   * la junta con las de los demás handlers vía `Promise.allSettled` y agrupa cualquier
   * rechazo en un `AggregateError` que sí llega a quien llamó `publish`. Descartarla acá
   * (como hacía la versión anterior) dejaba un unhandled rejection cada vez que un `Agent`
   * con `provider` desconocido o un `HttpAction` con respuesta no-2xx tiraban — en Node eso
   * termina el proceso.
   */
  start(): Unsubscribe {
    return this.bus.subscribe('*', (event) => this.dispatch(event));
  }

  /**
   * Evalúa los Pipelines contra `event` y corre los que matchean: TODAS las no-exclusive
   * matcheadas en paralelo (son independientes); si alguna matcheada es `exclusive`, en
   * cambio corre SÓLO la de mayor prioridad (menor `position`) entre las exclusive — MÁS
   * cualquier pipeline (exclusive o no) de prioridad todavía mayor que esa (position aún
   * menor), que no queda bloqueada por una exclusive de menor prioridad que ella misma.
   */
  @traced(dispatchTrace)
  async dispatch(event: DomainEvent<any>): Promise<DispatchOutcome> {
    if (event.depth >= this.maxEventDepth) return 'skipped';

    const { toRun } = await this.decide(event);
    if (toRun.length === 0) return 'skipped';

    const runs: Array<() => Promise<unknown>> = [];
    let injected = false;
    for (const candidate of toRun) {
      const next = this.resolveRunning(candidate, event);
      if (next === 'injected') injected = true;
      else if (next) runs.push(next);
    }
    if (runs.length === 0) return injected ? 'injected' : 'skipped';

    // `Promise.allSettled`, no `Promise.all`: los pipelines matcheados son independientes, así
    // que un fallo en uno no debe cortar a los demás a mitad de camino — y quien llamó
    // `dispatch` (o el `AggregateError` de `EventBus.publish`, vía `start()`) tiene que ver
    // TODOS los fallos, no sólo el primero que ganó la carrera.
    const results = await Promise.allSettled(runs.map((run) => run()));
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `${failures.length} pipeline(s) failed for event "${event.type}"`,
      );
    }
    return 'dispatched';
  }

  /**
   * Qué hacer con una pipeline que matcheó: correrla (la corrida a lanzar), o nada porque el
   * evento se le entregó al agente que corre en su task (`injected`) o se descartó (`null`).
   *
   * Sólo las pipelines con agentes, en un engine con `executions` y un evento con task, pasan
   * por acá — el resto corre como siempre. Un evento que nació ADENTRO de la ejecución en curso
   * (un `EmitAction` suyo) corre sin esperarla: sería esperarse a sí misma.
   */
  private resolveRunning(
    candidate: Candidate,
    event: DomainEvent<any>,
  ): (() => Promise<unknown>) | 'injected' | null {
    const { pipeline } = candidate;
    const executions = this.executions;
    const key = executions && pipeline.runsAgents ? this.executionKey(event) : undefined;
    if (!executions || key === undefined) return () => this.execute(candidate, event);

    const current = executions.current(key);
    if (current && event.executionId === current.id) return () => this.execute(candidate, event);

    // `inject` sólo le habla a un agente de ESTA regla que esté en su loop con el modelo: entre
    // pasos, o si corre otro agente, no hay quién lo lea — espera como `wait`.
    const active = current?.activeAgent;
    if (pipeline.ifRunning === 'inject' && active && pipeline.agentIds.includes(active)) {
      current.deliver(this.formatMessage(event), event);
      this.log.info(`evento "${event.type}" inyectado a ${active} (${current.id})`, {
        'ia.execution.id': current.id,
        'ia.pipeline.id': pipeline.id,
      });
      return 'injected';
    }
    if (pipeline.ifRunning === 'skip' && executions.busy(key)) {
      this.log.info(`evento "${event.type}" descartado: la task está ocupada`, {
        'ia.pipeline.id': pipeline.id,
      });
      return null;
    }
    return async () => {
      const execution = await executions.start({
        key,
        pipelineId: pipeline.id,
        agentIds: pipeline.agentIds,
      });
      let status: 'done' | 'failed' = 'done';
      try {
        return await this.execute(candidate, event, execution);
      } catch (err) {
        status = 'failed';
        throw err;
      } finally {
        const unread = execution.unread();
        executions.finish(execution, status);
        this.redispatch(unread, execution.id);
      }
    };
  }

  /**
   * Lo que se le entregó a una ejecución y ningún agente llegó a leer (llegó después de su última
   * vuelta) vuelve a despacharse al cerrarla: ya sin nada corriendo, su regla arranca normal. Así
   * un `inject` nunca pierde un evento.
   */
  private redispatch(events: DomainEvent<any>[], executionId: string): void {
    for (const event of events) {
      this.log.info(`evento "${event.type}" sin leer en ${executionId}: se vuelve a despachar`);
      this.dispatch(event).catch((err: unknown) => {
        this.log.error(
          `re-despacho de "${event.type}" falló: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  private execute(
    { pipeline, source }: Candidate,
    event: DomainEvent<any>,
    execution?: ExecutionHandle,
  ): Promise<Record<string, unknown>> {
    return pipeline.execute({
      event,
      steps: {},
      bus: this.bus,
      pipelineId: pipeline.id,
      defaults: source.defaults,
      ...(execution ? { execution } : {}),
    });
  }

  /**
   * Las pipelines que corren para `event`, en el mismo orden y con el mismo criterio que
   * `dispatch` — sin correrlas. Para previsualizar (un dry-run, un test) sin duplicar la cascada.
   */
  async select(event: DomainEvent<any>): Promise<Pipeline[]> {
    return (await this.plan(event)).toRun.map(({ pipeline }) => pipeline);
  }

  /** El `plan` con el que `dispatch` se compromete — a diferencia de `select`, queda en la traza. */
  @tagged(planTag)
  private async decide(event: DomainEvent<any>): Promise<DispatchPlan> {
    return this.plan(event);
  }

  /**
   * La cascada de filtros: primero el `when` de cada fuente (el proyecto) — si no pasa, ninguna
   * de sus pipelines se evalúa —, después cada pipeline (`on`, scope, `when`). Entre las que
   * pasan, corren TODAS las no-exclusive; si alguna es `exclusive`, sólo la de mayor prioridad
   * (menor `position`) entre las exclusive, MÁS cualquier otra de prioridad todavía mayor. El
   * `when` de cada paso se evalúa después, al correr la pipeline.
   */
  private async plan(event: DomainEvent<any>): Promise<DispatchPlan> {
    const candidates: Candidate[] = [];
    for (const source of this.sources) {
      const sourceMismatch = source.explainMismatch?.(event);
      for (const pipeline of await source.list()) {
        const mismatch = sourceMismatch ?? pipeline.explainMismatch(event);
        candidates.push({ pipeline, source, ...(mismatch ? { mismatch } : {}) });
      }
    }
    const matched = candidates.filter((candidate) => !candidate.mismatch);
    const winningExclusive = matched
      .map(({ pipeline }) => pipeline)
      .filter((pipeline) => pipeline.exclusive)
      .sort((a, b) => a.position - b.position)[0];
    const toRun = winningExclusive
      ? matched.filter(
          ({ pipeline }) =>
            pipeline === winningExclusive || pipeline.position < winningExclusive.position,
        )
      : matched;
    return { candidates, toRun, winningExclusive };
  }
}
