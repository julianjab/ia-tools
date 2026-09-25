import { z } from 'zod';
import type { ToolInputSchema } from '../agent/SchemaTool.js';
import { Conditional, type ConditionalProps } from '../condition/Conditional.js';
import type { DomainEvent } from '../events/DomainEvent.js';
import type { EventBus } from '../events/EventBus.js';
import type { ErrorRoute, ExitDefaults, ResolvedRoutes } from '../routing/ExitRoutes.js';

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
  /** Qué correr si el paso tira — gana sobre el `onError` de la pipeline y del proyecto; `null`
   *  anula los de esos niveles. (Un `Agent` lo declara en su definición: tiene la cascada
   *  completa, con overrides por pipeline.) */
  onError?: ErrorRoute | null;
  /** Si el paso tira y ningún `onError` lo maneja, seguir con el siguiente en vez de abortar el
   *  Pipeline. Equivale a un `onError` sin destinos, como último recurso. */
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
  readonly onError?: ErrorRoute | null;
  readonly continueOnError: boolean;

  constructor(props: RunnableProps) {
    super(props);
    this.id = props.id;
    this.onError = props.onError;
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

  /** Valida `input` contra `schema` (o `{}` si no llegó) — el helper que usan los pasos que
   *  declaran un input opcional (`EmitAction`, `HttpAction`, `FunctionAction`). Sin schema,
   *  devuelve `undefined`: el paso no acepta input y lo que llegue se ignora. */
  protected parseInput(
    schema: ToolInputSchema | undefined,
    input: unknown,
  ): Record<string, unknown> | undefined {
    if (!schema) return undefined;
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new Error(`${this.id ?? 'paso'}: input inválido\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data as Record<string, unknown>;
  }

  /** `input` sólo llega cuando el paso lo ejecuta una ruta (ver `Pipeline`); un paso lineal de
   *  `do[]` lo recibe `undefined`. Los pasos que no aceptan input lo ignoran. */
  abstract run(ctx: PipelineExecutionContext, input?: unknown): Promise<unknown>;
}
