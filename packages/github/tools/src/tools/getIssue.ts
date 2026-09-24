import type { Tool } from '@ia-tools/agent-pipeline';
import type { GithubClient } from '@ia-tools/github-api';
import { type GithubIssueApiShape, issuePath, summarizeIssue } from '../shared.js';

export interface GetIssueInput {
  owner: string;
  repo: string;
  number: number;
}

export function createGetIssueTool(client: GithubClient): Tool<GetIssueInput> {
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
      const issue = await client.requestJson<GithubIssueApiShape>(
        issuePath(input.owner, input.repo, input.number),
      );
      return summarizeIssue(issue);
    },
  };
}
