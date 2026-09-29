import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { StaticPipelineSource } from '@ia-tools/agent-engine';
import type { z } from 'zod';
import { SourceBuilder } from './SourceBuilder.js';
import { substituteVars } from './Template.js';
import type { YamlCatalogs } from './YamlCatalogs.js';
import { YamlReader } from './YamlReader.js';
import { AgentDoc, PipelineDoc, SourceDoc, SourceVarsDoc } from './schema.js';

const YAML = /\.ya?ml$/;

/**
 * Lee la carpeta de una fuente y lo arma:
 *
 * ```
 * <dir>/
 *   source.yaml        id, vars, systemPrompts, onError, report   (opcional)
 *   agents/*.yaml       un agente por archivo
 *   pipelines/*.yaml    una pipeline por archivo, en orden de nombre
 * ```
 *
 * Las `vars` (las de `source.yaml` sobre las de `YamlCatalogs.sourceVars`) se sustituyen en
 * todos los documentos antes de armarlos.
 */
export class SourceLoader {
  private readonly reader = new YamlReader();

  constructor(private readonly catalogs: YamlCatalogs = {}) {}

  /** Los archivos que forman la fuente, en el orden en que se leen. */
  files(dir: string): string[] {
    const inFolder = (folder: string) => {
      const path = join(dir, folder);
      if (!existsSync(path)) return [];
      return readdirSync(path)
        .filter((name) => YAML.test(name))
        .sort()
        .map((name) => join(path, name));
    };
    const own = join(dir, 'source.yaml');
    return [...(existsSync(own) ? [own] : []), ...inFolder('agents'), ...inFolder('pipelines')];
  }

  /** Cambia si cambió cualquiera de sus archivos (o se agregó o sacó uno). */
  signature(dir: string): string {
    return this.files(dir)
      .map((path) => {
        const { mtimeMs, size } = statSync(path);
        return `${path}:${mtimeMs}:${size}`;
      })
      .join('|');
  }

  /** `id`: el que le da quien la monta; si no, el de `source.yaml`, y si no, el nombre de la carpeta. */
  load(dir: string, id?: string): StaticPipelineSource {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`${dir}: no es la carpeta de una fuente`);
    }
    // `intake/` existió un tiempo como carpeta de pipelines de entrada; hoy se ignoraría sin aviso.
    if (existsSync(join(dir, 'intake'))) {
      throw new Error(
        `${join(dir, 'intake')}: la carpeta intake/ ya no existe — sus pipelines van en pipelines/`,
      );
    }
    const files = this.files(dir);
    const sourcePath = join(dir, 'source.yaml');
    const under = (folder: string) =>
      files.filter((path) => path.startsWith(join(dir, folder, '/')));
    // Las vars se leen primero (sin sustituir nada); después cada documento se lee con ellas
    // sustituidas en el YAML crudo, así el schema valida el valor real y no `'{{vars.x}}'`.
    const declared = existsSync(sourcePath) ? this.reader.read(sourcePath, SourceVarsDoc) : {};
    const vars = {
      ...this.catalogs.sourceVars?.(id ?? declared.id ?? basename(dir)),
      ...declared.vars,
    };
    const read = <T>(path: string, schema: z.ZodType<T>) => ({
      path,
      doc: this.reader.read(path, schema, (raw) => substituteVars(raw, vars, path)),
    });
    return new SourceBuilder(this.catalogs).build({
      dir,
      ...(id !== undefined ? { id } : {}),
      source: existsSync(sourcePath) ? read(sourcePath, SourceDoc) : { path: sourcePath, doc: {} },
      agents: under('agents').map((path) => read(path, AgentDoc)),
      pipelines: under('pipelines').map((path) => read(path, PipelineDoc)),
    });
  }
}
