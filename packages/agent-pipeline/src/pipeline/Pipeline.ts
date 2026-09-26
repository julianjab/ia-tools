import { createLogger, traced } from '@ia-tools/telemetry';
import { Agent, type AgentRunResult } from '../agent/Agent.js';
import { Conditional, type ConditionalProps } from '../condition/Conditional.js';
import type { DomainEvent } from '../events/DomainEvent.js';
import {
  type ErrorRoute,
  type ExitDefaults,
  type ExitRoutes,
  type ResolvedExit,
  type ResolvedRoutes,
  resolveRoutes,
  routeTargets,
  submitSchemaFor,
} from '../routing/ExitRoutes.js';
import type { PipelineExecutionContext, Runnable } from './Runnable.js';
import { pipelineTrace, stepTrace } from './tracing.js';

/** Por qué corrió un paso — queda en su span (`ia.step.via`): `do` (en orden), `exit:<salida>`,
 *  `report:<salida>`, `onError` u `onError.report`. */
export type StepVia = string;

/** Cómo terminó un paso que corrió: su salida (y la del agente, si eligió una), o el error que
 *  cubrió un `onError`/`continueOnError`. Un error sin cubrir no llega acá: se propaga. */
export type StepRun =
  | { output: unknown; exit?: { exit: ResolvedExit; payload: Record<string, unknown> } }
  | { error: Error; handledBy: 'onError' | 'continueOnError' };

export type IfRunning = 'wait' | 'inject' | 'skip';

export interface PipelineProps extends ConditionalProps, ExitDefaults {
  id: string;
  /** Tipos de DomainEvent que este pipeline escucha — al menos uno. */
  on: string[];
  /**
   * Filtro sobre `event.scope` — cada clave presente acá tiene que matchear EXACTO en el
   * evento (fail-closed, igual que `Pipeline.matchesScope` de engine-v2, pero genérico:
   * cualquier clave de scope, no sólo projectId/repoName). Ausente = sin restricción.
   */
  scope?: Record<string, unknown>;
  enabled?: boolean;
  position?: number;
  /** Si matchea, impide que corran los pipelines de menor prioridad para este evento. */
  exclusive?: boolean;
  /**
   * Qué hacer si la task del evento ya tiene una ejecución corriendo (una task nunca corre dos a
   * la vez). Sólo aplica a pipelines con agentes y a un `Engine` con `executions`:
   * - `wait` (default): espera a que termine y corre después.
   * - `inject`: le entrega el evento a la ejecución que corre — el agente lo lee en su próxima
   *   vuelta — y esta pipeline no arranca.
   * - `skip`: lo descarta.
   */
  ifRunning?: IfRunning;
  do: Runnable[];
  /**
   * Overrides de rutas por agente (clave: el `id` del agente) — el nivel "paso" de la cascada.
   * Cambiar el `to` de una salida, eliminarla con `null`, o cambiar su `onError`/`report`.
   * Nunca crear una salida que el agente no declara.
   */
  routes?: Record<string, ExitRoutes>;
}

/**
 * Filtra eventos y recorre su `do`, acumulando el output de cada paso nombrado en `ctx.steps`.
 *
 * Los pasos corren en orden, salvo los que son DESTINO de alguna ruta: esos sólo corren cuando
 * un agente elige la salida que lleva a ellos, con el input que el agente entregó. Al elegir una
 * salida corre primero su `report` (el cierre del turno) y después sus destinos en orden — el
 * orden importa: el siguiente agente tiene que ver ese comentario.
 *
 * Todo el cableado se valida al construir: salidas sin destino, overrides de salidas o agentes
 * que no existen, ciclos entre agentes, claves repetidas en un `submit_*`.
 */
export class Pipeline extends Conditional {
  readonly log = createLogger('agent-pipeline.pipeline');
  readonly id: string;
  readonly on: string[];
  readonly scope?: Record<string, unknown>;
  readonly enabled: boolean;
  readonly position: number;
  readonly exclusive: boolean;
  readonly ifRunning: IfRunning;
  readonly do: Runnable[];
  readonly defaults: ExitDefaults;
  private readonly stepRoutes: Record<string, ExitRoutes>;
  private readonly routedTargets: Set<Runnable>;

  constructor(props: PipelineProps) {
    super(props);
    this.id = props.id;
    this.on = props.on;
    this.scope = props.scope;
    this.enabled = props.enabled ?? true;
    this.position = props.position ?? 0;
    this.exclusive = props.exclusive ?? false;
    this.ifRunning = props.ifRunning ?? 'wait';
    this.do = props.do;
    this.defaults = { onError: props.onError, report: props.report };
    this.stepRoutes = props.routes ?? {};
    this.routedTargets = this.validate();
  }

  /** Si algún paso (o destino de una salida) es un agente: sólo esas corridas son ejecuciones. */
  get runsAgents(): boolean {
    return this.reachableAgents().size > 0;
  }

  /** Las rutas efectivas de un agente en esta pipeline, con el origen de cada una. Con
   *  `project`, incluye los defaults del proyecto — lo que efectivamente va a correr. */
  routesOf(agentId: string, project?: ExitDefaults): ResolvedRoutes {
    const agent = this.reachableAgents().get(agentId);
    if (!agent) throw new Error(`Pipeline(${this.id}): no corre ningún agente "${agentId}"`);
    return this.resolve(agent, project);
  }

  // `DomainEvent<any>`, no el `DomainEvent` a secas (que resuelve a `DomainEvent<Record<string,
  // unknown>>`): el Engine/Pipeline no le exige forma al payload de cada evento — eso es cosa
  // de cada Agent tipado que lo consume — así que forzar el genérico por defecto acá rechazaría
  // cualquier evento creado con un payload propio (`createEvent<GithubIssuePayload>(...)`).
  matches(event: DomainEvent<any>): boolean {
    return this.explainMismatch(event) === undefined;
  }

  /** Por qué esta pipeline NO corre para `event`, o `undefined` si matchea — lo que queda en la
   *  traza del evento para cada regla que no corrió. */
  explainMismatch(event: DomainEvent<any>): string | undefined {
    if (!this.enabled) return 'deshabilitada';
    if (!this.on.includes(event.type)) return `no escucha "${event.type}"`;
    for (const [key, value] of Object.entries(this.scope ?? {})) {
      if (event.scope?.[key] !== value) {
        return `scope.${key}: esperaba ${JSON.stringify(value)}, vino ${JSON.stringify(event.scope?.[key]) ?? 'nada'}`;
      }
    }
    return this.explainConditions(event.payload);
  }

  /**
   * Corre `this.do` en orden; cada paso puede leer `ctx.steps` de los anteriores. Un paso
   * saltado (`shouldRun` false) no deja rastro en `ctx.steps`. Un error frena el Pipeline
   * salvo que haya un `onError` que lo maneje (del paso — o la cascada completa, si es un
   * agente —, de la pipeline o del proyecto) o el paso tenga `continueOnError`.
   */
  @traced(pipelineTrace)
  async execute(ctx: PipelineExecutionContext): Promise<Record<string, unknown>> {
    const runCtx: PipelineExecutionContext = {
      ...ctx,
      pipelineId: this.id,
      routesFor: (step) => (step instanceof Agent ? this.resolve(step, ctx.defaults) : undefined),
    };
    for (const step of this.do) {
      if (this.routedTargets.has(step)) continue;
      await this.runStep(step, undefined, runCtx, 'do');
    }
    return runCtx.steps;
  }

  /** `handleErrors: false` para los pasos que corren DENTRO de un `onError`: si fallara, por
   *  ejemplo, el `+blocked` del proyecto, volver a aplicar ese mismo `onError` sería un loop. */
  private async runStep(
    step: Runnable,
    input: unknown,
    ctx: PipelineExecutionContext,
    via: StepVia,
    handleErrors = true,
  ): Promise<void> {
    if (step.shouldRun(ctx)) await this.runDueStep(step, input, ctx, via, handleErrors);
  }

  @traced(stepTrace)
  private async runDueStep(
    step: Runnable,
    input: unknown,
    ctx: PipelineExecutionContext,
    _via: StepVia,
    handleErrors = true,
  ): Promise<StepRun> {
    let out: unknown;
    try {
      out = await step.run(ctx, input);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const handling = handleErrors ? this.errorHandling(step, ctx) : null;
      if (!handling && !step.continueOnError) throw err;
      if (!handling) return { error, handledBy: 'continueOnError' };
      if (step.id) ctx.steps[step.id] = { error: error.message };
      await this.runErrorRoute(handling.report, handling.route, error, ctx);
      return { error, handledBy: 'onError' };
    }
    if (step.id) ctx.steps[step.id] = out;
    if (!(step instanceof Agent)) return { output: out };

    const result = out as AgentRunResult;
    if (result.exit === undefined) return { output: out };
    const exit = this.resolve(step, ctx.defaults).exits.find((e) => e.name === result.exit);
    if (!exit) return { output: out };
    const payload = result.payload ?? {};
    if (exit.report) await this.runStep(exit.report, payload.report, ctx, `report:${exit.name}`);
    for (const target of exit.targets) {
      await this.runStep(
        target,
        target.id ? payload[target.id] : undefined,
        ctx,
        `exit:${exit.name}`,
      );
    }
    return { output: out, exit: { exit, payload } };
  }

  /** El `onError` que aplica a un paso, y el `report` con el que se anuncia. Un agente usa su
   *  cascada completa; cualquier otro paso: el suyo > el de la pipeline > el del proyecto. */
  private errorHandling(
    step: Runnable,
    ctx: PipelineExecutionContext,
  ): { route: ErrorRoute; report: Runnable | null } | null {
    if (step instanceof Agent) {
      const resolved = this.resolve(step, ctx.defaults);
      return resolved.onError
        ? { route: resolved.onError.route, report: resolved.report?.target ?? null }
        : null;
    }
    const route = firstSet(step.onError, this.defaults.onError, ctx.defaults?.onError);
    if (!route) return null;
    return { route, report: firstSet(this.defaults.report, ctx.defaults?.report) ?? null };
  }

  private async runErrorRoute(
    report: Runnable | null,
    route: ErrorRoute,
    error: Error,
    ctx: PipelineExecutionContext,
  ): Promise<void> {
    if (report && route.report) {
      await this.runStep(report, route.report(error), ctx, 'onError.report', false);
    }
    for (const target of routeTargets(route.to)) {
      await this.runStep(target, route.input?.(error), ctx, 'onError', false);
    }
  }

  private resolve(agent: Agent, project?: ExitDefaults): ResolvedRoutes {
    return resolveRoutes(agent.id as string, agent.exitRoutes, {
      project,
      pipeline: this.defaults,
      step: this.stepRoutes[agent.id as string],
    });
  }

  /** Los agentes de `do[]` más los que alcanzan las rutas, por id. */
  private reachableAgents(): Map<string, Agent> {
    const agents = new Map<string, Agent>();
    const visit = (step: Runnable) => {
      if (!(step instanceof Agent)) return;
      const existing = agents.get(step.id as string);
      if (existing === step) return;
      if (existing) {
        throw new Error(`Pipeline(${this.id}): dos agentes distintos con el id "${step.id}"`);
      }
      agents.set(step.id as string, step);
      for (const route of Object.values(this.stepRoutes[step.id as string]?.routes ?? {})) {
        for (const target of routeTargets(route?.to)) visit(target);
      }
    };
    for (const step of this.do) visit(step);
    return agents;
  }

  private validate(): Set<Runnable> {
    const agents = this.reachableAgents();
    for (const agentId of Object.keys(this.stepRoutes)) {
      if (!agents.has(agentId)) {
        throw new Error(
          `Pipeline(${this.id}): routes.${agentId} sobrescribe un agente que la pipeline no corre`,
        );
      }
    }

    const routed = new Set<Runnable>();
    const next = new Map<Agent, Agent[]>();
    for (const agent of agents.values()) {
      const resolved = this.resolve(agent);
      const children: Agent[] = [];
      for (const exit of resolved.exits) {
        submitSchemaFor(agent.id as string, exit);
        for (const target of exit.targets) {
          routed.add(target);
          if (target instanceof Agent) children.push(target);
        }
        if (exit.report) routed.add(exit.report);
      }
      for (const target of routeTargets(resolved.onError?.route.to)) routed.add(target);
      next.set(agent, children);
    }
    for (const step of this.do) {
      for (const target of routeTargets(step.onError?.to)) routed.add(target);
    }
    for (const target of routeTargets(this.defaults.onError?.to)) routed.add(target);
    this.assertNoCycles(next);
    return routed;
  }

  private assertNoCycles(next: Map<Agent, Agent[]>): void {
    const done = new Set<Agent>();
    const visiting: Agent[] = [];
    const walk = (agent: Agent) => {
      if (done.has(agent)) return;
      const at = visiting.indexOf(agent);
      if (at !== -1) {
        const cycle = [...visiting.slice(at), agent].map((a) => a.id).join(' → ');
        throw new Error(
          `Pipeline(${this.id}): ciclo entre agentes (${cycle}) — un loop pasa por un evento, no por una ruta`,
        );
      }
      visiting.push(agent);
      for (const child of next.get(agent) ?? []) walk(child);
      visiting.pop();
      done.add(agent);
    };
    for (const agent of next.keys()) walk(agent);
  }
}

/** El primer valor definido, del nivel más específico al más general. `null` corta: "ninguno". */
function firstSet<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return null;
}

/** Type guard útil para quien construye pipelines dinámicamente desde config — distingue un
 *  paso respaldado por LLM de un `Runnable` genérico (Emit/Http/Function). */
export function isAgent(step: Runnable): step is Agent {
  return step instanceof Agent;
}
