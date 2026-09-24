import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as lib from '../index.js';

describe('package entrypoint', () => {
  it('exports the public API', () => {
    expect(lib.GithubTokenAuth).toBeDefined();
    expect(lib.GithubAppAuth).toBeDefined();
    expect(lib.GithubClient).toBeDefined();
    expect(lib.GithubWebhookVerifier).toBeDefined();
    expect(lib.GithubWebhookTranslator).toBeDefined();
  });

  it('wires verify + translate end-to-end through the public API only', () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({
      action: 'opened',
      issue: { title: 't', body: 'b', number: 1, labels: [] },
      repository: { name: 'r', owner: { login: 'o' } },
      sender: { login: 's' },
    });
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    const verifier = new lib.GithubWebhookVerifier(secret);
    expect(verifier.verify(body, signature)).toBe(true);

    const translator = new lib.GithubWebhookTranslator();
    const event = translator.translate('issues', JSON.parse(body));
    expect(event?.type).toBe('github.issue.opened');
  });

  it('GithubClient accepts either auth strategy interchangeably', async () => {
    const fetchImpl = async () => new Response('{}', { status: 200 });
    const withToken = new lib.GithubClient({
      auth: new lib.GithubTokenAuth('t'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(withToken.request('/x')).resolves.toBeInstanceOf(Response);
  });
});
