import { Conditional, type ConditionalProps } from '../condition/Conditional.js';
import type { DomainEvent } from '../events/DomainEvent.js';
import type { EventBus } from '../events/EventBus.js';

export interface PipelineExecutionContext {
  event: DomainEvent<any>;
  /** Outputs acumulados de los pasos anteriores DE ESTE Pipeline, por `id`. */
  steps: Record<string, unknown>;
  bus: EventBus;
  pipelineId: string;
}

export interface RunnableProps extends ConditionalProps {
  /** Nombre del paso — si se setea, su output queda en `ctx.steps[id]` para pasos siguientes. */
  id?: string;
  /** Si el paso tira, seguir con el siguiente en vez de abortar el Pipeline. */
  continueOnError?: boolean;
}

/**
 * Base de todo lo que vive en `Pipeline.do[]`. Cada paso ve el `PipelineExecutionContext`
 * completo (no sólo el output del paso anterior) — así un paso puede leer
 * `ctx.steps.triage.output` de cualquier paso nombrado antes, no sólo del inmediato anterior.
 *
 * Contrato único: `EmitAction`/`HttpAction`/`FunctionAction` extienden esto para pasos
 * genéricos, y `Agent` (`../agent/Agent.js`) también — un agente respaldado por un LLM se
 * pone directo en `do[]`, sin un paso intermedio que lo resuelva por id. Antes de esto había
 * dos contratos separados (`PipelineAction` acá, `Agent { id, run(AgentRunInput) }` en
 * `agent/`) con un `AgentAction` puenteándolos vía `AgentRegistry` — la indirección no
 * compraba nada que un import directo del `Agent` ya no diera, así que se colapsó en uno.
 */
export abstract class Runnable extends Conditional {
  readonly id?: string;
  readonly continueOnError: boolean;

  constructor(props: RunnableProps) {
    super(props);
    this.id = props.id;
    this.continueOnError = props.continueOnError ?? false;
  }

  /**
   * `steps` es una clave RESERVADA en el objeto que evalúan las `when` de un paso — es lo que
   * permite escribir `{ field: 'steps.triage.output.actionable', ... }` (ver el doc de
   * `Pipeline`). Si el `payload` del evento trae su propia clave `steps` (ej. un itinerario de
   * viaje con `{ steps: [...] }` de escalas), esa clave queda tapada por `ctx.steps` a
   * propósito — el `payload` no tiene forma de "ganarle" al reservado. Evitá nombrar un campo
   * de tu dominio `steps` si tu Pipeline usa `when` por-paso.
   */
  shouldRun(ctx: PipelineExecutionContext): boolean {
    if (this.when.length === 0) return true;
    const payload = ctx.event.payload;
    // Si el payload no es un objeto plano (un string, un número, `null`), el spread de abajo
    // lo trataría como iterable/índices en vez de fallar con claridad — mejor tratarlo como
    // "sin campos propios" y dejar que sólo `steps` quede disponible para la condición.
    const base = typeof payload === 'object' && payload !== null ? payload : {};
    return this.matchesConditions({ ...base, steps: ctx.steps });
  }

  abstract run(ctx: PipelineExecutionContext): Promise<unknown>;
}
