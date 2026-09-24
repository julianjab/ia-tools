import { GithubTool } from '../GithubTool.js';
import type { GithubIssueApiShape } from '../shared.js';

export interface GetIssueInput {
  owner: string;
  repo: string;
  number: number;
}

export class GetIssueTool extends GithubTool<GetIssueInput> {
  readonly name = 'github_get_issue';
  readonly description = 'Lee un issue de GitHub: título, cuerpo, estado y labels.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Dueño del repo, ej. "julianjab"' },
      repo: { type: 'string', description: 'Nombre del repo' },
      number: { type: 'number', description: 'Número del issue' },
    },
    required: ['owner', 'repo', 'number'],
  };

  async handler(input: GetIssueInput): Promise<string> {
    const issue = await this.client.requestJson<GithubIssueApiShape>(
      this.issuePath(input.owner, input.repo, input.number),
    );
    return this.summarizeIssue(issue);
  }
}
