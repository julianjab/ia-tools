import {
  type SpanLink,
  captureSpanLink,
  createLogger,
  inFreshContext,
  tagged,
  taggedSync,
  traced,
} from '@ia-tools/telemetry';
import type { DomainEvent } from '../events/DomainEvent.js';
import type { EventBus, Unsubscribe } from '../events/EventBus.js';
import type { Pipeline } from '../pipeline/Pipeline.js';
import type { ExecutionHandle } from '../pipeline/Runnable.js';
import type { ExecutionStore, UnreadDelivery } from './Execution.js';
import type { PipelineSource } from './PipelineSource.js';
import { dispatchTrace, ifRunningTag, planTag, redeliverTrace } from './tracing.js';

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
export interface Candidate {
  pipeline: Pipeline;
  source: PipelineSource;
  /** Por qué no corre, si no corre por la fuente o por la propia pipeline. */
  mismatch?: string;
}

/**
 * Qué hizo el engine con una pipeline que matcheó, frente a la ejecución de su task:
 * - `direct`: no pasa por ejecuciones (sin `executions`, sin agentes o sin task).
 * - `nested`: nació dentro de la ejecución en curso — corre sin esperarla.
 * - `starts`: la task está libre, abre su ejecución.
 * - `waits`: la task está ocupada — corre cuando se libere (`ifRunning: wait`, o un `inject` sin
 *   agente de la regla en su loop).
 * - `injected`: se le entregó al agente que corre (`agentId`).
 * - `skipped`: la task está ocupada y la regla es `skip`.
 */
export interface Resolution {
  decision: 'direct' | 'nested' | 'starts' | 'waits' | 'injected' | 'skipped';
  /** La corrida a lanzar, salvo `injected`/`skipped`. */
  run?: () => Promise<unknown>;
  /** Corre sin que `dispatch` la espere (ver `runDetached`). */
  detach?: boolean;
  /** La ejecución con la que chocó: la que corre en la task, si ya arrancó. */
  executionId?: string;
  agentId?: string;
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
  /** El span del despacho que inyectó cada evento: si nadie lo lee, su re-despacho abre una
   *  traza nueva que lo cita (`redeliverTrace`). */
  private readonly origins = new WeakMap<DomainEvent<any>, SpanLink>();

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
    return this.runCandidates(toRun, event);
  }

  /** Corre las pipelines elegidas para `event`, resolviendo antes las que chocan con una
   *  ejecución en curso de su task (`ifRunning`). */
  private async runCandidates(
    toRun: Candidate[],
    event: DomainEvent<any>,
  ): Promise<DispatchOutcome> {
    if (toRun.length === 0) return 'skipped';

    const runs: Array<() => Promise<unknown>> = [];
    let injected = false;
    let detached = false;
    for (const candidate of toRun) {
      const { decision, run, detach } = this.resolveRunning(candidate, event);
      if (decision === 'injected') injected = true;
      if (!run) continue;
      if (detach) {
        detached = true;
        this.runDetached(run, event);
      } else runs.push(run);
    }
    if (runs.length === 0) return detached ? 'dispatched' : injected ? 'injected' : 'skipped';

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
   * Una corrida que no se espera: la de un evento nacido dentro de una ejecución que tiene que abrir
   * OTRA (otra task). `EmitAction` espera a `publish`, y `publish` a `dispatch`: si esperara acá a
   * que esa otra task tenga turno y lugar, la ejecución que lo emitió lo esperaría ocupando su
   * propio lugar — con el tope agotado, o con dos tasks que se emiten entre sí, nunca terminaría
   * ninguna. Sus errores van al log: nadie más los está esperando.
   */
  private runDetached(run: () => Promise<unknown>, event: DomainEvent<any>): void {
    run().catch((err: unknown) => {
      this.log.error(
        `"${event.type}" (lanzado desde ${event.executionId}) falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Qué hacer con una pipeline que matcheó (ver `Resolution`). Sincrónico a propósito: decide y
   * marca la task ocupada sin ceder el turno, así otro despacho no la ve libre a medias. Lo que
   * decidió queda en la traza del evento (`ifRunningTag`).
   *
   * Sólo las pipelines con agentes, en un engine con `executions` y un evento con task, pasan
   * por las ejecuciones — el resto corre como siempre. Un evento que nació ADENTRO de la
   * ejecución en curso (un `EmitAction` suyo) corre sin esperarla: sería esperarse a sí misma.
   */
  @taggedSync(ifRunningTag)
  private resolveRunning(candidate: Candidate, event: DomainEvent<any>): Resolution {
    const { pipeline } = candidate;
    const executions = this.executions;
    const key = executions && pipeline.runsAgents ? this.executionKey(event) : undefined;
    const direct = () => this.execute(candidate, event);
    if (!executions || key === undefined) return { decision: 'direct', run: direct };

    const current = executions.current(key);
    const executionId = current?.id;
    if (current && event.executionId === current.id) {
      return { decision: 'nested', run: direct, executionId };
    }

    // `inject` sólo le habla a un agente de ESTA regla que esté en su loop con el modelo: entre
    // pasos, o si corre otro agente, no hay quién lo lea — espera como `wait`.
    const active = current?.activeAgent;
    if (pipeline.ifRunning === 'inject' && active && pipeline.agentIds.includes(active)) {
      current.deliver(this.formatMessage(event), event, pipeline.id);
      const origin = captureSpanLink();
      if (origin) this.origins.set(event, origin);
      return { decision: 'injected', executionId, agentId: active };
    }
    const busy = executions.busy(key);
    if (pipeline.ifRunning === 'skip' && busy) return { decision: 'skipped', executionId };

    const run = async () => {
      const execution = await executions.start({
        key,
        pipelineId: pipeline.id,
        agentIds: pipeline.agentIds,
      });
      this.log.info(
        `${execution.id} abre: ${pipeline.id}${execution.waitedMs > 0 ? ` (esperó ${execution.waitedMs} ms)` : ''}`,
        { 'ia.execution.id': execution.id, 'ia.execution.wait_ms': execution.waitedMs },
      );
      let status: 'done' | 'failed' = 'done';
      try {
        return await this.execute(candidate, event, execution);
      } catch (err) {
        status = 'failed';
        throw err;
      } finally {
        const unread = execution.unread();
        executions.finish(execution, status);
        this.log[status === 'failed' ? 'warn' : 'info'](`${execution.id} cierra: ${status}`, {
          'ia.execution.id': execution.id,
          'ia.execution.duration_ms': Date.now() - Date.parse(execution.startedAt),
        });
        this.redispatch(unread, execution.id);
      }
    };
    return {
      decision: busy ? 'waits' : 'starts',
      run,
      // Nacido dentro de OTRA ejecución (hacia esta task): no se espera, ver `runDetached`.
      detach: event.executionId !== undefined,
      ...(executionId ? { executionId } : {}),
    };
  }

  /**
   * Lo que se le entregó a una ejecución y ningún agente llegó a leer (llegó después de su última
   * vuelta) vuelve a despacharse al cerrarla, SÓLO contra la regla que lo había inyectado — las
   * demás que matchearon ese evento ya corrieron con él. Ya sin nada corriendo, esa regla arranca
   * normal. Así un `inject` nunca pierde un evento.
   *
   * Corre en una traza nueva (no es parte de la corrida que cierra) que cita la del despacho que
   * lo inyectó: desde el evento se llega a lo que terminó causando.
   */
  private redispatch(unread: UnreadDelivery[], executionId: string): void {
    for (const { event, pipelineId } of unread) {
      this.log.info(`evento "${event.type}" sin leer en ${executionId}: se vuelve a despachar`, {
        'ia.execution.id': executionId,
      });
      const origin = this.origins.get(event);
      // El error ya lo logueó `@traced` adentro de su span; acá sólo no queda sin manejar.
      inFreshContext(() => this.redeliver(event, pipelineId, executionId, origin)).catch(() => {});
    }
  }

  @traced(redeliverTrace)
  private async redeliver(
    event: DomainEvent<any>,
    pipelineId: string,
    _executionId: string,
    _origin: SpanLink | undefined,
  ): Promise<DispatchOutcome> {
    const { toRun } = await this.plan(event);
    return this.runCandidates(
      toRun.filter((candidate) => candidate.pipeline.id === pipelineId),
      event,
    );
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
