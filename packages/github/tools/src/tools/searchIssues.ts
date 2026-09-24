import type { Tool } from '@ia-tools/agent-pipeline';
import type { GithubClient } from '@ia-tools/github-api';
import { type GithubIssueApiShape, summarizeIssue } from '../shared.js';

export interface SearchIssuesInput {
  /** Query de la GitHub Search API tal cual — ej. `"repo:o/r is:issue is:open label:bug"`. */
  query: string;
}

export function createSearchIssuesTool(client: GithubClient): Tool<SearchIssuesInput> {
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
      const result = await client.requestJson<{ items: GithubIssueApiShape[] }>(
        `/search/issues?q=${encodeURIComponent(input.query)}`,
      );
      return JSON.stringify(result.items.map(summarizeIssue));
    },
  };
}
