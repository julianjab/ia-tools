import { basename } from 'node:path';
import {
  type Action,
  Agent,
  type AllowedAction,
  Condition,
  END,
  type ErrorRoute,
  type ExitDefaults,
  type ExitRoute,
  Pipeline,
  Project,
  type RouteTarget,
  type RouteTo,
  type Runnable,
  type Tool,
} from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import type { StepBuildContext } from './StepFactory.js';
import { StepFactoryRegistry } from './StepFactoryRegistry.js';
import { type ToolLookup, type YamlCatalogs, lookup } from './YamlCatalogs.js';
import { located } from './located.js';
import type { AgentDoc, ErrorRouteNode, ExitRouteNode, PipelineDoc, ProjectDoc } from './schema.js';

/** Un documento con el archivo del que salió. */
export interface Located<T> {
  path: string;
  doc: T;
}

/** Lo que se leyó de la carpeta de un proyecto. */
export interface ProjectDocs {
  dir: string;
  project: Located<ProjectDoc>;
  agents: Located<AgentDoc>[];
  pipelines: Located<PipelineDoc>[];
}

const RefNode = z.strictObject({ ref: z.string().min(1) });

type DefaultsNode = {
  onError?: z.infer<typeof ErrorRouteNode> | null;
  report?: Record<string, unknown> | null;
};

/**
 * Arma un `Project` a partir de sus documentos: agentes (uno por id, compartido por todas las
 * pipelines del proyecto), pipelines y los defaults del proyecto. Cada paso lo arma su factory
 * (`StepFactoryRegistry`); `{ ref: <id> }` reusa un paso ya declarado antes en el `do` de la
 * misma pipeline. Se usa una vez por carga.
 */
export class ProjectBuilder {
  private readonly steps: StepFactoryRegistry;
  private readonly agentDocs = new Map<string, Located<AgentDoc>>();
  private readonly agents = new Map<string, Agent>();
  private readonly building = new Set<string>();

  constructor(private readonly catalogs: YamlCatalogs = {}) {
    this.steps = new StepFactoryRegistry(catalogs.steps);
  }

  build(docs: ProjectDocs): Project {
    for (const located of docs.agents) {
      const existing = this.agentDocs.get(located.doc.id);
      if (existing) {
        throw new Error(
          `${located.path}: el agente "${located.doc.id}" ya está definido en ${existing.path}`,
        );
      }
      this.agentDocs.set(located.doc.id, located);
    }
    const pipelines = docs.pipelines.map((located) => this.pipeline(located));
    const { path, doc } = docs.project;
    const context = this.context(path, new Map());
    return located(
      path,
      () =>
        new Project({
          id: doc.id ?? basename(docs.dir),
          when: Condition.fromRows(doc.when),
          pipelines,
          ...this.defaults(doc, context, path),
        }),
    );
  }

  private agent(id: string): Agent {
    const built = this.agents.get(id);
    if (built) return built;
    const located = this.agentDocs.get(id);
    if (!located) {
      throw new Error(
        `no hay un agente "${id}" en agents/ — hay: ${[...this.agentDocs.keys()].join(', ') || 'ninguno'}`,
      );
    }
    if (this.building.has(id)) {
      throw new Error(`${located.path}: el agente "${id}" se referencia a sí mismo al armarse`);
    }
    this.building.add(id);
    const agent = this.buildAgent(located);
    this.building.delete(id);
    this.agents.set(id, agent);
    return agent;
  }

  private buildAgent({ path, doc }: Located<AgentDoc>): Agent {
    const context = this.context(path, new Map());
    const where = (rel: string) => `${path}: ${rel}`;
    return located(
      path,
      () =>
        new Agent(
          {
            id: doc.id,
            provider: doc.provider,
            prompt: doc.prompt,
            ...(doc.input ? { input: lookup(this.catalogs.schemas, doc.input, 'un schema') } : {}),
            systemPrompts: doc.systemPrompts,
            variables: doc.variables,
            tools: doc.tools?.map((name) => this.tool(name)),
            actions: doc.actions?.map((entry) => this.agentAction(entry)),
            onStart: doc.onStart?.map((node, i) => context.step(node, where(`onStart[${i}]`))),
            injects: doc.injects?.map((filter) => ({
              on: filter.on,
              when: Condition.fromRows(filter.when),
            })),
            providerConfig: doc.providerConfig,
            mcpServers: doc.mcpServers,
            continueOnError: doc.continueOnError,
            when: Condition.fromRows(doc.when),
            routes: this.exitRoutes(doc.routes, context, where('routes')) as Record<
              string,
              ExitRoute
            >,
            ...this.defaults(doc, context, path),
          },
          this.catalogs.providers,
          this.catalogs.systemPrompts,
        ),
    );
  }

  private pipeline({ path, doc }: Located<PipelineDoc>): Pipeline {
    const local = new Map<string, Runnable>();
    const context = this.context(path, local);
    const steps = doc.do.map((node, i) => {
      const step = context.step(node, `${path}: do[${i}]`);
      if (step.id) local.set(step.id, step);
      return step;
    });
    const routes = Object.fromEntries(
      Object.entries(doc.routes ?? {}).map(([agentId, override]) => [
        agentId,
        {
          routes: this.exitRoutes(override.routes, context, `${path}: routes.${agentId}.routes`),
          ...this.defaults(override, context, `${path}: routes.${agentId}`),
        },
      ]),
    );
    return located(
      path,
      () =>
        new Pipeline({
          id: doc.id,
          on: doc.on,
          scope: doc.scope,
          enabled: doc.enabled,
          position: doc.position,
          exclusive: doc.exclusive,
          ifRunning: doc.ifRunning,
          ifPaused: doc.ifPaused,
          when: Condition.fromRows(doc.when),
          do: steps,
          routes,
          ...this.defaults(doc, context, path),
        }),
    );
  }

  private context(path: string, local: Map<string, Runnable>): StepBuildContext {
    const make = (where: string): StepBuildContext => ({
      catalogs: this.catalogs,
      where,
      step: (node, at) => this.step(node, at, local, make(at)),
      routeTo: (node, at) => this.routeTo(node, make(at)),
      agent: (id) => located(where, () => this.agent(id)),
    });
    return make(path);
  }

  private step(
    node: unknown,
    where: string,
    local: Map<string, Runnable>,
    context: StepBuildContext,
  ): Runnable {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new Error(`${where}: un paso es un objeto (ej. { action: postComment })`);
    }
    const ref = RefNode.safeParse(node);
    if (ref.success) {
      const step = local.get(ref.data.ref);
      if (!step) {
        throw new Error(
          `${where}: no hay un paso con id "${ref.data.ref}" antes en el do de esta pipeline`,
        );
      }
      return step;
    }
    return this.steps.create(node as Record<string, unknown>, context);
  }

  private routeTo(node: unknown, context: StepBuildContext): RouteTo | undefined {
    if (node === undefined) return undefined;
    const target = (entry: unknown, at: string): RouteTarget =>
      entry === 'end' ? END : context.step(entry, at);
    if (Array.isArray(node)) {
      return node.map((entry, i) => target(entry, `${context.where}[${i}]`));
    }
    return target(node, context.where);
  }

  private exitRoutes(
    routes: Record<string, z.infer<typeof ExitRouteNode> | null> | undefined,
    context: StepBuildContext,
    where: string,
  ): Record<string, ExitRoute | null> | undefined {
    if (!routes) return undefined;
    return Object.fromEntries(
      Object.entries(routes).map(([name, route]) => {
        if (route === null) return [name, null];
        const to = context.routeTo(route.to, `${where}.${name}.to`);
        return [
          name,
          {
            ...(route.when !== undefined ? { when: route.when } : {}),
            ...(to !== undefined ? { to } : {}),
            ...(route.report !== undefined
              ? {
                  report:
                    route.report === null
                      ? null
                      : context.step(route.report, `${where}.${name}.report`),
                }
              : {}),
          },
        ];
      }),
    );
  }

  private defaults(node: DefaultsNode, context: StepBuildContext, where: string): ExitDefaults {
    return {
      ...(node.onError !== undefined
        ? {
            onError: node.onError === null ? null : this.errorRoute(node.onError, context, where),
          }
        : {}),
      ...(node.report !== undefined
        ? {
            report: node.report === null ? null : context.step(node.report, `${where}: report`),
          }
        : {}),
    };
  }

  private errorRoute(
    node: z.infer<typeof ErrorRouteNode>,
    context: StepBuildContext,
    where: string,
  ): ErrorRoute {
    const to = context.routeTo(node.to, `${where}: onError.to`);
    const mapper = (name: string) =>
      located(`${where}: onError`, () => lookup(this.catalogs.mappers, name, 'un mapper'));
    return {
      ...(to !== undefined ? { to } : {}),
      ...(node.input ? { input: mapper(node.input) } : {}),
      ...(node.report ? { report: mapper(node.report) } : {}),
    };
  }

  private tool(name: string): Tool {
    const tools = this.catalogs.tools;
    if (tools && typeof (tools as ToolLookup).get === 'function') {
      return (tools as ToolLookup).get(name);
    }
    return lookup(tools as Record<string, Tool> | undefined, name, 'una tool');
  }

  private agentAction(entry: NonNullable<AgentDoc['actions']>[number]): Action | AllowedAction {
    if (typeof entry === 'string') return lookup(this.catalogs.actions, entry, 'una acción');
    const action = lookup(this.catalogs.actions, entry.action, 'una acción');
    const bound = entry.with ? action.bind(entry.with as Partial<unknown>) : action;
    return entry.allowWrite ? bound.allowWrite() : bound;
  }
}
