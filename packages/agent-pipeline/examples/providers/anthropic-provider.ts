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

        if (data.stop_reason === 'max_tokens') {
          // Se quedó sin tokens a mitad de la respuesta — `text` puede venir vacío (si el
          // corte cayó dentro de un `tool_use`) o parcial. NO es un resultado del agente
          // (nadie decidió terminar así), así que el outcome es 'truncated' — el mismo que
          // `agent.ts` ya trata como NO_TRANSITION_OUTCOMES: `matchExit` no aplica ninguna
          // transición para esto, en vez de que un texto cortado a la mitad se lea como
          // 'success' y dispare igual la transición normal.
          const text = data.content.find((block) => block.type === 'text')?.text ?? '';
          return { outcome: 'truncated', summary: text };
        }

        if (data.stop_reason === 'end_turn' || data.stop_reason === 'stop_sequence') {
          const text = data.content.find((block) => block.type === 'text')?.text ?? '';
          return { outcome: options.resolveOutcome?.(text) ?? 'success', summary: text };
        }

        if (data.stop_reason !== 'tool_use') {
          // `null`, o cualquier otro stop_reason que la API llegue a agregar — no lo
          // adivinamos como éxito. Mejor un error explícito que un run que se reporta bien
          // sin haber terminado como se esperaba.
          throw new Error(
            `anthropicProvider(${options.id}): stop_reason inesperado "${data.stop_reason}"`,
          );
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
              if (tool == null) {
                return {
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: `Error: no existe una tool registrada con nombre "${block.name}"`,
                  is_error: true,
                };
              }
              // Un `handler` que tira (input inválido, la API de negocio de abajo falla) no
              // puede tumbar el loop entero — el modelo tiene que verlo como un `tool_result`
              // con `is_error: true` para poder corregirse (reintentar con otro input, avisar
              // al usuario), en vez de que el run entero termine en una excepción no manejada.
              try {
                const result = await tool.handler(block.input);
                return { type: 'tool_result', tool_use_id: block.id, content: String(result) };
              } catch (err) {
                return {
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: `Error: ${err instanceof Error ? err.message : String(err)}`,
                  is_error: true,
                };
              }
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
