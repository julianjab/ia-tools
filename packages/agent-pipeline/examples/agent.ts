/**
 * Config declarativa de un agente + su puente hacia `Agent` del harness. Espeja
 * `AgentDefinitionProps` de ia-flow (`v2-platform/packages/engine-v2/src/engine/Agent.ts`)
 * a propósito: portar un agente real de ia-flow a este sandbox es copiar la forma, no
 * reinventarla — y si `agent-pipeline` termina reemplazando el engine real, este archivo es
 * el punto de partida de ESA pieza (ver la nota de memoria del proyecto sobre ese objetivo).
 *
 * Campos tipados por paridad de forma pero SIN runtime acá (documentado en cada uno):
 * ninguno de esos conceptos existe todavía en este sandbox — worktrees, ExecutionLog,
 * capacidad, editor UI, contrato submit_output. Implementarlos es trabajo de la integración
 * real con ia-flow, no de estos examples.
 */
import type { AgentRunInput, AgentRunOutput, Agent as PipelineAgent } from '../src/index.js';

export type CommentTarget = 'issue' | 'pr' | 'pr-else-issue' | 'none';

/** Salida corta: sólo el nombre de status. Salida larga: además declara dónde comentar. */
export type AgentExit = string | { set: string; when?: string; comment?: CommentTarget };

export const SUCCESS_EXIT = 'success';
export const ERROR_EXIT = 'error';

/** Outcomes que NO aplican ninguna transición — el run se cortó desde afuera, no es un
 *  resultado del agente. Igual a `NO_TRANSITION_OUTCOMES` de ia-flow. */
const NO_TRANSITION_OUTCOMES = new Set(['cancelled', 'truncated']);

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

export interface AgentDefinitionProps {
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

  // --- Paridad de forma con AgentDefinitionProps, sin runtime en este sandbox ---
  /** Contrato de `submit_output` — necesita el engine real (validación + persistencia). */
  output?: AgentOutput;
  /** Simétrico a `output`, mirando el paso anterior de una Pipeline — necesita que
   *  `PipelineExecutionContext` exponga `nextSchema`, que agent-pipeline no tiene. */
  expectedInput?: AgentOutput;
  saveOutput?: boolean;
  /** Necesita `WorkspaceProvisionerPort` (worktrees) — no existe en este sandbox. */
  requiresBranch?: boolean;
  allowBlocked?: boolean;
  maxConcurrentDispatches?: number;
  projectId?: string | null;
  position?: number;
  /** Comandos que correría el ENGINE en el worktree — necesita un ShellRunner + workspace. */
  verify?: string[];
  onProcess?: string;
}

/** Lo que `agent()` arma para el Provider — el prompt ya interpolado, nunca `{{...}}` crudo. */
export interface ProviderRunContext {
  agentId: string;
  prompt: string;
  systemPrompts: string[];
  variables: Record<string, AgentVariableValue>;
  providerConfig: Record<string, unknown>;
  mcpServers: McpServerRef[];
  tools: Tool[];
  input: AgentRunInput;
}

/** Lo que un Provider reporta al terminar. `outcome` es el nombre que `matchExit` busca en
 *  `AgentDefinitionProps.exits` — típicamente 'success'/'error', o lo que el modelo decida. */
export interface ProviderRunOutput {
  outcome: string;
  summary?: string;
  structuredOutput?: Record<string, unknown>;
}

export interface Provider {
  readonly id: string;
  run(ctx: ProviderRunContext): Promise<ProviderRunOutput>;
}

/** Registry por id — un Provider se registra una vez y cualquier `AgentDefinitionProps` lo
 *  referencia por `provider: 'ese-id'`. Mismo patrón que `Provider.resolve(id)` en ia-flow. */
class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(provider: Provider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  resolve(id: string): Provider | undefined {
    return this.providers.get(id);
  }
}
export const providerRegistry = new ProviderRegistry();

function getPath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, root);
}

/** Mismo patrón `{{path}}` que `Agent.interpolate` en ia-flow — un placeholder que no
 *  resuelve se deja tal cual, fail-open. */
function interpolate(text: string, root: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const value = getPath(root, path);
    return value == null ? match : String(value);
  });
}

function renderedVariables(variables: Record<string, AgentVariableValue>): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    rendered[key] = typeof value === 'string' ? value : (value.full ?? value.value);
  }
  return rendered;
}

/** Sin catálogo por id acá — una entrada `{ id }` sin `text` inline se descarta, fail-open,
 *  igual que cuando el catálogo de ia-flow no resuelve. */
function resolveSystemPrompts(refs: SystemPromptRef[]): string[] {
  return refs.map((ref) => ref.text).filter((text): text is string => text != null);
}

function matchExit(exits: Record<string, AgentExit>, outcome: string): AgentExit | undefined {
  if (NO_TRANSITION_OUTCOMES.has(outcome)) return undefined;
  return exits[outcome] ?? exits[ERROR_EXIT];
}

/**
 * Construye un `Agent` del harness a partir de una `AgentDefinitionProps` + el `Provider`
 * que resuelva `def.provider` contra `providerRegistry`. Es el único puente entre "cómo se
 * declara un agente" (config, portable de ia-flow) y "cómo lo corre agent-pipeline"
 * (`{ id, run }`) — ningún Provider ni ninguna app de más abajo conoce `{{...}}`, `exits` ni
 * el registry; eso vive acá, una sola vez.
 */
export function agent(def: AgentDefinitionProps): PipelineAgent<ProviderRunOutput> {
  const variables = def.variables ?? {};
  const exits = def.exits ?? {};

  return {
    id: def.id,
    async run(input: AgentRunInput): Promise<AgentRunOutput<ProviderRunOutput>> {
      const provider = providerRegistry.resolve(def.provider);
      if (provider == null) {
        throw new Error(
          `agent(${def.id}): provider desconocido "${def.provider}" — ¿lo registraste con providerRegistry.register(...)?`,
        );
      }

      const payload =
        typeof input.event.payload === 'object' && input.event.payload !== null
          ? (input.event.payload as Record<string, unknown>)
          : {};
      const root: Record<string, unknown> = {
        ...payload,
        steps: input.steps,
        variables: renderedVariables(variables),
      };
      const prompt = interpolate(def.prompt, root);
      const fullPrompt =
        input.brief != null ? `${interpolate(input.brief, root)}\n\n${prompt}` : prompt;

      const result = await provider.run({
        agentId: def.id,
        prompt: fullPrompt,
        systemPrompts: resolveSystemPrompts(def.systemPrompts ?? []),
        variables,
        providerConfig: def.providerConfig ?? {},
        mcpServers: def.mcpServers ?? [],
        tools: def.tools ?? [],
        input,
      });

      const matched = matchExit(exits, result.outcome);
      return { output: result, exit: exitSet(matched) };
    },
  };
}
