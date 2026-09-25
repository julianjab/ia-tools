import { describe, expect, it } from 'vitest';
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
});
