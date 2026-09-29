import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ExitDefaults,
  Pipeline,
  PipelineSource,
  StaticPipelineSource,
} from '@ia-tools/agent-engine';
import { createLogger } from '@ia-tools/telemetry';
import { SourceLoader } from './SourceLoader.js';
import type { YamlCatalogs } from './YamlCatalogs.js';

export interface YamlPipelineSourceOptions {
  /** La carpeta de la fuente (ver `SourceLoader`). */
  dir: string;
  /** El id de la fuente; si no, el de su `source.yaml`, y si no, el nombre de la carpeta. */
  id?: string;
  catalogs?: YamlCatalogs;
}

/**
 * Una fuente leída de YAML, en vivo: el engine consulta `list()` en cada evento, y si algún
 * archivo cambió (fecha o tamaño, o se agregó o sacó uno) se vuelve a leer. Si la versión nueva
 * no es válida se loguea el error y sigue la última buena — un typo no apaga la fuente. La
 * primera carga, en cambio, tira: sin una versión buena no hay qué despachar.
 *
 * Una pausa se reanuda en la pipeline con el mismo id; si su `do[]` cambió mientras esperaba, el
 * `Checkpoint` lo detecta y la ejecución falla en vez de seguir en otro paso.
 */
export class YamlPipelineSource implements PipelineSource {
  readonly log = createLogger('agent-engine.yaml');
  readonly dir: string;
  private readonly loader: SourceLoader;
  private readonly givenId: string | undefined;
  private current: StaticPipelineSource;
  private loadedSignature: string;

  constructor(options: YamlPipelineSourceOptions) {
    this.dir = options.dir;
    this.givenId = options.id;
    this.loader = new SourceLoader(options.catalogs);
    this.loadedSignature = this.loader.signature(this.dir);
    this.current = this.loader.load(this.dir, this.givenId);
  }

  /** Una fuente por cada subcarpeta de `root` con `source.yaml` o `pipelines/`. */
  static fromRoot(root: string, catalogs?: YamlCatalogs): YamlPipelineSource[] {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (existsSync(join(root, entry.name, 'source.yaml')) ||
            existsSync(join(root, entry.name, 'pipelines'))),
      )
      .map((entry) => entry.name)
      .sort()
      .map(
        (name) =>
          new YamlPipelineSource({ dir: join(root, name), ...(catalogs ? { catalogs } : {}) }),
      );
  }

  get id(): string {
    return this.refresh().id as string;
  }

  get defaults(): ExitDefaults {
    return this.refresh().defaults ?? {};
  }

  list(): Pipeline[] {
    return this.refresh().list();
  }

  private refresh(): StaticPipelineSource {
    const signature = this.loader.signature(this.dir);
    if (signature === this.loadedSignature) return this.current;
    // Se marca antes de cargar: una versión rota se loguea una vez, no en cada evento.
    this.loadedSignature = signature;
    try {
      this.current = this.loader.load(this.dir, this.givenId);
      this.log.info(`${this.dir}: fuente recargada`, { 'ia.source.id': this.current.id });
    } catch (error) {
      this.log.error(
        `${this.dir}: no se pudo recargar, sigue la versión anterior — ${(error as Error).message}`,
      );
    }
    return this.current;
  }
}
