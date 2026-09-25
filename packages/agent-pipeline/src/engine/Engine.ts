import type { DomainEvent } from '../events/DomainEvent.js';
import type { EventBus, Unsubscribe } from '../events/EventBus.js';
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
   */
  async dispatch(event: DomainEvent<any>): Promise<DispatchOutcome> {
    if (event.depth >= this.maxEventDepth) return 'skipped';

    const pipelines = await this.pipelines.list();
    const matched = pipelines.filter((pipeline) => pipeline.matches(event));
    if (matched.length === 0) return 'skipped';

    const winningExclusive = matched
      .filter((pipeline) => pipeline.exclusive)
      .sort((a, b) => a.position - b.position)[0];
    const toRun = winningExclusive
      ? matched.filter(
          (pipeline) =>
            pipeline === winningExclusive || pipeline.position < winningExclusive.position,
        )
      : matched;
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
}
