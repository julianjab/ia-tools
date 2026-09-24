/** Un evento crudo del mundo — no sabe nada de negocio, sólo lleva forma. */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  /** Nombre del evento, ej. "github.issue.opened", "slack.message", "travel.trip.requested". */
  type: string;
  payload: TPayload;
  /**
   * Filtro opcional para que un Pipeline se restrinja a un subconjunto de eventos del
   * mismo `type` (ej. { workspace: 'acme', channel: 'C123' } o { tripId: 't_1' }).
   * Libre a propósito: a diferencia de engine-v2, acá no asume issueId/projectId/repos —
   * cada dominio (GitHub, Slack, viajes) define sus propias claves de scope.
   */
  scope?: Record<string, unknown>;
  occurredAt: string;
  /** Profundidad de la cadena de derivación (EmitAction / AgentAction con emitOn). */
  depth: number;
}

export interface CreateEventOptions {
  scope?: Record<string, unknown>;
  depth?: number;
  occurredAt?: string;
}

export function createEvent<TPayload = Record<string, unknown>>(
  type: string,
  payload: TPayload,
  opts: CreateEventOptions = {},
): DomainEvent<TPayload> {
  return {
    type,
    payload,
    scope: opts.scope,
    occurredAt: opts.occurredAt ?? new Date().toISOString(),
    depth: opts.depth ?? 0,
  };
}

/**
 * Evento derivado de otro (EmitAction, AgentAction con emitOn: 'exit') — hereda profundidad + 1
 * y, salvo que se pase un `scope` explícito, también el `scope` del padre. Sin esto, un
 * Pipeline con `scope: { repo: 'x' }` nunca reacciona a un evento derivado de otro Pipeline
 * sobre ESE mismo repo — encadenar pipelines con scope (el caso de uso central) se rompía en
 * silencio.
 */
export function deriveEvent<TPayload = Record<string, unknown>>(
  parent: DomainEvent,
  type: string,
  payload: TPayload,
  opts: Omit<CreateEventOptions, 'depth'> = {},
): DomainEvent<TPayload> {
  return createEvent(type, payload, {
    ...opts,
    scope: opts.scope ?? parent.scope,
    depth: parent.depth + 1,
  });
}
