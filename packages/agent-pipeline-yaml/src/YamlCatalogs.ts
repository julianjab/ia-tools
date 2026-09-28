import type {
  Action,
  FunctionActionProps,
  ProviderRegistry,
  SystemPromptCatalog,
  Tool,
  ToolInputSchema,
} from '@ia-tools/agent-pipeline';
import type { StepFactory } from './StepFactory.js';

/** Un registry de tools por nombre (ej. un `ToolRegistry` de `@ia-tools/github-tools`). */
export interface ToolLookup {
  get(name: string): Tool;
}

/**
 * Lo que el YAML nombra y la app registra en código. El YAML nunca trae funciones: una acción,
 * una tool, un schema de input o cómo se arma el input de un `onError` a partir del error se
 * referencian por nombre acá.
 */
export interface YamlCatalogs {
  /** Los providers que los agentes nombran en `provider`. Default: el `providerRegistry` global. */
  providers?: ProviderRegistry;
  /** Acciones por nombre: `{ action: postComment, with: {...} }`. */
  actions?: Record<string, Action>;
  /** Funciones para `{ function: <nombre> }` (un `FunctionAction`). */
  functions?: Record<string, FunctionActionProps['fn']>;
  /** Tools por nombre, para `tools:` de un agente. */
  tools?: Record<string, Tool> | ToolLookup;
  /** El input de un destino o del reporte de un `onError`, a partir del error. */
  mappers?: Record<string, (err: Error) => unknown>;
  /** Schemas por nombre, para el `input:` de un agente. */
  schemas?: Record<string, ToolInputSchema>;
  /** Los system prompts que un agente referencia por `id`. */
  systemPrompts?: SystemPromptCatalog;
  /** Tipos de paso propios, además de los incluidos (`agent`, `action`, `emit`, `http`, `pause`,
   *  `function`). */
  steps?: StepFactory[];
}

/** Lo que `catalog` tiene bajo `name`, o un error que dice qué hay. */
export function lookup<T>(catalog: Record<string, T> | undefined, name: string, kind: string): T {
  const found = catalog?.[name];
  if (found === undefined) {
    const available = Object.keys(catalog ?? {});
    throw new Error(
      `no hay ${kind} "${name}" en el catálogo${available.length > 0 ? ` — hay: ${available.join(', ')}` : ' (está vacío)'}`,
    );
  }
  return found;
}
