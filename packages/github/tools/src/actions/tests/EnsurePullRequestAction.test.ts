import { EventBus, type PipelineExecutionContext, createEvent } from '@ia-tools/agent-pipeline';
import { GithubClient } from '@ia-tools/github-api';
import { GithubTokenAuth } from '@ia-tools/github-auth';
import { describe, expect, it, vi } from 'vitest';
import { EnsurePullRequestAction, closesIssue } from '../EnsurePullRequestAction.js';

const ISSUE = { owner: 'la-haus', repo: 'subscriptions', number: 1640 };
const TASK = { ...ISSUE, task: { branch: 'ia-flow-local/1640' } };

function ctxFor(payload: Record<string, unknown> = TASK): PipelineExecutionContext {
  return { event: createEvent('e', payload), steps: {}, bus: new EventBus(), pipelineId: 'p' };
}

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** Un GitHub falso por ruta REST: PRs abiertos de la rama, la rama remota, el repo y el issue. */
function fakeGithub(options: { openPr?: { body: string | null }; branchStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({
      method,
      path: pathname + search,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

    if (method === 'GET' && pathname.endsWith('/pulls')) {
      return json(
        options.openPr
          ? [
              {
                number: 1642,
                html_url: 'https://github.com/x/pull/1642',
                body: options.openPr.body,
              },
            ]
          : [],
      );
    }
    if (pathname.includes('/branches/')) return json({}, options.branchStatus ?? 200);
    if (method === 'POST' && pathname.endsWith('/pulls')) {
      return json({ number: 1700, html_url: 'https://github.com/x/pull/1700', body: '' }, 201);
    }
    if (pathname.endsWith('/issues/1640')) return json({ title: 'Bloquear reasignación' });
    if (pathname.endsWith('/subscriptions')) return json({ default_branch: 'main' });
    return json({});
  });
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

describe('EnsurePullRequestAction', () => {
  it('looks up the open PR of the task branch', async () => {
    const { client, calls } = fakeGithub({ openPr: { body: 'Closes #1640' } });
    await new EnsurePullRequestAction({ client }).run(ctxFor(), {});
    expect(calls[0]?.path).toBe(
      '/repos/la-haus/subscriptions/pulls?state=open&head=la-haus%3Aia-flow-local%2F1640',
    );
  });

  it('leaves a PR that already closes the issue untouched', async () => {
    const { client, writes } = fakeGithub({ openPr: { body: 'Arregla todo.\n\nFixes #1640' } });

    const result = await new EnsurePullRequestAction({ client }).run(ctxFor(), {});

    expect(writes()).toEqual([]);
    expect(result).toContain('ya cierra #1640');
  });

  it('appends Closes #n to a PR body that does not close the issue, keeping the rest', async () => {
    const { client, writes } = fakeGithub({ openPr: { body: 'Descripción del modelo.\n' } });

    const result = await new EnsurePullRequestAction({ client }).run(ctxFor(), {});

    expect(writes()).toEqual([
      {
        method: 'PATCH',
        path: '/repos/la-haus/subscriptions/pulls/1642',
        body: { body: 'Descripción del modelo.\n\nCloses #1640' },
      },
    ]);
    expect(result).toContain('agregado "Closes #1640"');
  });

  it('writes just Closes #n on an empty PR body', async () => {
    const { client, writes } = fakeGithub({ openPr: { body: null } });
    await new EnsurePullRequestAction({ client }).run(ctxFor(), {});
    expect(writes()[0]?.body).toEqual({ body: 'Closes #1640' });
  });

  it('opens the PR when the branch is published but has none', async () => {
    const { client, writes } = fakeGithub();

    const result = await new EnsurePullRequestAction({ client }).run(ctxFor(), {});

    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/repos/la-haus/subscriptions/pulls',
        body: {
          title: 'Bloquear reasignación',
          head: 'ia-flow-local/1640',
          base: 'main',
          body: 'Closes #1640',
        },
      },
    ]);
    expect(result).toContain('PR #1700 abierto');
  });

  it('fails when nothing was published, instead of moving on without a PR', async () => {
    const { client, writes } = fakeGithub({ branchStatus: 404 });
    await expect(new EnsurePullRequestAction({ client }).run(ctxFor(), {})).rejects.toThrow(
      /no está en la-haus\/subscriptions/,
    );
    expect(writes()).toEqual([]);
  });

  it('fails on any other error reading the branch', async () => {
    const { client } = fakeGithub({ branchStatus: 500 });
    await expect(new EnsurePullRequestAction({ client }).run(ctxFor(), {})).rejects.toThrow(
      /→ 500/,
    );
  });

  it('takes the issue and branch from the event, never from the model', async () => {
    const { client, calls } = fakeGithub();
    const action = new EnsurePullRequestAction({ client });
    await expect(action.run(ctxFor({ ...ISSUE }), {})).rejects.toThrow(/task\.branch/);
    await expect(action.run(ctxFor(), { head: 'main' } as never)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('closesIssue', () => {
  it('recognises the closing keywords GitHub does, short and cross-repo', () => {
    for (const body of [
      'Closes #1640',
      'fixes #1640',
      'Resolved #1640',
      'close la-haus/subscriptions#1640',
    ]) {
      expect(closesIssue(body, ISSUE), body).toBe(true);
    }
    for (const body of ['Refs #1640', 'Closes #16400', 'Closes other/repo#1640', '#1640']) {
      expect(closesIssue(body, ISSUE), body).toBe(false);
    }
  });
});
