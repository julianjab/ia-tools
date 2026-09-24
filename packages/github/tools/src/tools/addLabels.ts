import type { Tool } from '@ia-tools/agent-pipeline';
import type { GithubClient } from '@ia-tools/github-api';
import { issuePath } from '../shared.js';

export interface AddLabelsInput {
  owner: string;
  repo: string;
  number: number;
  labels: string[];
}

export function createAddLabelsTool(client: GithubClient): Tool<AddLabelsInput> {
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
      const updated = await client.requestJson<Array<{ name: string }>>(
        issuePath(input.owner, input.repo, input.number, '/labels'),
        { method: 'POST', body: JSON.stringify({ labels: input.labels }) },
      );
      return `Labels actuales: ${updated.map((label) => label.name).join(', ')}`;
    },
  };
}
