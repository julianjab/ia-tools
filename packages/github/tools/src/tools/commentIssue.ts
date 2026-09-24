import type { Tool } from '@ia-tools/agent-pipeline';
import type { GithubClient } from '@ia-tools/github-api';
import { issuePath } from '../shared.js';

export interface CommentIssueInput {
  owner: string;
  repo: string;
  number: number;
  body: string;
}

export function createCommentIssueTool(client: GithubClient): Tool<CommentIssueInput> {
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
      const comment = await client.requestJson<{ id: number; html_url: string }>(
        issuePath(input.owner, input.repo, input.number, '/comments'),
        { method: 'POST', body: JSON.stringify({ body: input.body }) },
      );
      return `Comentario publicado: ${comment.html_url}`;
    },
  };
}
