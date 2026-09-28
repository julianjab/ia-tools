import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DomainEvent,
  ExitDefaults,
  Pipeline,
  PipelineSource,
  Project,
} from '@ia-tools/agent-pipeline';
import { createLogger } from '@ia-tools/telemetry';
import { ProjectLoader } from './ProjectLoader.js';
import type { YamlCatalogs } from './YamlCatalogs.js';

export interface YamlPipelineSourceOptions {
  /** La carpeta del proyecto (ver `ProjectLoader`). */
  dir: string;
  catalogs?: YamlCatalogs;
}

/**
 * Un proyecto leído de YAML, en vivo: el engine consulta `list()` en cada evento, y si algún
 * archivo cambió (fecha o tamaño, o se agregó o sacó uno) se vuelve a leer. Si la versión nueva
 * no es válida se loguea el error y sigue la última buena — un typo no apaga el proyecto. La
 * primera carga, en cambio, tira: sin una versión buena no hay qué despachar.
 *
 * Una pausa se reanuda en la pipeline con el mismo id; si su `do[]` cambió mientras esperaba, el
 * `Checkpoint` lo detecta y la ejecución falla en vez de seguir en otro paso.
 */
export class YamlPipelineSource implements PipelineSource {
  readonly log = createLogger('agent-pipeline.yaml');
  readonly dir: string;
  private readonly loader: ProjectLoader;
  private current: Project;
  private loadedSignature: string;

  constructor(options: YamlPipelineSourceOptions) {
    this.dir = options.dir;
    this.loader = new ProjectLoader(options.catalogs);
    this.loadedSignature = this.loader.signature(this.dir);
    this.current = this.loader.load(this.dir);
  }

  /** Una fuente por cada subcarpeta de `root` que tiene `project.yaml`. */
  static fromRoot(root: string, catalogs?: YamlCatalogs): YamlPipelineSource[] {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'project.yaml')))
      .map((entry) => entry.name)
      .sort()
      .map(
        (name) =>
          new YamlPipelineSource({ dir: join(root, name), ...(catalogs ? { catalogs } : {}) }),
      );
  }

  get id(): string {
    return this.refresh().id;
  }

  get defaults(): ExitDefaults {
    return this.refresh().defaults;
  }

  list(): Pipeline[] {
    return this.refresh().list();
  }

  /** Las pipelines de `intake/`, como están ahora. */
  intakePipelines(): Pipeline[] {
    return this.refresh().intakePipelines();
  }

  /** Contra la versión que devolvió el último `list()` (el engine lo llama justo antes, por evento):
   *  sin volver a mirar los archivos por cada pipeline, y sin mezclar dos versiones en un evento. */
  explainMismatch(event: DomainEvent<any>, pipeline: Pipeline): string | undefined {
    return this.current.explainMismatch(event, pipeline);
  }

  private refresh(): Project {
    const signature = this.loader.signature(this.dir);
    if (signature === this.loadedSignature) return this.current;
    // Se marca antes de cargar: una versión rota se loguea una vez, no en cada evento.
    this.loadedSignature = signature;
    try {
      this.current = this.loader.load(this.dir);
      this.log.info(`${this.dir}: proyecto recargado`, { 'ia.project.id': this.current.id });
    } catch (error) {
      this.log.error(
        `${this.dir}: no se pudo recargar, sigue la versión anterior — ${(error as Error).message}`,
      );
    }
    return this.current;
  }
}
