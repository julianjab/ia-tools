import type { Tool } from '@ia-tools/agent-pipeline';
import type { GithubClient } from '@ia-tools/github';

export interface GetIssueInput {
  owner: string;
  repo: string;
  number: number;
}

export interface CommentIssueInput {
  owner: string;
  repo: string;
  number: number;
  body: string;
}

export interface AddLabelsInput {
  owner: string;
  repo: string;
  number: number;
  labels: string[];
}

export interface SearchIssuesInput {
  /** Query de la GitHub Search API tal cual — ej. `"repo:o/r is:issue is:open label:bug"`. */
  query: string;
}

interface GithubIssueApiShape {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<{ name: string } | string>;
}

// Nombres de owner/repo de GitHub: alfanumérico + `.`/`-`/`_`, nunca arrancan con esos tres.
// Sin esto, `owner`/`repo` —que vienen del MODELO, no de un caller de confianza— podían llevar
// un `../../orgs/otra-org/...` y hacer que `fetch` resuelva el path fuera de `/repos/o/r/...`,
// pegándole con el mismo token a un endpoint que el caller nunca pidió.
const SAFE_REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function assertSafeSegment(label: string, value: string): string {
  if (!SAFE_REPO_SEGMENT.test(value)) {
    throw new Error(`GithubTools: "${label}" inválido: "${value}"`);
  }
  return encodeURIComponent(value);
}

function assertIssueNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`GithubTools: "number" tiene que ser un entero positivo, vino "${value}"`);
  }
  return value;
}

/** Arma `/repos/{owner}/{repo}/issues/{number}` (+ `suffix`), validando y encodeando cada
 *  segmento — el único lugar que construye estos paths, para que ninguna tool nueva se olvide. */
function issuePath(owner: string, repo: string, number: number, suffix = ''): string {
  const safeOwner = assertSafeSegment('owner', owner);
  const safeRepo = assertSafeSegment('repo', repo);
  const safeNumber = assertIssueNumber(number);
  return `/repos/${safeOwner}/${safeRepo}/issues/${safeNumber}${suffix}`;
}

function summarizeIssue(issue: GithubIssueApiShape): string {
  const labels = issue.labels.map((label) => (typeof label === 'string' ? label : label.name));
  return JSON.stringify({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels,
    url: issue.html_url,
  });
}

/**
 * `Tool[]` de `@ia-tools/agent-pipeline` respaldadas por la REST API de GitHub, vía un
 * `GithubClient` ya autenticado (de `@ia-tools/github`, con cualquiera de sus dos `GithubAuth`).
 * Puente deliberado entre los dos paquetes — ninguno de los dos se conoce entre sí; éste es el
 * único lugar que los conecta, así que cuando cambie la forma de un `Tool` o de `GithubClient`,
 * el ajuste vive acá y en ningún otro lado.
 */
export class GithubTools {
  constructor(private readonly client: GithubClient) {}

  getIssue(): Tool<GetIssueInput> {
    return {
      name: 'github_get_issue',
      description: 'Lee un issue de GitHub: título, cuerpo, estado y labels.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Dueño del repo, ej. "julianjab"' },
          repo: { type: 'string', description: 'Nombre del repo' },
          number: { type: 'number', description: 'Número del issue' },
        },
        required: ['owner', 'repo', 'number'],
      },
      handler: async (input) => {
        const issue = await this.client.requestJson<GithubIssueApiShape>(
          issuePath(input.owner, input.repo, input.number),
        );
        return summarizeIssue(issue);
      },
    };
  }

  commentIssue(): Tool<CommentIssueInput> {
    return {
      name: 'github_comment_issue',
      description: 'Publica un comentario en un issue (o PR — la API los trata igual) de GitHub.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          number: { type: 'number' },
          body: { type: 'string', description: 'Texto del comentario, markdown permitido' },
        },
        required: ['owner', 'repo', 'number', 'body'],
      },
      handler: async (input) => {
        const comment = await this.client.requestJson<{ id: number; html_url: string }>(
          issuePath(input.owner, input.repo, input.number, '/comments'),
          { method: 'POST', body: JSON.stringify({ body: input.body }) },
        );
        return `Comentario publicado: ${comment.html_url}`;
      },
    };
  }

  addLabels(): Tool<AddLabelsInput> {
    return {
      name: 'github_add_labels',
      description: 'Agrega una o más labels a un issue de GitHub (no reemplaza las existentes).',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          number: { type: 'number' },
          labels: { type: 'array', items: { type: 'string' } },
        },
        required: ['owner', 'repo', 'number', 'labels'],
      },
      handler: async (input) => {
        const updated = await this.client.requestJson<Array<{ name: string }>>(
          issuePath(input.owner, input.repo, input.number, '/labels'),
          { method: 'POST', body: JSON.stringify({ labels: input.labels }) },
        );
        return `Labels actuales: ${updated.map((label) => label.name).join(', ')}`;
      },
    };
  }

  searchIssues(): Tool<SearchIssuesInput> {
    return {
      name: 'github_search_issues',
      description:
        'Busca issues/PRs con la sintaxis de búsqueda de GitHub (ej. "repo:o/r is:issue is:open label:bug").',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
      handler: async (input) => {
        const result = await this.client.requestJson<{ items: GithubIssueApiShape[] }>(
          `/search/issues?q=${encodeURIComponent(input.query)}`,
        );
        return JSON.stringify(result.items.map(summarizeIssue));
      },
    };
  }

  all(): Tool[] {
    return [this.getIssue(), this.commentIssue(), this.addLabels(), this.searchIssues()];
  }
}
