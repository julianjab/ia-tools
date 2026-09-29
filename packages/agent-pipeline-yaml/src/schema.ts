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
    /** Otro campo del mismo payload contra el que comparar, en vez de `value`. */
    valueFrom: z.string().min(1).optional(),
    logic: z.enum(['and', 'or']).optional(),
  }),
);

export const StepNode = z.record(z.string(), z.unknown());

/**
 * El gate semántico (`whenText`): el criterio en lenguaje natural, o `{ text, systemPrompts, model }`.
 * Un system prompt se nombra por id —uno del `project.yaml` o del catálogo— o va inline
 * (`{ text }`); se resuelven al cargar.
 */
export const WhenTextNode = z.union([
  z.string().min(1),
  z.strictObject({
    text: z.string().min(1),
    systemPrompts: z
      .array(z.union([z.string().min(1), z.strictObject({ text: z.string().min(1) })]))
      .optional(),
    model: z.string().min(1).optional(),
  }),
]);
export type WhenTextNode = z.infer<typeof WhenTextNode>;
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

/** `30s`, `45m`, `2h`. */
export const Duration = z.string().regex(/^\d+(s|m|h)$/, 'una duración: `30s`, `45m`, `2h`');

const DURATION_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

export function durationMs(duration: string): number {
  const unit = duration.at(-1) as keyof typeof DURATION_MS;
  return Number(duration.slice(0, -1)) * DURATION_MS[unit];
}

const SystemPromptRefs = z.array(
  z.strictObject({ id: z.string().optional(), text: z.string().optional() }),
);

const Defaults = {
  onError: ErrorRouteNode.nullable().optional(),
  report: StepNode.nullable().optional(),
};

export const ProjectDoc = z.strictObject({
  /** Default: el nombre de la carpeta. */
  id: z.string().min(1).optional(),
  /** El filtro del proyecto: lo cumplen los eventos de `pipelines/`, no los de `intake/` (que
   *  son los que arman esos eventos a partir de uno crudo). */
  when: ConditionRows.optional(),
  /** Constantes del proyecto: `{{vars.x}}` se sustituye al cargar en cualquier archivo. */
  vars: z.record(z.string(), z.unknown()).optional(),
  /** Van ANTES de los de cada agente del proyecto: el prefijo compartido (y cacheable) de todos. */
  systemPrompts: SystemPromptRefs.optional(),
  ...Defaults,
});
export type ProjectDoc = z.infer<typeof ProjectDoc>;

/** Lo que se lee de `project.yaml` antes de sustituir nada: su id y sus vars. */
export const ProjectVarsDoc = z.looseObject({
  id: z.string().min(1).optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
});

const EventFilterNode = z.strictObject({
  on: z.array(z.string().min(1)).min(1),
  when: ConditionRows.optional(),
});

const ActionEntry = z.union([
  z.string(),
  z.strictObject({
    action: z.string(),
    allowWrite: z.boolean().optional(),
    /** Campos del input que fija la config (`Action.bind`). */
    with: z.record(z.string(), z.unknown()).optional(),
    /** Para una acción que el catálogo arma a pedido (`ActionProvider`): cómo armarla. */
    options: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const InputField = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().optional(),
  optional: z.boolean().optional(),
});

export const AgentDoc = z.strictObject({
  id: z.string().min(1),
  provider: z.string().min(1),
  prompt: z.string(),
  /** Lo que recibe cuando lo alcanza una ruta (`{{input.x}}`): un schema del catálogo por nombre,
   *  o los campos inline. */
  input: z.union([z.string(), z.record(z.string(), InputField)]).optional(),
  systemPrompts: SystemPromptRefs.optional(),
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
  /** Todas sus acciones pueden escribir: listarlas ya es la decisión del operador. Sin esto, una
   *  que escribe necesita `allowWrite: true` en su entrada. */
  allowWrites: z.boolean().optional(),
  onStart: z.array(StepNode).optional(),
  injects: z.array(EventFilterNode).optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  /** Por id (del catálogo `mcpServers`) o inline. Un id que el catálogo no tiene se omite con un
   *  aviso: el agente corre sin ese servidor. */
  mcpServers: z
    .array(
      z.union([
        z.string(),
        z.strictObject({ id: z.string(), config: z.record(z.string(), z.unknown()) }),
      ]),
    )
    .optional(),
  continueOnError: z.boolean().optional(),
  when: ConditionRows.optional(),
  /** Donde sea que corra: un modelo decide si el evento le corresponde (ver `WhenTextNode`). */
  whenText: WhenTextNode.optional(),
  routes: z.record(z.string(), ExitRouteNode).optional(),
  ...Defaults,
});
export type AgentDoc = z.infer<typeof AgentDoc>;

export const PipelineDoc = z.strictObject({
  id: z.string().min(1),
  /** Para leerla: no cambia nada. */
  name: z.string().optional(),
  on: z.array(z.string().min(1)).min(1),
  scope: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  position: z.number().optional(),
  exclusive: z.boolean().optional(),
  /** Los pasos son alternativas: corre sólo el primero cuyo `when` pasa (ver `Pipeline`). */
  firstMatch: z.boolean().optional(),
  ifRunning: z.enum(['wait', 'skip']).optional(),
  ifPaused: z.enum(['supersede', 'wait']).optional(),
  when: ConditionRows.optional(),
  /** Después del `when`: un modelo decide si la pipeline corre (ver `WhenTextNode`). */
  whenText: WhenTextNode.optional(),
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
  whenText: WhenTextNode.optional(),
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
  /** El clasificador de los `whenText`: la Messages API de Anthropic. Sin esto (y sin
   *  `textClassifier` en código), un `whenText` no deja correr nada. */
  whenText: z
    .strictObject({
      /** Default: `claude-haiku-4-5`. */
      model: z.string().min(1).optional(),
      /** La env var con la API key. Default: `ANTHROPIC_API_KEY`. */
      apiKeyEnv: z.string().min(1).optional(),
    })
    .optional(),
});
export type EngineDoc = z.infer<typeof EngineDoc>;
