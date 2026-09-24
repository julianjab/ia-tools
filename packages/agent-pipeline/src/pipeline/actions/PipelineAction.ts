import type { AgentSource } from '../../agent/AgentRegistry.js';
import type { Condition } from '../../condition/Condition.js';
import type { DomainEvent } from '../../events/DomainEvent.js';
import type { EventBus } from '../../events/EventBus.js';

export interface PipelineExecutionContext {
  event: DomainEvent<any>;
  /** Outputs acumulados de los pasos anteriores DE ESTE Pipeline, por `id`. */
  steps: Record<string, unknown>;
  bus: EventBus;
  agents: AgentSource;
  pipelineId: string;
}

export interface PipelineActionProps {
  /** Nombre del paso — si se setea, su output queda en `ctx.steps[id]` para pasos siguientes. */
  id?: string;
  when?: Condition[];
  /** Si el paso tira, seguir con el siguiente en vez de abortar el Pipeline. */
  continueOnError?: boolean;
}

/**
 * Base de toda entrada de `Pipeline.do`. Cada paso ve el `PipelineExecutionContext`
 * completo (no sólo el output del paso anterior) — así un paso puede leer
 * `ctx.steps.triage.output` de cualquier paso nombrado antes, no sólo del inmediato anterior.
 */
export abstract class PipelineAction {
  readonly id?: string;
  readonly when: Condition[];
  readonly continueOnError: boolean;

  constructor(props: PipelineActionProps) {
    this.id = props.id;
    this.when = props.when ?? [];
    this.continueOnError = props.continueOnError ?? false;
  }

  shouldRun(ctx: PipelineExecutionContext): boolean {
    if (this.when.length === 0) return true;
    return evaluateWhen(this.when, ctx);
  }

  abstract run(ctx: PipelineExecutionContext): Promise<unknown>;
}

/**
 * `steps` es una clave RESERVADA en el objeto que evalúan las `when` de un paso — es lo que
 * permite escribir `{ field: 'steps.triage.output.actionable', ... }` (ver el doc de
 * `Pipeline`). Si el `payload` del evento trae su propia clave `steps` (ej. un itinerario de
 * viaje con `{ steps: [...] }` de escalas), esa clave queda tapada por `ctx.steps` a
 * propósito — el `payload` no tiene forma de "ganarle" al reservado. Evitá nombrar un campo
 * de tu dominio `steps` si tu Pipeline usa `when` por-paso.
 */
function evaluateWhen(when: Condition[], ctx: PipelineExecutionContext): boolean {
  const payload = ctx.event.payload;
  // Si el payload no es un objeto plano (un string, un número, `null`), el spread de abajo
  // lo trataría como iterable/índices en vez de fallar con claridad — mejor tratarlo como
  // "sin campos propios" y dejar que sólo `steps` quede disponible para la condición.
  const base = typeof payload === 'object' && payload !== null ? payload : {};
  const subject = { ...base, steps: ctx.steps };
  let result = when[0].evaluate(subject);
  for (let i = 1; i < when.length; i++) {
    const condition = when[i];
    const value = condition.evaluate(subject);
    result = condition.logic === 'or' ? result || value : result && value;
  }
  return result;
}
