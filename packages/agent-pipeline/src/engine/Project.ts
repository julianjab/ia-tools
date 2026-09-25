import type { Pipeline } from '../pipeline/Pipeline.js';
import type { Runnable } from '../pipeline/Runnable.js';
import type { ErrorRoute, ExitDefaults } from '../routing/ExitRoutes.js';
import type { PipelineSource } from './PipelineSource.js';

export interface ProjectProps {
  id: string;
  pipelines: Pipeline[];
  /** Para todos los agentes del proyecto — ej. `+blocked`, hoy repetido en cada agente. */
  onError?: ErrorRoute | null;
  /** El cierre por defecto de cada turno — ej. `postComment.bind({ target: 'pr-else-issue' })`. */
  report?: Runnable | null;
}

/**
 * El nivel más general de la cascada de rutas: defaults de `onError` y `report` para todas sus
 * pipelines, más el roster que el `Engine` despacha. Reemplaza a `StaticPipelineSource` cuando
 * hacen falta defaults — sin defaults, las dos son equivalentes.
 *
 * Sólo puede definir `onError` y `report`: un proyecto no conoce a los agentes, así que no puede
 * inventarles salidas (eso es del agente) ni cambiarles destinos (eso es de cada pipeline).
 */
export class Project implements PipelineSource {
  readonly id: string;
  readonly defaults: ExitDefaults;
  private readonly pipelines: Pipeline[];

  constructor(props: ProjectProps) {
    const seen = new Set<string>();
    for (const pipeline of props.pipelines) {
      if (seen.has(pipeline.id)) {
        throw new Error(`Project(${props.id}): dos pipelines con el id "${pipeline.id}"`);
      }
      seen.add(pipeline.id);
    }
    this.id = props.id;
    this.pipelines = props.pipelines;
    this.defaults = { onError: props.onError, report: props.report };
  }

  list(): Pipeline[] {
    return this.pipelines;
  }
}
