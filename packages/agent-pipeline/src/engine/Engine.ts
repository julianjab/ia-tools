import type { AgentSource } from '../agent/AgentRegistry.js';
import type { DomainEvent } from '../events/DomainEvent.js';
import type { EventBus, Unsubscribe } from '../events/EventBus.js';
import type { PipelineSource } from './PipelineSource.js';

/** Tope de la cadena de derivación de eventos (EmitAction, AgentAction.emitOn). Sin esto un
 *  Pipeline que se re-emite a sí mismo —directo o vía un ciclo de N pipelines— no tiene fondo. */
export const DEFAULT_MAX_EVENT_DEPTH = 10;

export interface EngineOptions {
  bus: EventBus;
  pipelines: PipelineSource;
  agents: AgentSource;
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
  private readonly agents: AgentSource;
  private readonly maxEventDepth: number;

  constructor(opts: EngineOptions) {
    this.bus = opts.bus;
    this.pipelines = opts.pipelines;
    this.agents = opts.agents;
    this.maxEventDepth = opts.maxEventDepth ?? DEFAULT_MAX_EVENT_DEPTH;
  }

  /** Suscribe el Engine a todo el bus. Llamalo una vez al bootear la app. */
  start(): Unsubscribe {
    return this.bus.subscribe('*', (event) => {
      void this.dispatch(event);
    });
  }

  /**
   * Evalúa los Pipelines contra `event` y corre los que matchean: TODAS las no-exclusive
   * matcheadas en paralelo (son independientes); si alguna matcheada es `exclusive`, en
   * cambio corre SÓLO la de mayor prioridad (menor `position`) entre las exclusive.
   */
  async dispatch(event: DomainEvent): Promise<DispatchOutcome> {
    if (event.depth >= this.maxEventDepth) return 'skipped';

    const pipelines = await this.pipelines.list();
    const matched = pipelines.filter((pipeline) => pipeline.matches(event));
    if (matched.length === 0) return 'skipped';

    const exclusive = matched
      .filter((pipeline) => pipeline.exclusive)
      .sort((a, b) => a.position - b.position)[0];
    const toRun = exclusive ? [exclusive] : matched.filter((pipeline) => !pipeline.exclusive);
    if (toRun.length === 0) return 'skipped';

    await Promise.all(
      toRun.map((pipeline) =>
        pipeline.execute({
          event,
          steps: {},
          bus: this.bus,
          agents: this.agents,
          pipelineId: pipeline.id,
        }),
      ),
    );
    return 'dispatched';
  }
}
