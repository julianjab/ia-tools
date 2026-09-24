import type { Agent, AgentRunInput, AgentRunOutput } from './Agent.js';

/**
 * El adapter más simple posible: envuelve una función (`AgentRunInput => output | AgentRunOutput`)
 * como Agent. Sirve tanto para lógica determinística (parsear un webhook, pegarle a una API de
 * vuelos) como para un wrapper fino sobre un proveedor de LLM — el Pipeline no distingue.
 */
export function functionAgent<TOutput = unknown>(
  id: string,
  fn: (
    input: AgentRunInput,
  ) => Promise<TOutput | AgentRunOutput<TOutput>> | TOutput | AgentRunOutput<TOutput>,
): Agent<TOutput> {
  return {
    id,
    async run(input: AgentRunInput): Promise<AgentRunOutput<TOutput>> {
      const result = await fn(input);
      if (isAgentRunOutput<TOutput>(result)) return result;
      return { output: result, exit: 'success' };
    },
  };
}

function isAgentRunOutput<T>(value: unknown): value is AgentRunOutput<T> {
  return typeof value === 'object' && value !== null && 'output' in value;
}
