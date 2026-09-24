import { GithubClient } from '@ia-tools/github-api';
import { GithubTokenAuth } from '@ia-tools/github-auth';
import { describe, expect, it, vi } from 'vitest';
import * as lib from '../index.js';

describe('package entrypoint', () => {
  it('exports the public API', () => {
    expect(lib.GithubTools).toBeDefined();
  });

  it('wires end-to-end through the public API only', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            number: 1,
            title: 't',
            body: 'b',
            state: 'open',
            html_url: 'u',
            labels: [],
          }),
          { status: 200 },
        ),
    );
    const client = new GithubClient({
      auth: new GithubTokenAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const tools = new lib.GithubTools(client);

    const result = await tools.getIssue().handler({ owner: 'o', repo: 'r', number: 1 });

    expect(JSON.parse(result)).toMatchObject({ number: 1, title: 't' });
  });
});
