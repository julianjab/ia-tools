/**
 * Config declarativa de un agente respaldado por un LLM. Espeja `AgentDefinitionProps` de
 * ia-flow (`v2-platform/packages/engine-v2/src/engine/Agent.ts`) a propósito: portar un
 * agente real de ia-flow a este harness es copiar la forma, no reinventarla — y si
 * `agent-pipeline` termina reemplazando el engine real, este archivo es el punto de partida
 * de ESA pieza (ver la nota de memoria del proyecto sobre ese objetivo).
 *
 * Vive en `src/`, no en `examples/`: es TypeScript puro, cero I/O, igual de "dominio" que
 * `Pipeline`/`Condition`/`Engine`. Lo que SÍ es infra — un `Provider` concreto que le pega a
 * una API real — vive afuera del paquete (`examples/providers/`), nunca acá.
 *
 * Campos tipados por paridad de forma pero SIN runtime en este harness (documentado en cada
 * uno): worktrees, ExecutionLog, capacidad, editor UI, contrato submit_output son conceptos
 * del engine real de ia-flow que este paquete no modela — implementarlos es trabajo de esa
 * integración, no de este harness genérico.
 */
import type { ConditionalProps } from '../condition/Conditional.js';

export type CommentTarget = 'issue' | 'pr' | 'pr-else-issue' | 'none';

/** Salida corta: sólo el nombre de status. Salida larga: además declara dónde comentar. */
export type AgentExit = string | { set: string; when?: string; comment?: CommentTarget };

export const SUCCESS_EXIT = 'success';
export const ERROR_EXIT = 'error';

export function exitSet(exit: AgentExit | undefined): string | undefined {
  if (exit == null) return undefined;
  return typeof exit === 'string' ? exit : exit.set;
}

export interface SystemPromptRef {
  id?: string;
  text?: string;
}

export type AgentVariableValue = string | { value: string; full?: string; description?: string };

export interface AgentOutputField {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  enum?: string[];
  optional?: boolean;
}
export type AgentOutput = Record<string, AgentOutputField>;

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
}

export interface AgentDefinitionProps extends ConditionalProps {
  id: string;
  /**
   * Id de un `Provider` registrado en `providerRegistry`. A diferencia de ia-flow, acá sólo
   * se soporta un id fijo — el desempate entre varios candidatos (`AgentProviderChoice[]`,
   * por `when`/`whenText`) se agrega el día que un caso real lo necesite, mismo criterio que
   * usa ia-flow para NO portar el desempate por clasificador hasta que hizo falta.
   */
  provider: string;
  prompt: string;
  systemPrompts?: SystemPromptRef[];
  variables?: Record<string, AgentVariableValue>;
  tools?: Tool[];
  providerConfig?: Record<string, unknown>;
  mcpServers?: McpServerRef[];
  exits?: Record<string, AgentExit>;
  comment?: CommentTarget;
  /** Si el paso tira, seguir con el siguiente `Runnable` de la Pipeline en vez de abortarla —
   *  mismo campo que cualquier otro `Runnable` (`RunnableProps.continueOnError`). */
  continueOnError?: boolean;
  /**
   * Si se setea, al terminar emite un DomainEvent derivado con `type: emitOn(exit)` — el
   * patrón "onFinish"/"onError" de v1 de ia-flow, generalizado: vos decidís el nombre del
   * evento derivado a partir del `exit` que resolvió este agente.
   */
  emitOn?: (exit: string) => string | undefined;

  // --- Paridad de forma con AgentDefinitionProps de ia-flow, sin runtime en este harness ---
  /** Contrato de `submit_output` — necesita el engine real (validación + persistencia). */
  output?: AgentOutput;
  /** Simétrico a `output`, mirando el paso anterior de una Pipeline — necesita que
   *  `PipelineExecutionContext` exponga `nextSchema`, que agent-pipeline no tiene. */
  expectedInput?: AgentOutput;
  saveOutput?: boolean;
  /** Necesita `WorkspaceProvisionerPort` (worktrees) — no existe en este harness. */
  requiresBranch?: boolean;
  allowBlocked?: boolean;
  maxConcurrentDispatches?: number;
  projectId?: string | null;
  position?: number;
  /** Comandos que correría el ENGINE en el worktree — necesita un ShellRunner + workspace. */
  verify?: string[];
  onProcess?: string;
}
