import { describe, expect, it } from 'vitest';
import { Condition } from '../../condition/Condition.js';
import { createEvent } from '../../events/DomainEvent.js';
import { EventBus } from '../../events/EventBus.js';
import { Pipeline } from '../../pipeline/Pipeline.js';
import type { PipelineExecutionContext } from '../../pipeline/Runnable.js';
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js';
import { Engine } from '../Engine.js';
import { Project } from '../Project.js';

describe('Project', () => {
  it('lists its pipelines and exposes onError/report as defaults', () => {
    const report = new FunctionAction({ id: 'report', fn: () => null });
    const onError = { to: new FunctionAction({ id: 'blocked', fn: () => null }) };
    const pipeline = new Pipeline({ id: 'p', on: ['a'], do: [] });

    const project = new Project({ id: 'lahaus', pipelines: [pipeline], report, onError });

    expect(project.list()).toEqual([pipeline]);
    expect(project.defaults).toEqual({ report, onError });
  });

  it('rejects two pipelines with the same id', () => {
    const one = new Pipeline({ id: 'p', on: ['a'], do: [] });
    const two = new Pipeline({ id: 'p', on: ['b'], do: [] });

    expect(() => new Project({ id: 'lahaus', pipelines: [one, two] })).toThrow(
      /dos pipelines con el id "p"/,
    );
  });

  it('the Engine passes the project defaults into every pipeline run', async () => {
    const report = new FunctionAction({ id: 'report', fn: () => null });
    let seen: PipelineExecutionContext['defaults'];
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          fn: (ctx) => {
            seen = ctx.defaults;
          },
        }),
      ],
    });
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new Project({ id: 'lahaus', pipelines: [pipeline], report }),
    });

    await engine.dispatch(createEvent('a', {}));

    expect(seen).toEqual({ report, onError: undefined });
  });

  it('its when is the first filter: an event that fails it never reaches any of its pipelines', async () => {
    const ran: string[] = [];
    const step = (id: string) => new FunctionAction({ fn: () => void ran.push(id) });
    const notBlocked = Condition.fromRows([
      { field: 'item.labels', op: 'notContains', value: 'blocked' },
    ]);
    const project = new Project({
      id: 'prod',
      when: notBlocked,
      pipelines: [
        new Pipeline({ id: 'refine', on: ['a'], do: [step('refine')] }),
        new Pipeline({ id: 'review', on: ['a'], do: [step('review')] }),
      ],
    });
    const engine = new Engine({ bus: new EventBus(), pipelines: project });

    expect(await engine.dispatch(createEvent('a', { item: { labels: ['blocked'] } }))).toBe(
      'skipped',
    );
    expect(ran).toEqual([]);
    expect(project.explainMismatch(createEvent('a', { item: { labels: ['blocked'] } }))).toMatch(
      /^proyecto prod: no cumple: item\.labels notContains "blocked"/,
    );

    await engine.dispatch(createEvent('a', { item: { labels: [] } }));
    expect(ran.sort()).toEqual(['refine', 'review']);
  });

  it('with several projects, each filters its own pipelines and runs them with its own defaults', async () => {
    const localReport = new FunctionAction({ id: 'local-report', fn: () => null });
    const ran: Array<[string, unknown]> = [];
    const pipeline = (id: string) =>
      new Pipeline({
        id,
        on: ['a'],
        do: [new FunctionAction({ fn: (ctx) => void ran.push([id, ctx.defaults?.report]) })],
      });
    const blocked = { field: 'item.labels', op: 'contains', value: 'blocked' } as const;
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: [
        new Project({
          id: 'prod',
          when: Condition.fromRows([{ ...blocked, op: 'notContains' }]),
          pipelines: [pipeline('prod-refine')],
        }),
        new Project({
          id: 'local',
          when: Condition.fromRows([blocked]),
          pipelines: [pipeline('local-refine')],
          report: localReport,
        }),
      ],
    });
    const event = createEvent('a', { item: { labels: ['blocked'] } });

    expect((await engine.select(event)).map((p) => p.id)).toEqual(['local-refine']);
    await engine.dispatch(event);
    expect(ran).toEqual([['local-refine', localReport]]);
  });
});
