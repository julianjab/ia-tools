import type { Tool } from '@ia-tools/agent-pipeline';
import type { GithubClient } from '@ia-tools/github-api';
import { createAddLabelsTool } from './tools/addLabels.js';
import { createCommentIssueTool } from './tools/commentIssue.js';
import { createGetIssueTool } from './tools/getIssue.js';
import { createSearchIssuesTool } from './tools/searchIssues.js';

/**
 * Le da acceso a un `Agent` a las tools de GitHub por NOMBRE (`"github_get_issue"`, no un
 * método/import por tool) — mismo patrón que `ProviderRegistry` de `agent-pipeline`: construye
 * todas las tools una vez (atadas al `GithubClient` que le pasás) y las resuelve por `name`.
 * Pensado para el caso en que la lista de tools de un agente viene de config (YAML/JSON, un
 * array de strings) en vez de código TS que importa cada `create*Tool` a mano.
 */
export class GithubToolRegistry {
  private readonly tools: Map<string, Tool>;

  constructor(client: GithubClient) {
    const all = [
      createGetIssueTool(client),
      createCommentIssueTool(client),
      createAddLabelsTool(client),
      createSearchIssuesTool(client),
    ];
    this.tools = new Map(all.map((tool) => [tool.name, tool]));
  }

  /** Tira si `name` no matchea ninguna tool registrada — fail-fast en vez de que un `Agent` se
   *  entere recién en runtime, a mitad de un dispatch, de que le configuraron un nombre mal
   *  escrito. */
  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(
        `GithubToolRegistry: no existe una tool "${name}" — disponibles: ${this.names().join(', ')}`,
      );
    }
    return tool;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  /** Resuelve una lista de nombres a sus `Tool` — el caso de uso central: `AgentDefinitionProps.tools`
   *  a partir de `string[]` de config, sin que el caller importe cada `create*Tool` uno por uno. */
  resolve(names: string[]): Tool[] {
    return names.map((name) => this.get(name));
  }
}
