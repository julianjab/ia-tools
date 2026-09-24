import { GithubClient, GithubTokenAuth } from '@ia-tools/github';
import { describe, expect, it, vi } from 'vitest';
import { GithubTools } from '../GithubTools.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl: typeof fetch) {
  return new GithubClient({ auth: new GithubTokenAuth('t'), fetchImpl });
}

describe('GithubTools.all', () => {
  it('returns all four tools with their names', () => {
    const tools = new GithubTools(clientWith(vi.fn() as unknown as typeof fetch)).all();
    expect(tools.map((t) => t.name)).toEqual([
      'github_get_issue',
      'github_comment_issue',
      'github_add_labels',
      'github_search_issues',
    ]);
  });
});

describe('github_get_issue', () => {
  it('fetches the issue and summarizes it, normalizing label objects to names', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.github.com/repos/julianjab/accountant/issues/42');
      return jsonResponse({
        number: 42,
        title: 'App crashes',
        body: 'steps...',
        state: 'open',
        html_url: 'https://github.com/julianjab/accountant/issues/42',
        labels: [{ name: 'bug' }, { name: 'p1' }],
      });
    });
    const tool = new GithubTools(clientWith(fetchImpl as unknown as typeof fetch)).getIssue();

    const result = await tool.handler({ owner: 'julianjab', repo: 'accountant', number: 42 });

    expect(JSON.parse(result)).toEqual({
      number: 42,
      title: 'App crashes',
      body: 'steps...',
      state: 'open',
      labels: ['bug', 'p1'],
      url: 'https://github.com/julianjab/accountant/issues/42',
    });
  });

  it('defaults body to an empty string when GitHub returns null', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        number: 1,
        title: 't',
        body: null,
        state: 'open',
        html_url: 'u',
        labels: [],
      }),
    );
    const tool = new GithubTools(clientWith(fetchImpl as unknown as typeof fetch)).getIssue();

    const result = await tool.handler({ owner: 'o', repo: 'r', number: 1 });

    expect(JSON.parse(result).body).toBe('');
  });
});

describe('github_comment_issue', () => {
  it('posts the comment body and returns the comment URL', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.github.com/repos/o/r/issues/5/comments');
      expect(JSON.parse(init.body as string)).toEqual({ body: 'nice work' });
      return jsonResponse({ id: 1, html_url: 'https://github.com/o/r/issues/5#comment-1' });
    });
    const tool = new GithubTools(clientWith(fetchImpl as unknown as typeof fetch)).commentIssue();

    const result = await tool.handler({ owner: 'o', repo: 'r', number: 5, body: 'nice work' });

    expect(result).toBe('Comentario publicado: https://github.com/o/r/issues/5#comment-1');
  });
});

describe('github_add_labels', () => {
  it('posts the labels and returns the resulting label list', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.github.com/repos/o/r/issues/5/labels');
      expect(JSON.parse(init.body as string)).toEqual({ labels: ['bug'] });
      return jsonResponse([{ name: 'bug' }, { name: 'p1' }]);
    });
    const tool = new GithubTools(clientWith(fetchImpl as unknown as typeof fetch)).addLabels();

    const result = await tool.handler({ owner: 'o', repo: 'r', number: 5, labels: ['bug'] });

    expect(result).toBe('Labels actuales: bug, p1');
  });
});

describe('github_search_issues', () => {
  it('URL-encodes the query and summarizes every matching issue', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        'https://api.github.com/search/issues?q=repo%3Ao%2Fr%20is%3Aopen%20label%3Abug',
      );
      return jsonResponse({
        items: [
          {
            number: 1,
            title: 't1',
            body: 'b1',
            state: 'open',
            html_url: 'u1',
            labels: ['bug'],
          },
        ],
      });
    });
    const tool = new GithubTools(clientWith(fetchImpl as unknown as typeof fetch)).searchIssues();

    const result = await tool.handler({ query: 'repo:o/r is:open label:bug' });

    expect(JSON.parse(result)).toHaveLength(1);
    expect(JSON.parse(JSON.parse(result)[0])).toMatchObject({ number: 1, title: 't1' });
  });
});

describe('tool error handling (matches AnthropicProvider expectations)', () => {
  it('a non-ok response throws — the caller (AnthropicProvider) turns it into an is_error tool_result', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const tool = new GithubTools(clientWith(fetchImpl as unknown as typeof fetch)).getIssue();

    await expect(tool.handler({ owner: 'o', repo: 'r', number: 999 })).rejects.toThrow('404');
  });
});
