import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Project } from '@ia-tools/agent-pipeline';
import type { z } from 'zod';
import { ProjectBuilder } from './ProjectBuilder.js';
import { substituteVars } from './Template.js';
import type { YamlCatalogs } from './YamlCatalogs.js';
import { YamlReader } from './YamlReader.js';
import { AgentDoc, PipelineDoc, ProjectDoc, ProjectVarsDoc } from './schema.js';

const YAML = /\.ya?ml$/;

/**
 * Lee la carpeta de un proyecto y lo arma:
 *
 * ```
 * <dir>/
 *   project.yaml        id, when, vars, onError, report   (opcional)
 *   agents/*.yaml       un agente por archivo
 *   intake/*.yaml       pipelines de ENTRADA: ven el evento antes del `when` del proyecto
 *   pipelines/*.yaml    una pipeline por archivo, en orden de nombre
 * ```
 *
 * Las `vars` (las de `project.yaml` sobre las de `YamlCatalogs.projectVars`) se sustituyen en
 * todos los documentos antes de armarlos.
 */
export class ProjectLoader {
  private readonly reader = new YamlReader();

  constructor(private readonly catalogs: YamlCatalogs = {}) {}

  /** Los archivos que forman el proyecto, en el orden en que se leen. */
  files(dir: string): string[] {
    const inFolder = (folder: string) => {
      const path = join(dir, folder);
      if (!existsSync(path)) return [];
      return readdirSync(path)
        .filter((name) => YAML.test(name))
        .sort()
        .map((name) => join(path, name));
    };
    const project = join(dir, 'project.yaml');
    return [
      ...(existsSync(project) ? [project] : []),
      ...inFolder('agents'),
      ...inFolder('intake'),
      ...inFolder('pipelines'),
    ];
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

  load(dir: string): Project {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`${dir}: no es la carpeta de un proyecto`);
    }
    const files = this.files(dir);
    const projectPath = join(dir, 'project.yaml');
    const under = (folder: string) =>
      files.filter((path) => path.startsWith(join(dir, folder, '/')));
    // Las vars se leen primero (sin sustituir nada); después cada documento se lee con ellas
    // sustituidas en el YAML crudo, así el schema valida el valor real y no `'{{vars.x}}'`.
    const declared = existsSync(projectPath) ? this.reader.read(projectPath, ProjectVarsDoc) : {};
    const vars = {
      ...this.catalogs.projectVars?.(declared.id ?? basename(dir)),
      ...declared.vars,
    };
    const read = <T>(path: string, schema: z.ZodType<T>) => ({
      path,
      doc: this.reader.read(path, schema, (raw) => substituteVars(raw, vars, path)),
    });
    return new ProjectBuilder(this.catalogs).build({
      dir,
      project: existsSync(projectPath)
        ? read(projectPath, ProjectDoc)
        : { path: projectPath, doc: {} },
      agents: under('agents').map((path) => read(path, AgentDoc)),
      intake: under('intake').map((path) => read(path, PipelineDoc)),
      pipelines: under('pipelines').map((path) => read(path, PipelineDoc)),
    });
  }
}
