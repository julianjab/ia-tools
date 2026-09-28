import {
  type SpanLink,
  captureSpanLink,
  createLogger,
  inFreshContext,
  tagged,
  taggedSync,
  traced,
} from '@ia-tools/telemetry';
import { type DomainEvent, createEvent } from '../events/DomainEvent.js';
import type { EventBus, Unsubscribe } from '../events/EventBus.js';
import type { Checkpoint, Pipeline } from '../pipeline/Pipeline.js';
import type { ExecutionHandle } from '../pipeline/Runnable.js';
import type { Execution, ExecutionStore, Wake } from './Execution.js';
import type { PipelineSource } from './PipelineSource.js';
import {
  dispatchTrace,
  expireTrace,
  ifRunningTag,
  offerTag,
  planTag,
  redeliverTrace,
} from './tracing.js';

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
   * una task nunca corre dos a la vez, y un evento para una task con una ejecución en curso se le
   * ofrece primero a su paso activo (`injects` del agente) — o, si está pausada, a su pausa, que
   * la reanuda si es un evento que espera. Si no, cada regla decide con su `ifRunning` (esperar o
   * descartarlo). Sin esto, el comportamiento es el de siempre: todo lo que matchea corre en
   * paralelo, y una `PauseAction` falla.
   */
  executions?: ExecutionStore;
  /** A qué task pertenece un evento. Default: el `scope` del evento (sin scope, no hay task y no
   *  hay ejecución). */
  executionKey?: (event: DomainEvent<any>) => string | undefined;
  /** Cómo se lee un evento inyectado en la conversación del agente. Default: tipo + payload. */
  formatMessage?: (event: DomainEvent<any>) => string;
}

/** `injected`: nada arrancó, pero el evento le llegó al paso activo de una ejecución en curso.
 *  `resumed`: reanudó una ejecución pausada de su task (y no arrancó nada más). */
export type DispatchOutcome = 'dispatched' | 'injected' | 'resumed' | 'skipped';

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

/** Lo que pasó al ofrecerle el evento a la ejecución de su task: se le entregó a su paso activo,
 *  o despertó su pausa (con la corrida que la reanuda). */
export type Offer =
  | { kind: 'injected'; executionId: string; stepId?: string }
  | {
      kind: 'resumed';
      executionId: string;
      branch: string;
      run: () => Promise<unknown>;
      detach: boolean;
    };

/**
 * Qué hizo el engine con una pipeline que matcheó, frente a la ejecución de su task:
 * - `direct`: no pasa por ejecuciones (sin `executions`, sin agentes o sin task).
 * - `nested`: nació dentro de la ejecución en curso — corre sin esperarla.
 * - `starts`: la task está libre, abre su ejecución.
 * - `waits`: la task está ocupada — corre cuando se libere (`ifRunning: wait`).
 * - `injected`: no corre — el evento ya lo recibió el paso activo de la task (`agentId`).
 * - `resumed`: no corre — el evento reanudó la ejecución pausada de la task.
 * - `skipped`: la task está ocupada y la regla es `skip`.
 */
export interface Resolution {
  decision: 'direct' | 'nested' | 'starts' | 'waits' | 'injected' | 'resumed' | 'skipped';
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

    // Primero la ejecución de su task. Si corre y su paso activo acepta el evento, ya lo
    // recibió — antes de ceder el turno, así el paso no sale de su loop en el medio.
    const injected = this.inject(event);
    const { toRun } = await this.decide(event);
    // Si está pausada y el evento la despierta, se reanuda — recién acá, pegado a lanzar la
    // corrida: despertarla antes de `decide` dejaría una ejecución despierta sin quién la corra
    // si `decide` falla.
    const offer = injected ?? this.wake(event);
    return this.runCandidates(toRun, event, offer);
  }

  /**
   * Las pausas vencidas se reanudan por su rama `timeout`, con un evento `execution.expired`. La
   * app lo llama cada tanto (ej. cada minuto): el engine no tiene reloj propio.
   */
  tick(now = Date.now()): void {
    for (const execution of this.executions?.paused() ?? []) {
      // Con una corrida ya en cola sobre la task, la pausa no vence: esa corrida la reemplaza.
      if (!execution.expired(now) || this.executions?.busy(execution.key)) continue;
      // El error ya lo logueó `@traced` adentro de su span; acá sólo no queda sin manejar.
      inFreshContext(() => this.expire(execution)).catch(() => {});
    }
  }

  /**
   * Le ofrece `event` al paso activo de la ejecución en curso de su task (`Execution.inject`,
   * que le pregunta al paso con `accepts`). Un evento que nació en esa misma ejecución no se le
   * ofrece: sería mandarse un mensaje a sí misma.
   */
  @taggedSync(offerTag)
  private inject(event: DomainEvent<any>): Offer | undefined {
    const current = this.currentFor(event);
    if (current?.status !== 'running') return undefined;
    if (!current.inject(this.formatMessage(event), event)) return undefined;
    const origin = captureSpanLink();
    if (origin) this.origins.set(event, origin);
    return {
      kind: 'injected',
      executionId: current.id,
      ...(current.active?.id ? { stepId: current.active.id } : {}),
    };
  }

  /**
   * Si la ejecución de la task está pausada y `event` pasa una de sus ramas, la despierta
   * (`Execution.wake`) y devuelve la corrida que la reanuda. No la despierta si ya hay una corrida
   * en cola sobre la task (`busy`): esa corrida la va a reemplazar, y reanudarla después sería
   * seguir desde un checkpoint viejo.
   */
  @taggedSync(offerTag)
  private wake(event: DomainEvent<any>): Offer | undefined {
    const current = this.currentFor(event);
    if (current?.status !== 'paused' || this.executions?.busy(current.key)) return undefined;
    const wake = current.wake(event);
    return wake ? this.resumption(current, wake, event) : undefined;
  }

  /** La ejecución de la task de `event`, salvo que el evento haya nacido en ella. */
  private currentFor(event: DomainEvent<any>): Execution | undefined {
    const key = this.executions ? this.executionKey(event) : undefined;
    const current = key === undefined ? undefined : this.executions?.current(key);
    return current && !current.owns(event) ? current : undefined;
  }

  /**
   * La corrida que reanuda una ejecución que despertó. Le pide lugar al store YA (ocupa la task en
   * este tick); la corrida sigue la pipeline desde su checkpoint por la rama que la despertó.
   */
  private resumption(
    execution: Execution,
    wake: Wake,
    event: DomainEvent<any>,
  ): Extract<Offer, { kind: 'resumed' }> {
    const admitted = (this.executions as ExecutionStore).resume(execution);
    const run = async () => {
      await admitted;
      try {
        return await execution.run(() => this.continue(execution, wake, event));
      } finally {
        this.redispatch(execution.takeUnread(), execution.id);
        this.wakeLate(execution);
      }
    };
    return {
      kind: 'resumed',
      executionId: execution.id,
      branch: wake.branch,
      run,
      // Nacido dentro de OTRA ejecución: no se espera, ver `runDetached`.
      detach: event.executionId !== undefined,
    };
  }

  /** Sigue la pipeline de `execution` desde su checkpoint, por la rama que la despertó. */
  private async continue(
    execution: Execution,
    { checkpoint, branch }: Wake,
    event: DomainEvent<any>,
  ): Promise<Record<string, unknown>> {
    const { pipeline, source } = await this.findCandidate(checkpoint);
    return pipeline.execute(
      {
        event,
        steps: {},
        bus: this.bus,
        pipelineId: pipeline.id,
        defaults: source.defaults,
        ...(source.id !== undefined ? { sourceId: source.id } : {}),
        execution,
      },
      { checkpoint, branch },
    );
  }

  @traced(expireTrace)
  private async expire(execution: Execution): Promise<DispatchOutcome> {
    if (this.executions?.busy(execution.key)) return 'skipped';
    const wake = execution.wakeOnTimeout();
    if (!wake) return 'skipped';
    const event = createEvent(
      'execution.expired',
      { executionId: execution.id, pauseId: wake.checkpoint.pauseId },
      wake.checkpoint.scope ? { scope: wake.checkpoint.scope } : {},
    );
    await this.resumption(execution, wake, event).run();
    return 'resumed';
  }

  /** Corre las pipelines elegidas para `event`, resolviendo antes las que chocan con una
   *  ejecución en curso de su task (`resolveRunning`) — y la reanudación, si el evento despertó
   *  una pausa. */
  private async runCandidates(
    toRun: Candidate[],
    event: DomainEvent<any>,
    offer?: Offer,
  ): Promise<DispatchOutcome> {
    const runs: Array<() => Promise<unknown>> = [];
    const launch = (run: () => Promise<unknown>, detach: boolean) => {
      if (detach) this.runDetached(run, event);
      else runs.push(run);
    };
    if (offer?.kind === 'resumed') launch(offer.run, offer.detach);
    let others = false;
    for (const candidate of toRun) {
      const { run, detach } = this.resolveRunning(candidate, event, offer);
      if (!run) continue;
      others = true;
      launch(run, detach ?? false);
    }
    // Sin otras corridas, el resultado es lo que pasó con la ejecución de la task (o nada).
    const quiet = offer ? offer.kind : 'skipped';
    if (runs.length === 0) return others ? 'dispatched' : quiet;
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
    return others ? 'dispatched' : quiet;
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
   * por las ejecuciones — el resto (reacciones sin agentes) corre como siempre, aunque el evento
   * se haya inyectado.
   */
  @taggedSync(ifRunningTag)
  private resolveRunning(candidate: Candidate, event: DomainEvent<any>, offer?: Offer): Resolution {
    const { pipeline } = candidate;
    const executions = this.executions;
    const key = executions && pipeline.needsExecution ? this.executionKey(event) : undefined;
    const direct = () => this.execute(candidate, event);
    if (!executions || key === undefined) return { decision: 'direct', run: direct };

    // La ejecución de la task ya lo recibió (su paso activo, o reanudándose): otra corrida de
    // agentes sobre la misma task sería hacer el trabajo dos veces.
    if (offer) {
      return {
        decision: offer.kind,
        executionId: offer.executionId,
        ...(offer.kind === 'injected' && offer.stepId ? { agentId: offer.stepId } : {}),
      };
    }
    const current = executions.current(key);
    const executionId = current?.id;
    if (current?.owns(event)) return { decision: 'nested', run: direct, executionId };

    const busy = executions.busy(key);
    if (pipeline.ifRunning === 'skip' && busy) return { decision: 'skipped', executionId };

    const run = async () => {
      const execution = await executions.start({ key, pipelineId: pipeline.id });
      try {
        return await execution.run(() => this.execute(candidate, event, execution));
      } finally {
        this.redispatch(execution.takeUnread(), execution.id);
        this.wakeLate(execution);
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
   * Lo que se le inyectó a una ejecución y ningún agente llegó a leer (llegó después de su última
   * vuelta) vuelve a despacharse al cerrarla o pausarla (si la despierta, reanuda su pausa) — contra las reglas CON agentes: las reacciones sin
   * agentes ya corrieron con él la primera vez. Ya sin nada corriendo, arranca normal. Así un
   * evento inyectado nunca se pierde.
   *
   * Corre en una traza nueva (no es parte de la corrida que cierra) que cita la del despacho que
   * lo inyectó: desde el evento se llega a lo que terminó causando.
   */
  private redispatch(unread: DomainEvent<any>[], executionId: string): void {
    for (const event of unread) {
      this.log.info(`evento "${event.type}" sin leer en ${executionId}: se vuelve a despachar`, {
        'ia.execution.id': executionId,
      });
      const origin = this.origins.get(event);
      // El error ya lo logueó `@traced` adentro de su span; acá sólo no queda sin manejar.
      inFreshContext(() => this.redeliver(event, executionId, origin)).catch(() => {});
    }
  }

  /**
   * Un evento que llegó mientras la ejecución corría —sin que ningún paso lo aceptara— y que la
   * pausa en la que terminó está esperando: sin esto se perdería (llegó antes de que hubiera
   * pausa que despertar). No vuelve a pasar por las reglas: ya pasó cuando llegó.
   */
  private wakeLate(execution: Execution): void {
    const event = execution.takeMissedWake();
    if (!event) return;
    const offer = this.wake(event);
    if (offer?.kind === 'resumed') this.runDetached(offer.run, event);
  }

  @traced(redeliverTrace)
  private async redeliver(
    event: DomainEvent<any>,
    _executionId: string,
    _origin: SpanLink | undefined,
  ): Promise<DispatchOutcome> {
    const { toRun } = await this.plan(event);
    // Si la ejecución que lo dejó sin leer se pausó esperando justo este evento, lo recibe su
    // pausa — igual que en `dispatch`.
    return this.runCandidates(
      toRun.filter((candidate) => candidate.pipeline.needsExecution),
      event,
      this.wake(event),
    );
  }

  /** La pipeline con ese id y su fuente — para reanudar una ejecución pausada. */
  /** La pipeline de un checkpoint, en SU fuente: dos proyectos pueden tener una pipeline con el
   *  mismo id. Sin id de fuente, sólo si no es ambigua. */
  private async findCandidate({ pipelineId, sourceId }: Checkpoint): Promise<Candidate> {
    const found: Candidate[] = [];
    for (const source of this.sources) {
      if (sourceId !== undefined && source.id !== sourceId) continue;
      for (const pipeline of await source.list()) {
        if (pipeline.id === pipelineId) found.push({ pipeline, source });
      }
    }
    const where = sourceId !== undefined ? ` en "${sourceId}"` : '';
    if (found.length === 0)
      throw new Error(`no hay una pipeline "${pipelineId}"${where} para reanudar`);
    if (found.length > 1) {
      throw new Error(
        `hay ${found.length} pipelines "${pipelineId}" y la pausa no dice de qué fuente es`,
      );
    }
    return found[0] as Candidate;
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
      ...(source.id !== undefined ? { sourceId: source.id } : {}),
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
