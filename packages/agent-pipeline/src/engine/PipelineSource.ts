import type { Pipeline } from '../pipeline/Pipeline.js';
import type { ExitDefaults } from '../routing/ExitRoutes.js';

/**
 * Fuente en vivo del roster de Pipeline — el Engine la consulta en CADA evento, nunca la
 * cachea, así que un pipeline editado en caliente (DB, YAML, panel de admin) aplica en el
 * próximo dispatch sin reiniciar el proceso.
 */
export interface PipelineSource {
  list(): Promise<Pipeline[]> | Pipeline[];
  /** Defaults de rutas para todas sus pipelines — el nivel "proyecto" de la cascada. */
  readonly defaults?: ExitDefaults;
}

/** El caso común: pipelines definidos en código, fijos para la vida del proceso. */
export class StaticPipelineSource implements PipelineSource {
  constructor(private readonly pipelines: Pipeline[]) {}

  list(): Pipeline[] {
    return this.pipelines;
  }
}
