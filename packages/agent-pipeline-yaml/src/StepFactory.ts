import type { Agent, RouteTo, Runnable } from '@ia-tools/agent-pipeline';
import type { z } from 'zod';
import type { YamlCatalogs } from './YamlCatalogs.js';

/** Lo que una factory puede pedir mientras arma un paso. */
export interface StepBuildContext {
  readonly catalogs: YamlCatalogs;
  /** Dónde está el nodo (archivo y ruta), para los errores. */
  readonly where: string;
  /** Arma un paso anidado (ej. el destino de una rama de una pausa). */
  step(node: unknown, where: string): Runnable;
  /** Arma un `to`: `end`, un paso o una lista de pasos. */
  routeTo(node: unknown, where: string): RouteTo | undefined;
  /** El agente del proyecto con ese id. */
  agent(id: string): Agent;
}

/**
 * Un tipo de paso del YAML: un nodo con la clave `keyword` (ej. `{ emit: issue.ready, ... }`) se
 * valida contra `schema` y se arma con `create`. Registrar una factory nueva agrega un tipo de paso
 * sin tocar el loader.
 */
export interface StepFactory<N = any> {
  readonly keyword: string;
  readonly schema: z.ZodType<N>;
  create(node: N, context: StepBuildContext): Runnable;
}
