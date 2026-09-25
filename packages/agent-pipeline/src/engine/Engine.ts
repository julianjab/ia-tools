import { trace } from '@opentelemetry/api';
import type { DomainEvent } from '../events/DomainEvent.js';
import type { EventBus, Unsubscribe } from '../events/EventBus.js';
import type { Pipeline } from '../pipeline/Pipeline.js';
import {
  SpanKind,
  emitLog,
  scopeAttributes,
  withInheritedAttributes,
  withSpan,
} from '../telemetry/telemetry.js';
import type { PipelineSource } from './PipelineSource.js';

/** Tope de la cadena de derivación de eventos (EmitAction, Agent.emitOn). Sin esto un
 *  Pipeline que se re-emite a sí mismo —directo o vía un ciclo de N pipelines— no tiene fondo. */
export const DEFAULT_MAX_EVENT_DEPTH = 10;

export interface EngineOptions {
  bus: EventBus;
  /** Una fuente, o varias (ej. un `Project` por proyecto): cada una con su propio `when` y sus
   *  defaults. La prioridad `exclusive`/`position` se decide entre TODAS. */
  pipelines: PipelineSource | PipelineSource[];
  maxEventDepth?: number;
}

export type DispatchOutcome = 'dispatched' | 'skipped';

/** Una pipeline con la fuente de la que salió — sus defaults son los de ESA fuente. */
interface Candidate {
  pipeline: Pipeline;
  source: PipelineSource;
  /** Por qué no corre, si no corre por la fuente o por la propia pipeline. */
  mismatch?: string;
}

/** Qué corre para un evento, y lo necesario para explicar por qué no corre el resto. */
interface DispatchPlan {
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
  private readonly bus: EventBus;
  private readonly sources: PipelineSource[];
  private readonly maxEventDepth: number;

  constructor(opts: EngineOptions) {
    this.bus = opts.bus;
    this.sources = [opts.pipelines].flat();
    this.maxEventDepth = opts.maxEventDepth ?? DEFAULT_MAX_EVENT_DEPTH;
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
   *
   * Cada llamada abre el span `event <type>`: la raíz de la traza de TODO lo que el evento causa
   * (o un hijo, si lo publicó un paso de otra pipeline). Su scope queda heredado como atributos
   * `ia.<clave>` en cada span y log de abajo — ver `telemetry/telemetry.ts`.
   */
  async dispatch(event: DomainEvent<any>): Promise<DispatchOutcome> {
    const attributes = {
      ...scopeAttributes(event.scope),
      'ia.event.type': event.type,
      'ia.event.depth': event.depth,
    };
    return withInheritedAttributes(attributes, () =>
      withSpan(
        `event ${event.type}`,
        { 'ia.event.occurred_at': event.occurredAt },
        async (span) => {
          const outcome = await this.dispatchTraced(event);
          span.setAttribute('ia.dispatch.outcome', outcome);
          return outcome;
        },
        { kind: SpanKind.CONSUMER },
      ),
    );
  }

  private async dispatchTraced(event: DomainEvent<any>): Promise<DispatchOutcome> {
    if (event.depth >= this.maxEventDepth) {
      emitLog(
        'warn',
        `evento "${event.type}" descartado: profundidad ${event.depth} ≥ ${this.maxEventDepth}`,
      );
      return 'skipped';
    }

    const plan = await this.plan(event);
    this.traceMatch(event, plan);
    const { toRun } = plan;
    if (toRun.length === 0) return 'skipped';

    // `Promise.allSettled`, no `Promise.all`: los pipelines matcheados son independientes, así
    // que un fallo en uno no debe cortar a los demás a mitad de camino — y quien llamó
    // `dispatch` (o el `AggregateError` de `EventBus.publish`, vía `start()`) tiene que ver
    // TODOS los fallos, no sólo el primero que ganó la carrera.
    const results = await Promise.allSettled(
      toRun.map(({ pipeline, source }) =>
        pipeline.execute({
          event,
          steps: {},
          bus: this.bus,
          pipelineId: pipeline.id,
          defaults: source.defaults,
        }),
      ),
    );
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
   * Las pipelines que corren para `event`, en el mismo orden y con el mismo criterio que
   * `dispatch` — sin correrlas. Para previsualizar (un dry-run, un test) sin duplicar la cascada.
   */
  async select(event: DomainEvent<any>): Promise<Pipeline[]> {
    return (await this.plan(event)).toRun.map(({ pipeline }) => pipeline);
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

  /**
   * Qué corre y por qué no corre el resto: un span event `pipeline.match` por cada pipeline que
   * escucha este tipo de evento (las que escuchan otros tipos serían ruido), y un log con el
   * resumen. Es lo primero que se mira cuando "no pasó nada".
   */
  private traceMatch(event: DomainEvent<any>, plan: DispatchPlan): void {
    const span = trace.getActiveSpan();
    const skipped: string[] = [];
    const running = new Set(plan.toRun.map(({ pipeline }) => pipeline));
    for (const { pipeline, mismatch } of plan.candidates) {
      if (!pipeline.on.includes(event.type)) continue;
      const runs = running.has(pipeline);
      const reason = runs
        ? undefined
        : (mismatch ?? `la tapa la exclusive "${plan.winningExclusive?.id}"`);
      if (reason) skipped.push(`${pipeline.id} (${reason})`);
      span?.addEvent('pipeline.match', {
        'ia.pipeline.id': pipeline.id,
        'ia.pipeline.runs': runs,
        ...(reason ? { 'ia.pipeline.skip_reason': reason } : {}),
      });
    }
    const ran = [...running].map((pipeline) => pipeline.id);
    span?.setAttribute('ia.pipelines.run', ran);
    emitLog(
      ran.length > 0 ? 'info' : 'warn',
      ran.length > 0
        ? `evento "${event.type}": corren ${ran.join(', ')}`
        : `evento "${event.type}": ninguna pipeline corre`,
      { 'ia.pipelines.skipped': skipped },
    );
  }
}
