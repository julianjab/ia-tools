import { GithubTool } from '../GithubTool.js';
import type { GithubIssueApiShape } from '../shared.js';

export interface SearchIssuesInput {
  /** Query de la GitHub Search API tal cual — ej. `"repo:o/r is:issue is:open label:bug"`. */
  query: string;
}

export class SearchIssuesTool extends GithubTool<SearchIssuesInput> {
  readonly name = 'github_search_issues';
  readonly description =
    'Busca issues/PRs con la sintaxis de búsqueda de GitHub (ej. "repo:o/r is:issue is:open label:bug").';
  readonly inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  };

  async handler(input: SearchIssuesInput): Promise<string> {
    const result = await this.client.requestJson<{ items: GithubIssueApiShape[] }>(
      `/search/issues?q=${encodeURIComponent(input.query)}`,
    );
    return JSON.stringify(result.items.map((issue) => this.summarizeIssue(issue)));
  }
}
