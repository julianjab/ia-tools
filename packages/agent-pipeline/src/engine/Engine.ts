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
  pipelines: PipelineSource;
  maxEventDepth?: number;
}

export type DispatchOutcome = 'dispatched' | 'skipped';

/**
 * Dueño de despachar cada evento del bus contra el roster de Pipeline vivo. No sabe nada de
 * GitHub, Slack ni viajes — todo eso vive en cómo cada app traduce su mundo a `DomainEvent`
 * y en qué Agents registra. Esto es el harness; el dominio lo trae quien lo usa.
 */
export class Engine {
  private readonly bus: EventBus;
  private readonly pipelines: PipelineSource;
  private readonly maxEventDepth: number;

  constructor(opts: EngineOptions) {
    this.bus = opts.bus;
    this.pipelines = opts.pipelines;
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

    const pipelines = await this.pipelines.list();
    const matched = pipelines.filter((pipeline) => pipeline.matches(event));
    if (matched.length === 0) {
      this.traceMatch(event, pipelines, []);
      return 'skipped';
    }

    const winningExclusive = matched
      .filter((pipeline) => pipeline.exclusive)
      .sort((a, b) => a.position - b.position)[0];
    const toRun = winningExclusive
      ? matched.filter(
          (pipeline) =>
            pipeline === winningExclusive || pipeline.position < winningExclusive.position,
        )
      : matched;
    this.traceMatch(event, pipelines, toRun, winningExclusive);
    if (toRun.length === 0) return 'skipped';

    // `Promise.allSettled`, no `Promise.all`: los pipelines matcheados son independientes, así
    // que un fallo en uno no debe cortar a los demás a mitad de camino — y quien llamó
    // `dispatch` (o el `AggregateError` de `EventBus.publish`, vía `start()`) tiene que ver
    // TODOS los fallos, no sólo el primero que ganó la carrera.
    const results = await Promise.allSettled(
      toRun.map((pipeline) =>
        pipeline.execute({
          event,
          steps: {},
          bus: this.bus,
          pipelineId: pipeline.id,
          defaults: this.pipelines.defaults,
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
   * Qué corre y por qué no corre el resto: un span event `pipeline.match` por cada pipeline que
   * escucha este tipo de evento (las que escuchan otros tipos serían ruido), y un log con el
   * resumen. Es lo primero que se mira cuando "no pasó nada".
   */
  private traceMatch(
    event: DomainEvent<any>,
    pipelines: Pipeline[],
    toRun: Pipeline[],
    winningExclusive?: Pipeline,
  ): void {
    const span = trace.getActiveSpan();
    const skipped: string[] = [];
    for (const pipeline of pipelines.filter((p) => p.on.includes(event.type))) {
      const runs = toRun.includes(pipeline);
      const reason = runs
        ? undefined
        : (pipeline.explainMismatch(event) ?? `la tapa la exclusive "${winningExclusive?.id}"`);
      if (reason) skipped.push(`${pipeline.id} (${reason})`);
      span?.addEvent('pipeline.match', {
        'ia.pipeline.id': pipeline.id,
        'ia.pipeline.runs': runs,
        ...(reason ? { 'ia.pipeline.skip_reason': reason } : {}),
      });
    }
    span?.setAttribute(
      'ia.pipelines.run',
      toRun.map((pipeline) => pipeline.id),
    );
    emitLog(
      toRun.length > 0 ? 'info' : 'warn',
      toRun.length > 0
        ? `evento "${event.type}": corren ${toRun.map((p) => p.id).join(', ')}`
        : `evento "${event.type}": ninguna pipeline corre`,
      { 'ia.pipelines.skipped': skipped },
    );
  }
}
