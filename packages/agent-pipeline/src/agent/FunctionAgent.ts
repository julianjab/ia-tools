import type { Agent, AgentRunInput, AgentRunOutput } from './Agent.js';

/**
 * Marca por IDENTIDAD (no por forma) para distinguir un `AgentRunOutput` explícito (hecho
 * con `withExit`) de un dato de dominio que casualmente tiene una clave `output` (ej.
 * `{ output: 'usd', amountCents: 500 }` de un agente de viajes). Antes de esto,
 * `functionAgent` decidía por duck-typing ("¿tiene una clave `output`?"), así que cualquier
 * dato de dominio con esa clave se interpretaba mal — perdía el resto de sus campos y el
 * `exit` quedaba `undefined`. Un `WeakSet` no le agrega ninguna propiedad extra al objeto
 * devuelto (a diferencia de una marca con `Symbol` en una clave), así que no aparece en un
 * `toEqual`/JSON.stringify ni en ningún otro código que inspeccione la forma del output.
 */
const explicitAgentRunOutputs = new WeakSet<object>();

/** Envuelve un output con su `exit` explícito para que `functionAgent` lo reconozca como
 *  el resultado terminado del Agent, no como el dato de dominio a envolver. */
export function withExit<TOutput>(output: TOutput, exit = 'success'): AgentRunOutput<TOutput> {
  const result: AgentRunOutput<TOutput> = { output, exit };
  explicitAgentRunOutputs.add(result);
  return result;
}

/**
 * El adapter más simple posible: envuelve una función (`AgentRunInput => output | AgentRunOutput`)
 * como Agent. Sirve tanto para lógica determinística (parsear un webhook, pegarle a una API de
 * vuelos) como para un wrapper fino sobre un proveedor de LLM — el Pipeline no distingue.
 *
 * Si tu función necesita declarar un `exit` distinto de 'success' (para que `AgentAction.emitOn`
 * lo lea), devolvé `withExit(tuOutput, 'el_exit')` en vez de un objeto `{ output, exit }` a
 * mano — ver `explicitAgentRunOutputs` arriba. Como la marca es por identidad, devolver una
 * COPIA del resultado de `withExit` (`{ ...withExit(x) }`) deja de reconocerse — no lo clones.
 */
export function functionAgent<TOutput = unknown>(
  id: string,
  fn: (
    input: AgentRunInput,
  ) => Promise<TOutput> | TOutput | Promise<AgentRunOutput<TOutput>> | AgentRunOutput<TOutput>,
): Agent<TOutput> {
  return {
    id,
    async run(input: AgentRunInput): Promise<AgentRunOutput<TOutput>> {
      const result = await fn(input);
      if (isAgentRunOutput<TOutput>(result)) return result;
      return { output: result as TOutput, exit: 'success' };
    },
  };
}

function isAgentRunOutput<T>(value: unknown): value is AgentRunOutput<T> {
  return typeof value === 'object' && value !== null && explicitAgentRunOutputs.has(value);
}
