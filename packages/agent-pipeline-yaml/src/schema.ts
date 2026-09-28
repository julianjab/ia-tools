/**
 * La forma de cada archivo YAML. Los pasos son nodos abiertos (`StepNode`): cada tipo de paso los
 * valida con su propia factory.
 */
import { z } from 'zod';

const CONDITION_OPS = [
  'eq',
  'neq',
  'exists',
  'notExists',
  'in',
  'notIn',
  'contains',
  'notContains',
  'matches',
  'gt',
  'gte',
  'lt',
  'lte',
] as const;

export const ConditionRows = z.array(
  z.strictObject({
    field: z.string().min(1),
    op: z.enum(CONDITION_OPS),
    value: z.unknown().optional(),
    logic: z.enum(['and', 'or']).optional(),
  }),
);

export const StepNode = z.record(z.string(), z.unknown());
export type StepNode = z.infer<typeof StepNode>;

/** `end`, un paso o una lista de pasos. */
export const RouteToNode = z.union([
  z.literal('end'),
  StepNode,
  z.array(z.union([z.literal('end'), StepNode])),
]);

export const ExitRouteNode = z.strictObject({
  when: z.string().optional(),
  to: RouteToNode.optional(),
  report: StepNode.nullable().optional(),
});

export const ErrorRouteNode = z.strictObject({
  to: RouteToNode.optional(),
  /** Nombre de un mapper del catálogo: el input de cada destino a partir del error. */
  input: z.string().optional(),
  /** Nombre de un mapper del catálogo: el input del reporte a partir del error. */
  report: z.string().optional(),
});

const Defaults = {
  onError: ErrorRouteNode.nullable().optional(),
  report: StepNode.nullable().optional(),
};

export const ProjectDoc = z.strictObject({
  /** Default: el nombre de la carpeta. */
  id: z.string().min(1).optional(),
  when: ConditionRows.optional(),
  ...Defaults,
});
export type ProjectDoc = z.infer<typeof ProjectDoc>;

const EventFilterNode = z.strictObject({
  on: z.array(z.string().min(1)).min(1),
  when: ConditionRows.optional(),
});

const ActionEntry = z.union([
  z.string(),
  z.strictObject({
    action: z.string(),
    allowWrite: z.boolean().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export const AgentDoc = z.strictObject({
  id: z.string().min(1),
  provider: z.string().min(1),
  prompt: z.string(),
  /** Nombre de un schema del catálogo. */
  input: z.string().optional(),
  systemPrompts: z
    .array(z.strictObject({ id: z.string().optional(), text: z.string().optional() }))
    .optional(),
  variables: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.strictObject({
          value: z.string(),
          full: z.string().optional(),
          description: z.string().optional(),
        }),
      ]),
    )
    .optional(),
  tools: z.array(z.string()).optional(),
  actions: z.array(ActionEntry).optional(),
  onStart: z.array(StepNode).optional(),
  injects: z.array(EventFilterNode).optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  mcpServers: z
    .array(z.strictObject({ id: z.string(), config: z.record(z.string(), z.unknown()) }))
    .optional(),
  continueOnError: z.boolean().optional(),
  when: ConditionRows.optional(),
  routes: z.record(z.string(), ExitRouteNode).optional(),
  ...Defaults,
});
export type AgentDoc = z.infer<typeof AgentDoc>;

export const PipelineDoc = z.strictObject({
  id: z.string().min(1),
  on: z.array(z.string().min(1)).min(1),
  scope: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  position: z.number().optional(),
  exclusive: z.boolean().optional(),
  ifRunning: z.enum(['wait', 'skip']).optional(),
  ifPaused: z.enum(['supersede', 'wait']).optional(),
  when: ConditionRows.optional(),
  do: z.array(StepNode).min(1),
  /** Overrides por agente: `routes.<agentId>.routes.<salida>` (`null` la elimina). */
  routes: z
    .record(
      z.string(),
      z.strictObject({
        routes: z.record(z.string(), ExitRouteNode.nullable()).optional(),
        ...Defaults,
      }),
    )
    .optional(),
  ...Defaults,
});
export type PipelineDoc = z.infer<typeof PipelineDoc>;

/** Claves que un paso creado desde el YAML puede llevar además de las suyas. */
export const CommonStepShape = {
  id: z.string().min(1).optional(),
  when: ConditionRows.optional(),
  continueOnError: z.boolean().optional(),
};

/** `engine.yaml`: cómo arma el engine una app. Las rutas son relativas al archivo. */
export const EngineDoc = z.strictObject({
  maxEventDepth: z.number().int().positive().optional(),
  executions: z
    .strictObject({
      /** Un driver registrado (`memory` viene incluido; ej. `sqlite` de
       *  `@ia-tools/agent-pipeline-sqlite`). */
      driver: z.string().min(1).default('memory'),
      path: z.string().min(1).optional(),
      maxConcurrent: z.number().int().min(1).optional(),
    })
    .optional(),
  /** `dir`: la carpeta de un proyecto. `root`: una carpeta con un proyecto por subcarpeta. */
  sources: z
    .array(
      z.union([
        z.strictObject({ dir: z.string().min(1) }),
        z.strictObject({ root: z.string().min(1) }),
      ]),
    )
    .min(1),
  /** Cada cuánto vence las pausas (`engine.tick()`). Sin esto, la app lo llama. */
  tick: z.strictObject({ everyMs: z.number().int().positive() }).optional(),
});
export type EngineDoc = z.infer<typeof EngineDoc>;
