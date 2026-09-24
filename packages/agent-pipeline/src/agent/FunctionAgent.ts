import type { Agent, AgentRunInput, AgentRunOutput } from './Agent.js';

declare const EXPLICIT_AGENT_RUN_OUTPUT_BRAND: unique symbol;

/**
 * El tipo que devuelve `withExit` — estructuralmente es un `AgentRunOutput<T>`, pero lleva
 * además una marca de TIPO (no sólo de runtime) que un objeto literal `{ output, exit }`
 * escrito a mano no tiene. Sin esta marca, `functionAgent<{ actionable: boolean }>(id, () =>
 * ({ output: {...}, exit: 'success' }))` compila igual — y en runtime ese literal NO se
 * reconoce como salida explícita (ver `explicitAgentRunOutputs` abajo), así que termina
 * doblemente envuelto: `ctx.steps.<id>.output` pasa a ser `{ output: {...}, exit }` en vez
 * de `{...}` directo, y cualquier `when` que lea `steps.<id>.output.actionable` deja de
 * matchear en silencio. Con la marca de tipo, ese mismo literal ya ni compila — hay que
 * pasar por `withExit`.
 */
export type ExplicitAgentRunOutput<TOutput> = AgentRunOutput<TOutput> & {
  readonly [EXPLICIT_AGENT_RUN_OUTPUT_BRAND]: true;
};

/**
 * Marca por IDENTIDAD para el chequeo en runtime — la marca de tipo de arriba evita el error
 * en tiempo de compilación, pero `functionAgent` igual necesita saber en runtime si ESTE
 * valor puntual vino de `withExit`. Un `WeakSet` no le agrega ninguna propiedad extra al
 * objeto devuelto (a diferencia de una marca con `Symbol` en una clave), así que no aparece
 * en un `toEqual`/JSON.stringify ni en ningún otro código que inspeccione la forma del output.
 */
const explicitAgentRunOutputs = new WeakSet<object>();

/** Envuelve un output con su `exit` explícito para que `functionAgent` lo reconozca como
 *  el resultado terminado del Agent, no como el dato de dominio a envolver. */
export function withExit<TOutput>(
  output: TOutput,
  exit = 'success',
): ExplicitAgentRunOutput<TOutput> {
  const result = { output, exit } as ExplicitAgentRunOutput<TOutput>;
  explicitAgentRunOutputs.add(result);
  return result;
}

/**
 * El adapter más simple posible: envuelve una función (`AgentRunInput => output | AgentRunOutput`)
 * como Agent. Sirve tanto para lógica determinística (parsear un webhook, pegarle a una API de
 * vuelos) como para un wrapper fino sobre un proveedor de LLM — el Pipeline no distingue.
 *
 * Si tu función necesita declarar un `exit` distinto de 'success' (para que `AgentAction.emitOn`
 * lo lea), devolvé `withExit(tuOutput, 'el_exit')` — un objeto `{ output, exit }` a mano ya NO
 * tipa acá (ver `ExplicitAgentRunOutput` arriba). Como la marca es por identidad, devolver una
 * COPIA del resultado de `withExit` (`{ ...withExit(x) }`) deja de reconocerse — no lo clones.
 */
export function functionAgent<TOutput = unknown>(
  id: string,
  fn: (
    input: AgentRunInput,
  ) =>
    | Promise<TOutput>
    | TOutput
    | Promise<ExplicitAgentRunOutput<TOutput>>
    | ExplicitAgentRunOutput<TOutput>,
): Agent<TOutput> {
  return {
    id,
    async run(input: AgentRunInput): Promise<AgentRunOutput<TOutput>> {
      const result = await fn(input);
      if (isExplicitAgentRunOutput<TOutput>(result)) return result;
      return { output: result as TOutput, exit: 'success' };
    },
  };
}

function isExplicitAgentRunOutput<T>(value: unknown): value is ExplicitAgentRunOutput<T> {
  return typeof value === 'object' && value !== null && explicitAgentRunOutputs.has(value);
}
