import { GithubTool } from '../GithubTool.js';

export interface CommentIssueInput {
  owner: string;
  repo: string;
  number: number;
  body: string;
}

export class CommentIssueTool extends GithubTool<CommentIssueInput> {
  readonly name = 'github_comment_issue';
  readonly description =
    'Publica un comentario en un issue (o PR — la API los trata igual) de GitHub.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      number: { type: 'number' },
      body: { type: 'string', description: 'Texto del comentario, markdown permitido' },
    },
    required: ['owner', 'repo', 'number', 'body'],
  };

  async handler(input: CommentIssueInput): Promise<string> {
    const comment = await this.client.requestJson<{ id: number; html_url: string }>(
      this.issuePath(input.owner, input.repo, input.number, '/comments'),
      { method: 'POST', body: JSON.stringify({ body: input.body }) },
    );
    return `Comentario publicado: ${comment.html_url}`;
  }
}
