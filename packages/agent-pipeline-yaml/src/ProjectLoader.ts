import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '@ia-tools/agent-pipeline';
import { ProjectBuilder } from './ProjectBuilder.js';
import type { YamlCatalogs } from './YamlCatalogs.js';
import { YamlReader } from './YamlReader.js';
import { AgentDoc, PipelineDoc, ProjectDoc } from './schema.js';

const YAML = /\.ya?ml$/;

/**
 * Lee la carpeta de un proyecto y lo arma:
 *
 * ```
 * <dir>/
 *   project.yaml        id, when, onError, report   (opcional)
 *   agents/*.yaml       un agente por archivo
 *   pipelines/*.yaml    una pipeline por archivo, en orden de nombre
 * ```
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
    const under = (folder: string) => files.filter((path) => path.startsWith(join(dir, folder)));
    return new ProjectBuilder(this.catalogs).build({
      dir,
      project: {
        path: projectPath,
        doc: existsSync(projectPath) ? this.reader.read(projectPath, ProjectDoc) : {},
      },
      agents: under('agents').map((path) => ({ path, doc: this.reader.read(path, AgentDoc) })),
      pipelines: under('pipelines').map((path) => ({
        path,
        doc: this.reader.read(path, PipelineDoc),
      })),
    });
  }
}
