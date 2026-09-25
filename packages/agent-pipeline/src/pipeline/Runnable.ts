import type { ToolInputSchema } from '../agent/SchemaTool.js';
import { Conditional, type ConditionalProps } from '../condition/Conditional.js';
import type { DomainEvent } from '../events/DomainEvent.js';
import type { EventBus } from '../events/EventBus.js';
import type { ExitDefaults, ResolvedRoutes } from '../routing/ExitRoutes.js';

export interface PipelineExecutionContext {
  event: DomainEvent<any>;
  /** Outputs acumulados de los pasos anteriores DE ESTE Pipeline, por `id`. */
  steps: Record<string, unknown>;
  bus: EventBus;
  pipelineId: string;
  /** Defaults del proyecto (`onError`, `report`) — el nivel más general de la cascada de rutas.
   *  Lo pone el `Engine` a partir de `PipelineSource.defaults` (ver `Project`). */
  defaults?: ExitDefaults;
  /** Las rutas efectivas de un agente DENTRO de esta pipeline (sus overrides + los defaults).
   *  Lo pone `Pipeline.execute`; un agente corriendo suelto usa sólo sus rutas base. */
  routesFor?: (step: Runnable) => ResolvedRoutes | undefined;
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

  /**
   * El schema del input que este paso acepta cuando lo alcanza una ruta — `undefined` si no
   * acepta ninguno (el default: `EmitAction`, `HttpAction`, `FunctionAction`). `Action` y `Agent`
   * lo sobreescriben; de ahí sale lo que un agente tiene que entregar en su `submit_<salida>`.
   */
  acceptsInput(): ToolInputSchema | undefined {
    return undefined;
  }

  /** `input` sólo llega cuando el paso lo ejecuta una ruta (ver `Pipeline`); un paso lineal de
   *  `do[]` lo recibe `undefined`. Los pasos que no aceptan input lo ignoran. */
  abstract run(ctx: PipelineExecutionContext, input?: unknown): Promise<unknown>;
}
