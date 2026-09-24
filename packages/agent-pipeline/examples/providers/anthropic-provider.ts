/**
 * Provider de Anthropic — implementa `Provider` (`../agent.js`). Sabe hablar el protocolo de
 * la Messages API (headers, el loop de tool-calling, `tool_result`); no sabe nada de qué
 * agente lo está usando ni de negocio — eso vive en `AgentDefinitionProps` y en cada `Tool`.
 */
import type { Provider, ProviderRunContext, ProviderRunOutput, Tool } from '../agent.js';

export interface AnthropicProviderOptions {
  /** Id con el que se registra — lo que cada AgentDefinition pone en `provider: '...'`. */
  id: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  /** Tope de vueltas del loop de tools, para no quedar colgado si el modelo no converge. */
  maxToolRounds?: number;
  /** Deriva `outcome` a partir del texto final de respuesta — default: siempre 'success'. */
  resolveOutcome?: (text: string) => string;
  fetchImpl?: typeof fetch;
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessagesResponse {
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
}

const DEFAULT_MAX_TOOL_ROUNDS = 8;

export function anthropicProvider(options: AnthropicProviderOptions): Provider {
  return {
    id: options.id,
    async run(ctx: ProviderRunContext): Promise<ProviderRunOutput> {
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(`anthropicProvider(${options.id}): falta ANTHROPIC_API_KEY`);
      }
      const doFetch = options.fetchImpl ?? fetch;
      const maxToolRounds = options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
      const system = ctx.systemPrompts.join('\n\n');

      const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
        { role: 'user', content: ctx.prompt },
      ];

      for (let round = 0; round <= maxToolRounds; round++) {
        const response = await doFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: options.maxTokens ?? 1024,
            system,
            messages,
            tools: ctx.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `anthropicProvider(${options.id}): Anthropic API → ${response.status}: ${body}`,
          );
        }
        const data = (await response.json()) as AnthropicMessagesResponse;

        if (data.stop_reason !== 'tool_use') {
          const text = data.content.find((block) => block.type === 'text')?.text ?? '';
          return { outcome: options.resolveOutcome?.(text) ?? 'success', summary: text };
        }

        // El modelo pidió correr tools — las ejecutamos TODAS las que pidió en esta vuelta
        // (puede pedir más de una en paralelo) y le devolvemos los resultados juntos, como
        // exige el protocolo: un `tool_result` por cada `tool_use` recibido, en un solo turno.
        const toolUseBlocks = data.content.filter((block) => block.type === 'tool_use');
        messages.push({ role: 'assistant', content: data.content });
        messages.push({
          role: 'user',
          content: await Promise.all(
            toolUseBlocks.map(async (block) => {
              const tool = ctx.tools.find((t: Tool) => t.name === block.name);
              const result = tool
                ? await tool.handler(block.input)
                : `Error: no existe una tool registrada con nombre "${block.name}"`;
              return { type: 'tool_result', tool_use_id: block.id, content: String(result) };
            }),
          ),
        });
      }

      throw new Error(
        `anthropicProvider(${options.id}): superó maxToolRounds (${maxToolRounds}) sin converger`,
      );
    },
  };
}
