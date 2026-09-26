import { z } from 'zod';
import { Runnable } from '../pipeline/Runnable.js';
import type { PipelineExecutionContext } from '../pipeline/Runnable.js';
import { AllowedAction } from '../pipeline/actions/Action.js';
import {
  type ExitRoutes,
  type ResolvedExit,
  resolveRoutes,
  routeTargets,
  submitSchemaFor,
} from '../routing/ExitRoutes.js';
import type {
  AgentDefinitionProps,
  AgentVariableValue,
  SystemPromptRef,
  Tool,
} from './AgentDefinition.js';
import {
  type ProviderRegistry,
  type ProviderRunOutput,
  providerRegistry as defaultProviderRegistry,
} from './Provider.js';
import { SchemaTool, type ToolInputSchema } from './SchemaTool.js';

/** Outcomes que NO aplican ninguna salida — el run se cortó desde afuera, no es un resultado
 *  del agente. Igual a `NO_TRANSITION_OUTCOMES` de ia-flow. */
export const NO_TRANSITION_OUTCOMES = new Set(['cancelled', 'truncated']);

/** Lo que devuelve `Agent.run` y queda en `ctx.steps[id]`. */
export interface AgentRunResult {
  output: ProviderRunOutput;
  /** La salida elegida. `undefined` si la corrida se cortó (`truncated`/`cancelled`). */
  exit?: string;
  /** Lo que el modelo entregó en `submit_<exit>`: `{ report?, <idDestino>: input, ... }`. */
  payload?: Record<string, unknown>;
}

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

function acceptsEmpty(agentId: string, exit: ResolvedExit): boolean {
  return submitSchemaFor(agentId, exit).safeParse({}).success;
}

interface Submission {
  exit: string;
  payload: Record<string, unknown>;
}

/** Nombre de la tool con la que el modelo cierra su turno declarando que falló. */
export const FAIL_TOOL_NAME = 'fail_turn';

const FailInput = z.strictObject({
  reason: z.string().min(1).describe('Por qué no pudiste terminar: qué falta, qué bloquea'),
});

/** El equivalente de `fail_task` de ia-flow: el modelo no puede o no debe terminar el trabajo
 *  (ambigüedad de producto, un bloqueo que no le toca resolver). La corrida falla con ese motivo
 *  y la pipeline aplica el `onError` de la cascada — ej. `+blocked` con el motivo en el reporte. */
function failTool(onFail: (reason: string) => void): Tool {
  return new (class extends SchemaTool<typeof FailInput> {
    readonly name = FAIL_TOOL_NAME;
    readonly description =
      'Terminá tu turno declarando que NO pudiste completar el trabajo. Usala ante ambigüedad o un bloqueo que no te corresponde resolver, en vez de improvisar.';
    readonly input = FailInput;
    readonly terminal = true;
    readonly failure = true;

    protected execute(input: z.infer<typeof FailInput>): string {
      onFail(input.reason);
      return 'Falla registrada. Tu turno terminó.';
    }
  })();
}

function submitTool(
  agentId: string,
  exit: ResolvedExit,
  onSubmit: (submission: Submission) => void,
): Tool {
  const schema = submitSchemaFor(agentId, exit);
  const description = exit.when
    ? `Terminá tu turno con la salida "${exit.name}". Usala cuando: ${exit.when}`
    : `Terminá tu turno con la salida "${exit.name}".`;
  return new (class extends SchemaTool<ToolInputSchema> {
    readonly name = `submit_${exit.name}`;
    readonly description = description;
    readonly input = schema;
    readonly terminal = true;

    protected execute(input: Record<string, unknown>): string {
      onSubmit({ exit: exit.name, payload: input });
      return `Salida "${exit.name}" registrada. Tu turno terminó.`;
    }
  })();
}

/**
 * Un agente respaldado por un LLM — `Runnable` directo, así que se pone tal cual en
 * `Pipeline.do[]` o como destino de una ruta, con su propio `id` como key de `ctx.steps`.
 *
 * Termina eligiendo una SALIDA: por cada salida resuelta (ver `resolveRoutes`) el modelo recibe
 * una tool `submit_<salida>` cuyo schema es el input de los pasos a los que lleva. Qué pasos
 * corren después, y en qué orden, lo decide `Pipeline` — el agente sólo reporta qué eligió y con
 * qué datos. Ningún `Provider` conoce `{{...}}` ni las salidas; eso vive acá, una sola vez.
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
    this.assertBaseRoutesTargetActions();
    this.assertWriteActionsAllowed();
  }

  /** Las rutas BASE del agente — la pipeline las sobrescribe o elimina (ver `resolveRoutes`). */
  get exitRoutes(): ExitRoutes {
    const { routes, onError, report } = this.definition;
    return { routes, onError, report };
  }

  override acceptsInput(): ToolInputSchema | undefined {
    return this.definition.input;
  }

  async run(ctx: PipelineExecutionContext, input?: unknown): Promise<AgentRunResult> {
    const def = this.definition;
    const provider = this.registry.resolve(def.provider);
    if (provider == null) {
      throw new Error(
        `Agent(${def.id}): provider desconocido "${def.provider}" — ¿lo registraste con providerRegistry.register(...)?`,
      );
    }

    const parsedInput = this.parseInput(def.input, input) ?? {};
    const routes =
      ctx.routesFor?.(this) ?? resolveRoutes(def.id, this.exitRoutes, { project: ctx.defaults });

    for (const step of [def.onStart ?? []].flat()) await step.run(ctx);

    const payload =
      typeof ctx.event.payload === 'object' && ctx.event.payload !== null
        ? (ctx.event.payload as Record<string, unknown>)
        : {};
    const variables = def.variables ?? {};
    const root: Record<string, unknown> = {
      ...payload,
      steps: ctx.steps,
      variables: renderedVariables(variables),
      input: parsedInput,
    };

    let submission: Submission | undefined;
    let failure: string | undefined;
    const assertOpen = () => {
      if (submission) {
        throw new Error(
          `Ya elegiste la salida "${submission.exit}" — un turno termina con una sola.`,
        );
      }
      if (failure !== undefined) throw new Error('Ya declaraste que el turno falló.');
    };
    const submitTools = routes.exits.map((exit) =>
      submitTool(def.id, exit, (next) => {
        assertOpen();
        submission = next;
      }),
    );
    submitTools.push(
      failTool((reason) => {
        assertOpen();
        failure = reason;
      }),
    );
    const actionTools = (def.actions ?? []).map((entry) =>
      (entry instanceof AllowedAction ? entry.action : entry).asTool(ctx),
    );
    const tools = [...(def.tools ?? []), ...actionTools, ...submitTools];
    this.assertUniqueToolNames(tools);

    const output = await provider.run({
      agentId: def.id,
      prompt: interpolate(def.prompt, root),
      systemPrompts: resolveSystemPrompts(def.systemPrompts ?? []),
      variables,
      providerConfig: def.providerConfig ?? {},
      mcpServers: def.mcpServers ?? [],
      tools,
      ctx,
    });

    if (NO_TRANSITION_OUTCOMES.has(output.outcome)) return { output };
    if (failure !== undefined) {
      throw new Error(`Agent(${def.id}): el agente declaró que falló: ${failure}`);
    }
    if (output.outcome === 'error') {
      throw new Error(
        `Agent(${def.id}): el provider reportó error${output.summary ? `: ${output.summary}` : ''}`,
      );
    }

    if (!submission) {
      // Un provider sin tools (un CLI, un modelo sin tool use) no puede llamar `submit_*`: se le
      // acepta el outcome como nombre de salida, o la única salida, SI esa salida no pide datos.
      const byOutcome = routes.exits.find((exit) => exit.name === output.outcome);
      const candidate = byOutcome ?? (routes.exits.length === 1 ? routes.exits[0] : undefined);
      if (candidate && acceptsEmpty(def.id, candidate)) {
        submission = { exit: candidate.name, payload: {} };
      } else {
        const names = routes.exits.map((exit) => `submit_${exit.name}`).join(', ');
        throw new Error(
          `Agent(${def.id}): terminó sin elegir salida — tenía que llamar a ${names}`,
        );
      }
    }

    return { output, exit: submission.exit, payload: submission.payload };
  }

  /** Encadenar agentes lo decide la pipeline, donde se ve el grafo completo: una ruta BASE que
   *  apuntara a otro agente arrastraría su grafo a cualquier pipeline que incluya a éste. */
  private assertBaseRoutesTargetActions(): void {
    const def = this.definition;
    const targets = [
      ...Object.values(def.routes ?? {}).flatMap((route) => routeTargets(route?.to)),
      ...routeTargets(def.onError?.to),
    ];
    const agent = targets.find((target) => target instanceof Agent);
    if (agent) {
      throw new Error(
        `Agent(${def.id}): una ruta base apunta al agente "${agent.id}" — encadenar agentes se declara en la pipeline`,
      );
    }
  }

  private assertWriteActionsAllowed(): void {
    for (const entry of this.definition.actions ?? []) {
      if (entry instanceof AllowedAction || entry.sideEffects !== 'write') continue;
      throw new Error(
        `Agent(${this.definition.id}): la acción "${entry.id}" escribe — pasala como ${entry.id}.allowWrite() si el agente puede usarla`,
      );
    }
  }

  private assertUniqueToolNames(tools: Tool[]): void {
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new Error(`Agent(${this.definition.id}): dos tools con el nombre "${tool.name}"`);
      }
      seen.add(tool.name);
    }
  }
}
