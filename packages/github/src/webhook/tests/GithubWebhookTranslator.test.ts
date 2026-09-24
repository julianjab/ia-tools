import { describe, expect, it } from 'vitest';
import { GithubWebhookTranslator } from '../GithubWebhookTranslator.js';

function issuesPayload(action: string, overrides: Record<string, unknown> = {}) {
  return {
    action,
    issue: {
      title: 'App crashes on login',
      body: 'steps to reproduce...',
      number: 42,
      labels: [{ name: 'bug' }, { name: 'p1' }],
    },
    repository: { name: 'accountant', owner: { login: 'julianjab' } },
    sender: { login: 'someone' },
    ...overrides,
  };
}

function issueCommentPayload(action: string) {
  return {
    action,
    issue: { title: 't', body: 'b', number: 7, labels: [] },
    comment: { id: 999, body: 'looks good' },
    repository: { name: 'r', owner: { login: 'o' } },
    sender: { login: 'reviewer' },
  };
}

describe('GithubWebhookTranslator', () => {
  const translator = new GithubWebhookTranslator();

  it('translates issues.opened into github.issue.opened with scope { owner, repo }', () => {
    const event = translator.translate('issues', issuesPayload('opened'));

    expect(event).toBeDefined();
    expect(event?.type).toBe('github.issue.opened');
    expect(event?.scope).toEqual({ owner: 'julianjab', repo: 'accountant' });
    expect(event?.payload).toEqual({
      title: 'App crashes on login',
      body: 'steps to reproduce...',
      number: 42,
      owner: 'julianjab',
      repo: 'accountant',
      labels: ['bug', 'p1'],
      sender: 'someone',
    });
    expect(event?.depth).toBe(0);
    expect(typeof event?.occurredAt).toBe('string');
  });

  it.each([
    ['closed', 'github.issue.closed'],
    ['reopened', 'github.issue.reopened'],
    ['labeled', 'github.issue.labeled'],
    ['unlabeled', 'github.issue.unlabeled'],
    ['edited', 'github.issue.edited'],
  ])('maps issues action "%s" to "%s"', (action, expectedType) => {
    const event = translator.translate('issues', issuesPayload(action));
    expect(event?.type).toBe(expectedType);
  });

  it('returns undefined for an issues action it does not translate (ej. "assigned")', () => {
    expect(translator.translate('issues', issuesPayload('assigned'))).toBeUndefined();
  });

  it('translates issue_comment.created into github.issue.comment.created with the comment body', () => {
    const event = translator.translate('issue_comment', issueCommentPayload('created'));

    expect(event?.type).toBe('github.issue.comment.created');
    expect(event?.payload).toMatchObject({ commentId: 999, commentBody: 'looks good', number: 7 });
    expect(event?.scope).toEqual({ owner: 'o', repo: 'r' });
  });

  it('returns undefined for an event type this translator does not know', () => {
    expect(translator.translate('pull_request', { action: 'opened' })).toBeUndefined();
    expect(translator.translate('workflow_run', {})).toBeUndefined();
  });

  it('defaults to an empty labels array when the issue has none', () => {
    const event = translator.translate(
      'issues',
      issuesPayload('opened', { issue: { title: 't', body: 'b', number: 1, labels: undefined } }),
    );
    expect((event?.payload as { labels: string[] }).labels).toEqual([]);
  });
});
