import {
  type McpServerRef,
  type Provider,
  type ProviderRunContext,
  type ProviderRunOutput,
  type Tool,
  traced,
} from '@ia-tools/agent-pipeline';
import {
  AnthropicClient,
  type AnthropicClientOptions,
  type AnthropicContentBlock,
  type AnthropicMessagesResponse,
  type AnthropicRetryInfo,
  type AnthropicSendOptions,
} from './AnthropicClient.js';
import { chatTrace, toolTrace } from './tracing.js';

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AnthropicThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number };

/**
 * Todo lo que hace falta para el caso simple es `{ id, model }` — el resto son perillas de
 * ia-flow (`anthropic-api`) que sólo hay que tocar cuando el caso de uso las necesita.
 */
export interface AnthropicProviderOptions extends AnthropicClientOptions {
  /** Id con el que se registra en `providerRegistry` — lo que cada `AgentDefinition` pone en
   *  `provider: '...'`. */
  id: string;
  model: string;
  maxTokens?: number;
  /** Tope de vueltas del loop de tools, para no quedar colgado si el modelo no converge. */
  maxToolRounds?: number;
  /** Deriva `outcome` a partir del texto final de respuesta — default: siempre 'success'. */
  resolveOutcome?: (text: string) => string;
  /** Default true — ver `AnthropicSendOptions.stream` en `AnthropicClient`. */
  stream?: boolean;
  thinking?: AnthropicThinkingConfig;
  effort?: AnthropicEffort;
  taskBudgetTokens?: number;
  /** Por default las tools de cada MCP van diferidas (`defer_loading` + una tool de búsqueda
   *  regex). `true` carga todo el catálogo desde el primer request. */
  eagerMcpTools?: boolean;
  /** Un corte por `max_tokens` reintenta UNA vez con el doble de presupuesto (tope 128000)
   *  antes de reportar `'truncated'`. Default true. */
  bumpMaxTokensOnTruncation?: boolean;
  onToolCall?: (name: string, input: unknown, toolUseId: string | undefined) => void;
  onToolResult?: (name: string, result: string, toolUseId: string | undefined) => void;
  /** Se llama antes de cada request con la conversación completa — el caller decide si y dónde
   *  persistir un checkpoint reanudable. Este paquete no tiene storage propio; ver
   *  `AnthropicAgentProviderConfig.resumeMessages` para retomarlo. */
  onCheckpoint?: (messages: unknown[], ctx: ProviderRunContext) => void | Promise<void>;
}

/** Override por-agente, leído de `ProviderRunContext.providerConfig` — mismos campos que
 *  `AnthropicApiAgentConfigSchema` de ia-flow, sin Zod (este paquete no depende de él). */
export interface AnthropicAgentProviderConfig {
  model?: string;
  maxTokens?: number;
  effort?: AnthropicEffort;
  taskBudgetTokens?: number;
  thinkingBudgetTokens?: number;
  maxRetries?: number;
  eagerMcpTools?: boolean;
  /** Retoma una conversación truncada en vez de arrancar del prompt. */
  resumeMessages?: AnthropicMessage[];
}

export type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown };

/** El body de un request a la Messages API — lo mínimo tipado que lee la traza; el resto va tal
 *  cual. */
export type ChatRequest = Record<string, unknown> & {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
};

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string | undefined;
  content: string;
  is_error?: true;
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const DEFAULT_MAX_RETRIES = 3;
const MAX_TOKEN_BUMP_CEILING = 128_000;

function parseAgentConfig(raw: Record<string, unknown>): AnthropicAgentProviderConfig {
  const cfg: AnthropicAgentProviderConfig = {};
  if (typeof raw.model === 'string') cfg.model = raw.model;
  if (typeof raw.maxTokens === 'number') cfg.maxTokens = raw.maxTokens;
  if (typeof raw.effort === 'string') cfg.effort = raw.effort as AnthropicEffort;
  if (typeof raw.taskBudgetTokens === 'number') cfg.taskBudgetTokens = raw.taskBudgetTokens;
  if (typeof raw.thinkingBudgetTokens === 'number')
    cfg.thinkingBudgetTokens = raw.thinkingBudgetTokens;
  if (typeof raw.maxRetries === 'number') cfg.maxRetries = raw.maxRetries;
  if (typeof raw.eagerMcpTools === 'boolean') cfg.eagerMcpTools = raw.eagerMcpTools;
  if (Array.isArray(raw.resumeMessages)) {
    cfg.resumeMessages = raw.resumeMessages as AnthropicMessage[];
  }
  return cfg;
}

/** Mapea `McpServerRef` (id + config libre) → la forma que exige `mcp_servers[]` de la API.
 *  Sólo entradas con `config.url` — el conector MCP remoto de Anthropic es la única modalidad
 *  soportada acá (stdio no cruza la red). */
function toApiMcpServers(servers: McpServerRef[]): Array<Record<string, unknown>> | undefined {
  const out: Array<Record<string, unknown>> = [];
  for (const server of servers) {
    const config = server.config as {
      url?: string;
      authorizationToken?: string;
      headers?: Record<string, string>;
    };
    if (!config.url) continue;
    const entry: Record<string, unknown> = { name: server.id, type: 'url', url: config.url };
    if (config.authorizationToken) entry.authorization_token = config.authorizationToken;
    else if (config.headers?.Authorization?.startsWith('Bearer ')) {
      entry.authorization_token = config.headers.Authorization.slice('Bearer '.length);
    }
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/** Un solo breakpoint de cache, en el ÚLTIMO bloque de system — el caching de la API es prefix
 *  match, así que marcar cada bloque no compra nada y consume el tope de 4 `cache_control` por
 *  request contra tools/mensajes. */
function buildSystemBlocks(systemPrompts: string[]): Array<Record<string, unknown>> {
  return systemPrompts.map((text, i) =>
    i === systemPrompts.length - 1
      ? { type: 'text', text, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text },
  );
}

function buildThinkingConfig(
  agentThinkingBudget: number | undefined,
  effectiveMaxTokens: number,
  defaultThinking: AnthropicThinkingConfig | undefined,
): Record<string, unknown> | undefined {
  // budget_tokens < max_tokens es requisito de la API — clampeado bajo effectiveMaxTokens (que
  // ya puede haber subido por el bump de truncamiento) en vez de confiar ciegamente en la
  // config, sea que el budget venga del override por-agente o del default del provider (los dos
  // caen acá, no sólo el override — un `new AnthropicProvider({ thinking: { budgetTokens } })`
  // con el `maxTokens` default de 1024 mandaría un budget >= max_tokens sin este clamp, y la
  // API rechaza eso con 400).
  const requestedBudget =
    agentThinkingBudget ??
    (defaultThinking?.type === 'enabled' ? defaultThinking.budgetTokens : undefined);
  if (requestedBudget != null) {
    const clamped = Math.min(requestedBudget, effectiveMaxTokens - 1024);
    if (clamped >= 1024) return { type: 'enabled', budget_tokens: clamped };
  }
  return defaultThinking?.type === 'adaptive' ? { type: 'adaptive' } : undefined;
}

function buildOutputConfig(
  effort: AnthropicEffort | undefined,
  taskBudgetTokens: number | undefined,
): Record<string, unknown> | undefined {
  const outputConfig: Record<string, unknown> = {};
  if (effort) outputConfig.effort = effort;
  if (taskBudgetTokens != null)
    outputConfig.task_budget = { type: 'tokens', total: taskBudgetTokens };
  return Object.keys(outputConfig).length > 0 ? outputConfig : undefined;
}

/**
 * Anthropic resuelve un `mcp_tool_use` server-side y devuelve su `mcp_tool_result` en el MISMO
 * `content` — si ese par llega roto, reenviar la conversación tal cual la deja 400 PARA SIEMPRE
 * (la API rechaza cualquier `mcp_tool_use` sin su `mcp_tool_result`). Se saca el bloque huérfano
 * antes de cada request: el modelo pierde esa tool call puntual, no toda la conversación.
 */
function stripOrphanedMcpToolUse(messages: AnthropicMessage[]): AnthropicMessage[] {
  let sanitized: AnthropicMessage[] | undefined;
  messages.forEach((msg, index) => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
    const content = msg.content as AnthropicContentBlock[];
    const resultIds = new Set(
      content.filter((b) => b.type === 'mcp_tool_result').map((b) => b.tool_use_id),
    );
    const orphaned = content.filter((b) => b.type === 'mcp_tool_use' && !resultIds.has(b.id));
    if (orphaned.length === 0) return;
    const remaining = content.filter((b) => !orphaned.includes(b));
    const nextContent: AnthropicContentBlock[] =
      remaining.length > 0
        ? remaining
        : [{ type: 'text', text: '[mcp tool call descartada: nunca volvió un resultado]' }];
    sanitized ??= [...messages];
    sanitized[index] = { ...msg, content: nextContent };
  });
  return sanitized ?? messages;
}

/** Vale la pena insistir si el agente no puede cerrar solo: más de una salida, o una única salida
 *  que pide datos. Con una sola `submit_done` sin campos requeridos, `Agent` la toma sin submit. */
function needsSubmit(terminalTools: Tool[]): boolean {
  if (terminalTools.length === 0) return false;
  if (terminalTools.length > 1) return true;
  const required = terminalTools[0]?.inputSchema.required;
  return Array.isArray(required) && required.length > 0;
}

/**
 * Provider de Anthropic — implementa `Provider` (`@ia-tools/agent-pipeline`) contra la Messages
 * API real: streaming, retries, extended thinking, task budgets, MCP remoto y checkpointing,
 * portado de `ia-flow/packages/ai-providers/src/anthropic-api`. Uso mínimo:
 *
 * ```ts
 * providerRegistry.register(new AnthropicProvider({ id: 'anthropic-api', model: 'claude-sonnet-5' }));
 * ```
 *
 * Todo lo demás (thinking, task budgets, MCP, checkpointing) es opt-in vía `AnthropicProviderOptions`
 * o, por-agente, vía `AgentDefinitionProps.providerConfig` (ver `AnthropicAgentProviderConfig`).
 */
export class AnthropicProvider implements Provider {
  readonly id: string;
  private readonly client: AnthropicClient;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.id = options.id;
    this.client = new AnthropicClient(options);
  }

  async run(ctx: ProviderRunContext): Promise<ProviderRunOutput> {
    const opts = this.options;
    const pc = parseAgentConfig(ctx.providerConfig ?? {});

    const model = pc.model ?? opts.model;
    const maxTokens = pc.maxTokens ?? opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const maxRetries = pc.maxRetries ?? opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const maxToolRounds = opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const useStream = opts.stream ?? true;
    const eagerMcpTools = pc.eagerMcpTools ?? opts.eagerMcpTools ?? false;
    const bumpOnTruncation = opts.bumpMaxTokensOnTruncation ?? true;

    const apiMcpServers = toApiMcpServers(ctx.mcpServers);
    const deferMcpTools = apiMcpServers !== undefined && !eagerMcpTools;

    const extraBetas: string[] = [];
    const taskBudgetTokens = pc.taskBudgetTokens ?? opts.taskBudgetTokens;
    if (taskBudgetTokens != null) extraBetas.push('task-budgets-2026-03-13');
    if (apiMcpServers) extraBetas.push('mcp-client-2025-11-20');

    const systemBlocks = buildSystemBlocks(ctx.systemPrompts);
    const toolDefs = ctx.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    const toolSearch = deferMcpTools
      ? [{ type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' }]
      : [];
    const mcpToolsets = apiMcpServers?.map((s) => ({
      type: 'mcp_toolset',
      mcp_server_name: s.name,
      ...(deferMcpTools ? { default_config: { defer_loading: true } } : {}),
    }));
    const allTools = [...toolSearch, ...toolDefs, ...(mcpToolsets ?? [])];

    let messages: AnthropicMessage[] = pc.resumeMessages ?? [{ role: 'user', content: ctx.prompt }];
    // Las salidas; `fail_turn` (failure) también es terminal, pero no cuenta para insistir.
    const terminalTools = ctx.tools.filter((tool) => tool.terminal && !tool.failure);
    let nudged = false;

    for (let round = 0; round <= maxToolRounds; round++) {
      await opts.onCheckpoint?.(messages, ctx);

      const sendOnce = async (effectiveMaxTokens: number): Promise<AnthropicMessagesResponse> => {
        const thinking = buildThinkingConfig(
          pc.thinkingBudgetTokens,
          effectiveMaxTokens,
          opts.thinking,
        );
        const outputConfig = buildOutputConfig(pc.effort ?? opts.effort, taskBudgetTokens);
        const body: ChatRequest = {
          model,
          max_tokens: effectiveMaxTokens,
          system: systemBlocks,
          messages: stripOrphanedMcpToolUse(messages),
          // Auto-cache a nivel request, además del breakpoint explícito del system: cachea el
          // último bloque cacheable de `messages` y lo corre sola en cada vuelta.
          cache_control: { type: 'ephemeral' },
        };
        if (allTools.length > 0) body.tools = allTools;
        if (thinking) body.thinking = thinking;
        if (apiMcpServers) body.mcp_servers = apiMcpServers;
        if (outputConfig) body.output_config = outputConfig;
        return this.send(body, round, { stream: useStream, extraBetas, maxRetries });
      };

      let data = await sendOnce(maxTokens);

      if (data.stop_reason === 'max_tokens' && bumpOnTruncation) {
        const bumped = Math.min(maxTokens * 2, MAX_TOKEN_BUMP_CEILING);
        if (bumped > maxTokens) data = await sendOnce(bumped);
      }

      if (data.stop_reason === 'max_tokens') {
        // Se quedó sin tokens a mitad de la respuesta — NO es un resultado del agente, así que
        // el outcome es 'truncated': `Agent.run` (agent-pipeline) trata esto como
        // NO_TRANSITION_OUTCOMES y no aplica ninguna transición, en vez de leer un texto
        // cortado a la mitad como 'success'.
        const text = data.content.find((block) => block.type === 'text')?.text ?? '';
        return { outcome: 'truncated', summary: text };
      }

      if (data.stop_reason === 'end_turn' || data.stop_reason === 'stop_sequence') {
        // El agente ofrece tools terminales (`submit_<salida>`) y el modelo cerró sin llamar
        // ninguna: se le insiste UNA vez. Sin `tool_choice` forzado a propósito — no convive con
        // extended thinking. Si igual no llama, `Agent` decide (falla o toma la única salida).
        if (needsSubmit(terminalTools) && !nudged) {
          nudged = true;
          messages = [
            ...messages,
            { role: 'assistant', content: data.content },
            {
              role: 'user',
              content: `Para terminar tu turno tenés que llamar a una de estas tools: ${terminalTools.map((tool) => tool.name).join(', ')}.`,
            },
          ];
          continue;
        }
        const text = data.content.find((block) => block.type === 'text')?.text ?? '';
        return { outcome: opts.resolveOutcome?.(text) ?? 'success', summary: text };
      }

      if (data.stop_reason === 'pause_turn') {
        // El modelo se pausó a MITAD de turno — no es una pausa entre turnos (eso sería
        // `end_turn`/`tool_use` normal), es el mecanismo que usa la API para runs largos con
        // tools server-side (MCP remoto, extended thinking): el turno sigue, así que se
        // reenvía la conversación con el contenido parcial agregado, sin turno de usuario de
        // por medio, y el modelo continúa desde donde quedó. Cuenta contra `maxToolRounds`
        // igual que una vuelta de tool_use, para no quedar colgado si nunca converge.
        messages = [...messages, { role: 'assistant', content: data.content }];
        continue;
      }

      if (data.stop_reason !== 'tool_use') {
        // `null`, o cualquier otro stop_reason que la API llegue a agregar — no se adivina
        // como éxito.
        throw new Error(
          `AnthropicProvider(${opts.id}): stop_reason inesperado "${data.stop_reason}"`,
        );
      }

      const toolUseBlocks = data.content.filter((block) => block.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUseBlocks.map((block) => this.executeTool(block, ctx.tools)),
      );
      // Una tool terminal que devolvió OK (`submit_<salida>` validado) cierra el turno ahí: no
      // hace falta otra vuelta a la API para que el modelo diga "listo".
      const submitted = toolUseBlocks.some((block, index) => {
        const tool = ctx.tools.find((candidate) => candidate.name === block.name);
        const result = toolResults[index] as { is_error?: boolean } | undefined;
        return tool?.terminal === true && result?.is_error !== true;
      });
      if (submitted) {
        const text = data.content.find((block) => block.type === 'text')?.text ?? '';
        return { outcome: 'success', summary: text };
      }
      messages = [
        ...messages,
        { role: 'assistant', content: data.content },
        { role: 'user', content: toolResults },
      ];
    }

    throw new Error(
      `AnthropicProvider(${opts.id}): superó maxToolRounds (${maxToolRounds}) sin converger`,
    );
  }

  @traced(chatTrace)
  private send(
    body: ChatRequest,
    _round: number,
    sendOptions: AnthropicSendOptions,
  ): Promise<AnthropicMessagesResponse> {
    return this.client.send(body, sendOptions);
  }

  @traced(toolTrace)
  private async executeTool(block: AnthropicContentBlock, tools: Tool[]): Promise<ToolResultBlock> {
    const { onToolCall, onToolResult } = this.options;
    const finish = (content: string, isError: boolean): ToolResultBlock => {
      onToolResult?.(block.name ?? '', content, block.id);
      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content,
        ...(isError ? { is_error: true } : {}),
      };
    };
    onToolCall?.(block.name ?? '', block.input, block.id);
    const tool = tools.find((t) => t.name === block.name);
    if (tool == null) {
      return finish(`Error: no existe una tool registrada con nombre "${block.name}"`, true);
    }
    // Un `handler` que tira (input inválido, la API de negocio de abajo falla) no puede
    // tumbar el loop entero — el modelo tiene que verlo como un `tool_result` con
    // `is_error: true` para poder corregirse, en vez de que el run entero termine en una
    // excepción no manejada.
    try {
      return finish(String(await tool.handler(block.input)), false);
    } catch (err) {
      return finish(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }
}

export type { AnthropicClientOptions, AnthropicRetryInfo };
