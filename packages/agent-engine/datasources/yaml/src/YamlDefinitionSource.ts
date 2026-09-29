import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { substituteVars } from '@ia-tools/agent-engine';
import {
  AgentDoc,
  type DefinitionSource,
  PipelineDoc,
  SourceDoc,
  type SourceDocs,
} from '@ia-tools/agent-engine-definitions';
import { z } from 'zod';
import { YamlReader } from './YamlReader.js';

const YAML = /\.ya?ml$/;

/** Lo que se lee de `source.yaml` antes de sustituir nada: su id y sus vars. */
const SourceVarsDoc = z.looseObject({
  id: z.string().min(1).optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
});

export interface YamlDefinitionSourceOptions {
  /** La carpeta de la fuente. */
  dir: string;
  /** Su id; si no, el de su `source.yaml`, y si no, el nombre de la carpeta. */
  id?: string;
  /** `vars` además de las de `source.yaml`, que ganan. Se sustituyen al leer: `{{vars.x}}`. */
  vars?: Record<string, unknown>;
}

/**
 * Una carpeta de YAML traducida a definiciones (`SourceDocs`): nada más. Armarlas es de
 * `@ia-tools/agent-engine-definitions` (`DefinitionPipelineSource`).
 *
 * ```
 * <dir>/
 *   source.yaml         id, vars, systemPrompts, onError, report   (opcional)
 *   agents/*.yaml       un agente por archivo
 *   pipelines/*.yaml    una pipeline por archivo, en orden de nombre
 * ```
 *
 * Las `vars` se sustituyen en el YAML crudo de todos los documentos, antes de validarlos: el schema
 * valida el valor real y no `'{{vars.x}}'`, y una var que no existe rompe la lectura.
 */
export class YamlDefinitionSource implements DefinitionSource {
  private readonly reader = new YamlReader();

  constructor(private readonly options: YamlDefinitionSourceOptions) {}

  /** Una fuente por cada subcarpeta de `root` con `source.yaml` o `pipelines/`. */
  static fromRoot(root: string): YamlDefinitionSource[] {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (existsSync(join(root, entry.name, 'source.yaml')) ||
            existsSync(join(root, entry.name, 'pipelines'))),
      )
      .map((entry) => entry.name)
      .sort()
      .map((name) => new YamlDefinitionSource({ dir: join(root, name) }));
  }

  /** Los archivos que forman la fuente, en el orden en que se leen. */
  files(): string[] {
    const { dir } = this.options;
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
  version(): string {
    return this.files()
      .map((path) => {
        const { mtimeMs, size } = statSync(path);
        return `${path}:${mtimeMs}:${size}`;
      })
      .join('|');
  }

  read(): SourceDocs {
    const { dir } = this.options;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`${dir}: no es la carpeta de una fuente`);
    }
    const files = this.files();
    const sourcePath = join(dir, 'source.yaml');
    const under = (folder: string) =>
      files.filter((path) => path.startsWith(join(dir, folder, '/')));
    const declared = existsSync(sourcePath) ? this.reader.read(sourcePath, SourceVarsDoc) : {};
    const vars = { ...this.options.vars, ...declared.vars };
    const read = <T>(path: string, schema: z.ZodType<T>) => ({
      path,
      doc: this.reader.read(path, schema, (raw) => substituteVars(raw, vars, path)),
    });
    return {
      id: this.options.id ?? declared.id ?? basename(dir),
      source: existsSync(sourcePath) ? read(sourcePath, SourceDoc) : { path: sourcePath, doc: {} },
      agents: under('agents').map((path) => read(path, AgentDoc)),
      pipelines: under('pipelines').map((path) => read(path, PipelineDoc)),
    };
  }
}
