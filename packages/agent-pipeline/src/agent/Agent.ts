import { deriveEvent } from '../events/DomainEvent.js';
import { Runnable } from '../pipeline/Runnable.js';
import type { PipelineExecutionContext } from '../pipeline/Runnable.js';
import {
  type AgentDefinitionProps,
  type AgentExit,
  type AgentVariableValue,
  ERROR_EXIT,
  type SystemPromptRef,
  exitSet,
} from './AgentDefinition.js';
import { type ProviderRegistry, providerRegistry as defaultProviderRegistry } from './Provider.js';

/** Outcomes que NO aplican ninguna transición — el run se cortó desde afuera, no es un
 *  resultado del agente. Igual a `NO_TRANSITION_OUTCOMES` de ia-flow. */
const NO_TRANSITION_OUTCOMES = new Set(['cancelled', 'truncated']);

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
 * Un agente respaldado por un LLM — `Runnable` directo, así que se pone tal cual en
 * `Pipeline.do[]`, con su propio `id` (de `AgentDefinitionProps.id`) como key de `ctx.steps`.
 * No hace falta un paso intermedio que lo resuelva por id desde un registry: reusar el mismo
 * agente en dos pipelines es, como con cualquier otro objeto de JS/TS, importar la misma
 * instancia dos veces.
 *
 * Es el único puente entre "cómo se declara un agente" (`AgentDefinitionProps`, config
 * portable de ia-flow) y "cómo lo corre agent-pipeline" (`Runnable.run`) — ningún `Provider`
 * conoce `{{...}}` ni `exits`; eso vive acá, una sola vez.
 */
export class Agent extends Runnable {
  readonly definition: AgentDefinitionProps;
  private readonly registry: ProviderRegistry;

  constructor(
    definition: AgentDefinitionProps,
    registry: ProviderRegistry = defaultProviderRegistry,
  ) {
    super({
      id: definition.id,
      when: definition.when,
      continueOnError: definition.continueOnError,
    });
    this.definition = definition;
    this.registry = registry;
  }

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    const def = this.definition;
    const provider = this.registry.resolve(def.provider);
    if (provider == null) {
      throw new Error(
        `Agent(${def.id}): provider desconocido "${def.provider}" — ¿lo registraste con providerRegistry.register(...)?`,
      );
    }

    const payload =
      typeof ctx.event.payload === 'object' && ctx.event.payload !== null
        ? (ctx.event.payload as Record<string, unknown>)
        : {};
    const variables = def.variables ?? {};
    const root: Record<string, unknown> = {
      ...payload,
      steps: ctx.steps,
      variables: renderedVariables(variables),
    };
    const prompt = interpolate(def.prompt, root);

    const result = await provider.run({
      agentId: def.id,
      prompt,
      systemPrompts: resolveSystemPrompts(def.systemPrompts ?? []),
      variables,
      providerConfig: def.providerConfig ?? {},
      mcpServers: def.mcpServers ?? [],
      tools: def.tools ?? [],
      ctx,
    });

    const exits = def.exits ?? {};
    const exit = exitSet(matchExit(exits, result.outcome));

    const derivedType = def.emitOn?.(exit ?? 'success');
    if (derivedType) {
      const basePayload =
        typeof result === 'object' && result !== null
          ? (result as unknown as Record<string, unknown>)
          : { output: result };
      // ACOPLAMIENTO DELIBERADO: este `await` significa que si algún Pipeline que escucha
      // `derivedType` falla, ese fallo (un AggregateError — ver EventBus.publish) se propaga
      // hasta ACÁ y aborta este paso, aunque el provider ya haya corrido con éxito (y con
      // cualquier efecto de lado que eso implique, ej. un PR ya abierto). El resultado nunca
      // llega a `ctx.steps` en ese caso. Es la misma garantía que le da `Engine.dispatch` a
      // quien llama `bus.publish` en la raíz — un fallo aguas abajo tiene que ser visible, no
      // tragado en silencio — a costa de que un `Agent` con `emitOn` no sea "fire and forget".
      // Si preferís que ESTE paso no dependa de lo que pase después, marcá `continueOnError:
      // true` en la definición.
      await ctx.bus.publish(
        deriveEvent(ctx.event, derivedType, { ...basePayload, agentId: def.id }),
      );
    }

    return { output: result, exit };
  }
}
