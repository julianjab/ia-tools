/**
 * Config declarativa de un agente respaldado por un LLM. Nació espejando `AgentDefinitionProps`
 * de ia-flow (`v2-platform/packages/engine-v2/src/engine/Agent.ts`); la parte de SALIDAS ya no:
 *
 * - `exits` (status + `when` + `comment`) → `routes`: cada salida lleva a pasos con input tipado,
 *   y la transición del board es una acción más (`updateIssue.bind({ status })`).
 * - `comment` → `report`: el cierre del turno es un paso propio, que corre ANTES que los destinos.
 * - `select_exit` + `submit_output` → una tool `submit_<salida>` por salida, cuyo schema es el
 *   input de sus destinos. Elegir la salida y entregar los datos son una sola llamada.
 * - `emitOn` → un `EmitAction` como destino de una ruta.
 * - `onProcess` → `onStart`, un paso que corre antes del provider.
 *
 * Las rutas del agente son la BASE de una cascada (paso > pipeline > agente > proyecto) — ver
 * `routing/ExitRoutes.ts`. Portar un agente de ia-flow: sus `exits` pasan a `routes` con
 * `updateIssue.bind({ status: set })` como destino.
 *
 * Vive en `src/`, no en `examples/`: es TypeScript puro, cero I/O, igual de "dominio" que
 * `Pipeline`/`Condition`/`Engine`. Lo que SÍ es infra — un `Provider` concreto que le pega a
 * una API real — vive afuera del paquete, nunca acá.
 *
 * Campos tipados por paridad de forma pero SIN runtime en este harness (documentado en cada
 * uno): worktrees, capacidad y verificación del engine son conceptos del engine real de ia-flow
 * que este paquete no modela.
 */
import type { ConditionalProps } from '../condition/Conditional.js';
import type { Runnable } from '../pipeline/Runnable.js';
import type { Action, AllowedAction } from '../pipeline/actions/Action.js';
import type { ExitRoutes } from '../routing/ExitRoutes.js';
import type { ToolInputSchema } from './SchemaTool.js';

export interface SystemPromptRef {
  id?: string;
  text?: string;
}

export type AgentVariableValue = string | { value: string; full?: string; description?: string };

/** Sin catálogo de MCP acá — a diferencia de `mcpCatalogIds` (ia-flow), esto viaja YA
 *  resuelto: lo que el Provider necesite para conectarse a ESE servidor. */
export interface McpServerRef {
  id: string;
  config: Record<string, unknown>;
}

// `TInput = any`: array heterogéneo de tools con distinto TInput cada una — mismo trade-off
// documentado en agent-pipeline (`DomainEvent<any>`).
export interface Tool<TInput = any> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: TInput) => Promise<string> | string;
  /** Una llamada exitosa termina el turno del agente — las `submit_<salida>` que arma `Agent`.
   *  Un provider que soporte tools corta su loop ahí en vez de esperar un `end_turn`. */
  terminal?: boolean;
}

export interface AgentDefinitionProps extends ConditionalProps, ExitRoutes {
  id: string;
  /**
   * Id de un `Provider` registrado en `providerRegistry`. A diferencia de ia-flow, acá sólo
   * se soporta un id fijo — el desempate entre varios candidatos (`AgentProviderChoice[]`,
   * por `when`/`whenText`) se agrega el día que un caso real lo necesite, mismo criterio que
   * usa ia-flow para NO portar el desempate por clasificador hasta que hizo falta.
   */
  provider: string;
  prompt: string;
  /** Lo que el agente recibe cuando lo alcanza una ruta — disponible como `{{input.x}}` en el
   *  prompt. Un agente que también corre por evento (sin input) necesita campos opcionales. */
  input?: ToolInputSchema;
  systemPrompts?: SystemPromptRef[];
  variables?: Record<string, AgentVariableValue>;
  tools?: Tool[];
  /** Acciones que el modelo puede llamar como tools. Una con `sideEffects: 'write'` sólo entra
   *  con `action.allowWrite()` — escribir tiene que ser una decisión explícita del operador. */
  actions?: Array<Action | AllowedAction>;
  /** Corre antes del provider — ej. sacar labels de un ciclo anterior (el `onProcess` de ia-flow). */
  onStart?: Runnable;
  providerConfig?: Record<string, unknown>;
  mcpServers?: McpServerRef[];
  /** Si el paso tira y no hay `onError` en la cascada, seguir con el siguiente `Runnable` de la
   *  Pipeline en vez de abortarla — mismo campo que cualquier otro `Runnable`. */
  continueOnError?: boolean;

  // --- Paridad de forma con AgentDefinitionProps de ia-flow, sin runtime en este harness ---
  /** Necesita `WorkspaceProvisionerPort` (worktrees) — no existe en este harness. */
  requiresBranch?: boolean;
  allowBlocked?: boolean;
  maxConcurrentDispatches?: number;
  projectId?: string | null;
  position?: number;
  /** Comandos que correría el ENGINE en el worktree — necesita un ShellRunner + workspace. */
  verify?: string[];
}
