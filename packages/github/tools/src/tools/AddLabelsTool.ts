import { GithubTool } from '../GithubTool.js';

export interface AddLabelsInput {
  owner: string;
  repo: string;
  number: number;
  labels: string[];
}

export class AddLabelsTool extends GithubTool<AddLabelsInput> {
  readonly name = 'github_add_labels';
  readonly description =
    'Agrega una o más labels a un issue de GitHub (no reemplaza las existentes).';
  readonly inputSchema = {
    type: 'object',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      number: { type: 'number' },
      labels: { type: 'array', items: { type: 'string' } },
    },
    required: ['owner', 'repo', 'number', 'labels'],
  };

  async handler(input: AddLabelsInput): Promise<string> {
    const updated = await this.client.requestJson<Array<{ name: string }>>(
      this.issuePath(input.owner, input.repo, input.number, '/labels'),
      { method: 'POST', body: JSON.stringify({ labels: input.labels }) },
    );
    return `Labels actuales: ${updated.map((label) => label.name).join(', ')}`;
  }
}
