import { type DomainEvent, Engine, EventBus, createEvent } from '@ia-tools/agent-pipeline';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../Template.js';
import type { YamlCatalogs } from '../YamlCatalogs.js';
import { YamlPipelineSource } from '../YamlPipelineSource.js';
import { projectDir } from './fixtures.js';

/** El proyecto en un engine escuchando su bus; `emitted` junta lo que publican sus pasos. */
function mount(files: Record<string, string>, catalogs: YamlCatalogs = {}) {
  const source = new YamlPipelineSource({ dir: projectDir(files), catalogs });
  const bus = new EventBus();
  const engine = new Engine({ bus, pipelines: source });
  engine.start();
  const emitted: DomainEvent<unknown>[] = [];
  bus.subscribe('*', (event) => void emitted.push(event));
  return { source, engine, bus, emitted };
}

/** Por qué falló la única pipeline que corrió (`dispatch` junta los fallos en un AggregateError). */
async function failure(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (err: unknown) => err,
  );
  return String((error as AggregateError | undefined)?.errors?.[0]?.message ?? 'no falló');
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('templates', () => {
  it('keep the type of a value that is only a template and turn an embedded one into text', () => {
    const root = { issue: { number: 7, labels: ['a'] }, steps: { card: { status: 'Build' } } };

    expect(render('{{issue.number}}', root)).toBe(7);
    expect(render('{{ issue.labels }}', root)).toEqual(['a']);
    expect(render('#{{issue.number}} en {{steps.card.status}}', root)).toBe('#7 en Build');
    expect(render({ n: '{{issue.number}}', list: ['{{missing}}', 'x{{missing}}'] }, root)).toEqual({
      n: 7,
      list: [undefined, 'x'],
    });
  });
});

describe('vars', () => {
  const files = {
    'project.yaml': `
id: flow
vars:
  prefix: ia-flow/
`,
    'pipelines/p.yaml': `
id: p
on: [a]
when:
  - { field: repo, op: in, value: '{{vars.repos}}' }
do:
  - { emit: b, payload: { branch: '{{vars.prefix}}{{number}}', board: '{{vars.board}}' } }
`,
  };

  it('are substituted on load — also in a when — from project.yaml over the app ones', async () => {
    const { engine, emitted } = mount(files, {
      projectVars: (projectId) => ({
        repos: projectId === 'flow' ? ['la-haus/x'] : [],
        prefix: 'pisado/',
        board: { owner: 'la-haus', number: 119 },
      }),
    });

    await engine.dispatch(createEvent('a', { repo: 'la-haus/y', number: 1 }));
    await engine.dispatch(createEvent('a', { repo: 'la-haus/x', number: 2 }));

    expect(emitted.filter((e) => e.type === 'b').map((e) => e.payload)).toEqual([
      { branch: 'ia-flow/2', board: { owner: 'la-haus', number: 119 } },
    ]);
  });

  it('a var nobody declares breaks the load', () => {
    expect(() => mount(files, { projectVars: () => ({ board: 1 }) })).toThrow(
      /pipelines\/p\.yaml: no hay una var "repos"/,
    );
  });
});

describe('intake/', () => {
  it('its pipelines see the raw event before the project when, and feed the ones that filter', async () => {
    const reached = vi.fn();
    const { source, engine, emitted } = mount(
      {
        'project.yaml': `
id: flow
when:
  - { field: item.labels, op: contains, value: blocked }
`,
        'intake/issues.yaml': `
id: intake-issues
on: [github.issues]
do:
  - emit: issue.opened
    payload: { item: { labels: '{{issue.labels}}' }, number: '{{issue.number}}' }
    scope: { projectId: flow, issue: 'la-haus/x#{{issue.number}}' }
`,
        'pipelines/refine.yaml': `
id: refine
on: [issue.opened, github.issues]
scope: { projectId: flow }
do:
  - { function: reached }
`,
      },
      { functions: { reached } },
    );

    expect(source.intakePipelines().map((pipeline) => pipeline.id)).toEqual(['intake-issues']);
    await engine.dispatch(createEvent('github.issues', { issue: { number: 3, labels: [] } }));
    await engine.dispatch(
      createEvent('github.issues', { issue: { number: 4, labels: ['blocked'] } }),
    );
    await vi.waitFor(() => expect(reached).toHaveBeenCalledTimes(1));

    expect(emitted.filter((e) => e.type === 'issue.opened').map((e) => e.scope)).toEqual([
      { projectId: 'flow', issue: 'la-haus/x#3' },
      { projectId: 'flow', issue: 'la-haus/x#4' },
    ]);
    expect(reached.mock.calls[0]?.[0].event.payload).toEqual({
      item: { labels: ['blocked'] },
      number: 4,
    });
  });
});

describe('http', () => {
  const connection = (fetch: typeof globalThis.fetch) => ({
    github: {
      baseUrl: 'https://api.github.com',
      headers: async () => ({ authorization: 'Bearer t' }),
      fetch,
    },
  });

  it('goes to the connection host with its credential, a templated path and query, and keeps what select says', async () => {
    const fetch = vi.fn(async () => json({ data: { number: 9 } }));
    const seen = vi.fn();
    const { engine } = mount(
      {
        'pipelines/p.yaml': `
id: p
on: [a]
do:
  - id: pr
    http: /repos/{{owner}}/{{repo}}/pulls
    connection: github
    query: { head: '{{owner}}:ia-flow/{{number}}', state: open, missing: '{{nope}}' }
    select: data
  - { function: seen, with: { pr: '{{steps.pr}}' } }
`,
      },
      { connections: connection(fetch), functions: { seen } },
    );

    await engine.dispatch(createEvent('a', { owner: 'la-haus', repo: 'x', number: 7 }));

    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/la-haus/x/pulls?head=la-haus%3Aia-flow%2F7&state=open',
      expect.objectContaining({
        method: 'GET',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      }),
    );
    expect(seen.mock.calls[0]?.[1]).toEqual({ pr: { number: 9 } });
  });

  it('a graphql step posts query and variables, reads data, and fails on errors', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { repository: { issue: { id: 'I_1' } } } }))
      .mockResolvedValueOnce(json({ errors: [{ message: 'Could not resolve' }] }));
    const seen = vi.fn();
    const { engine } = mount(
      {
        'pipelines/p.yaml': `
id: p
on: [a]
do:
  - id: issue
    http: /graphql
    connection: github
    graphql: 'query($n: Int!) { repository { issue(number: $n) { id } } }'
    variables: { n: '{{number}}' }
    select: repository.issue
  - { function: seen, with: { id: '{{steps.issue.id}}' } }
`,
      },
      { connections: connection(fetch), functions: { seen } },
    );

    await engine.dispatch(createEvent('a', { number: 7 }));
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        query: 'query($n: Int!) { repository { issue(number: $n) { id } } }',
        variables: { n: 7 },
      }),
    });
    expect(seen.mock.calls[0]?.[1]).toEqual({ id: 'I_1' });

    expect(await failure(engine.dispatch(createEvent('a', { number: 8 })))).toMatch(
      /GraphQL — Could not resolve/,
    );
  });

  it('a templated path cannot take the credential to another host', async () => {
    const fetch = vi.fn();
    const { engine } = mount(
      {
        'pipelines/p.yaml': `
id: p
on: [a]
do:
  - { http: '{{path}}', connection: github }
`,
      },
      { connections: connection(fetch) },
    );

    for (const path of ['//evil.com/x', '@evil.com/x', 'https://evil.com/x']) {
      expect(await failure(engine.dispatch(createEvent('a', { path })))).toMatch(
        /empieza con "\/"/,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('emit', () => {
  it('forEach publishes one event per item, with type, payload and scope from the templates', async () => {
    const { engine, emitted } = mount({
      'pipelines/p.yaml': `
id: p
on: [merged]
do:
  - emit: '{{kind}}'
    forEach: '{{dependents}}'
    payload: { number: '{{item.number}}', closed: '{{closed}}' }
    scope: { issue: 'x#{{item.number}}' }
`,
    });

    await engine.dispatch(
      createEvent('merged', {
        kind: 'issue.unblocked',
        closed: 7,
        dependents: [{ number: 9 }, { number: 10 }],
      }),
    );

    expect(
      emitted.filter((e) => e.type === 'issue.unblocked').map((e) => [e.payload, e.scope]),
    ).toEqual([
      [{ number: 9, closed: 7 }, { issue: 'x#9' }],
      [{ number: 10, closed: 7 }, { issue: 'x#10' }],
    ]);
  });
});
