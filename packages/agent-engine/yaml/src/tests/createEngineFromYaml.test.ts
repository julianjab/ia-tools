import { join } from 'node:path';
import { Action, ProviderRegistry, createEvent, scopeExecutionKey } from '@ia-tools/agent-engine';
import { sqliteStoreDriver } from '@ia-tools/agent-engine-sqlite/node';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { YamlCatalogs } from '../YamlCatalogs.js';
import { YamlPipelineSource } from '../YamlPipelineSource.js';
import { createEngineFromYaml, messageTemplate } from '../createEngineFromYaml.js';
import { CI_GATE, sourceDir } from './fixtures.js';

class Recorded extends Action {
  readonly description = 'registra';
  readonly input = z.strictObject({ label: z.string().optional() });
  constructor(
    id: string,
    private readonly ran: string[],
  ) {
    super({ id });
  }
  execute(): string {
    this.ran.push(this.id);
    return 'ok';
  }
}

function catalogs(ran: string[]): YamlCatalogs {
  return {
    providers: new ProviderRegistry().register({
      id: 'done',
      run: async (ctx) => {
        ran.push('implementer');
        await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({});
        return { outcome: 'success' };
      },
    }),
    actions: { ensurePr: new Recorded('ensurePr', ran), addLabel: new Recorded('addLabel', ran) },
    functions: { review: (ctx) => ran.push(`review:${ctx.event.type}`) },
  };
}

/** Una app: `engine.yaml` + `sources/flow/…`. */
function app(engineYaml: string): string {
  return sourceDir({
    'engine.yaml': engineYaml,
    ...Object.fromEntries(
      Object.entries(CI_GATE).map(([file, content]) => [`sources/flow/${file}`, content]),
    ),
  });
}

const TASK = { issue: 7 };
const event = (type: string, payload: Record<string, unknown>) =>
  createEvent(type, { ...payload, issue: 7, labels: [] }, { scope: TASK });
const KEY = scopeExecutionKey(event('x', {})) as string;

describe('createEngineFromYaml', () => {
  it('with sqlite, a pause survives stopping the app and starting it again from the same engine.yaml', async () => {
    const ran: string[] = [];
    const root = app(`
maxEventDepth: 5
executions: { driver: sqlite, path: ./data.db, maxConcurrent: 2 }
sources:
  - root: ./sources
`);
    const path = join(root, 'engine.yaml');
    const options = { catalogs: catalogs(ran), drivers: { sqlite: sqliteStoreDriver } };

    const first = createEngineFromYaml(path, options);
    expect(first.sources.map((source) => source.id)).toEqual(['flow']);
    expect(first.engine.maxEventDepth).toBe(5);
    await first.bus.publish(event('build', {}));
    expect(first.executions?.current(KEY)?.status).toBe('paused');
    first.stop();

    const second = createEngineFromYaml(path, options);
    expect(second.executions?.current(KEY)?.pausedOn?.pauseId).toBe('wait-ci');
    expect(await second.engine.dispatch(event('check_suite', { conclusion: 'success' }))).toBe(
      'resumed',
    );
    expect(ran).toEqual(['implementer', 'ensurePr', 'review:check_suite']);
    second.stop();
  });

  it('defaults to no executions, and uses the memory driver when asked', () => {
    const root = app('sources:\n  - dir: ./sources/flow\n');
    const plain = createEngineFromYaml(join(root, 'engine.yaml'), { catalogs: catalogs([]) });
    expect(plain.executions).toBeUndefined();
    plain.stop();

    const withMemory = app('executions: { driver: memory }\nsources:\n  - dir: ./sources/flow\n');
    const memory = createEngineFromYaml(join(withMemory, 'engine.yaml'), {
      catalogs: catalogs([]),
    });
    expect(memory.executions?.stats).toEqual({ running: 0, waiting: 0, paused: 0 });
    memory.stop();
  });

  it('ticks on its own when tick.everyMs is set, until stopped', async () => {
    const root = app('tick: { everyMs: 5 }\nsources:\n  - dir: ./sources/flow\n');
    const { engine, stop } = createEngineFromYaml(join(root, 'engine.yaml'), {
      catalogs: catalogs([]),
    });
    const tick = vi.spyOn(engine, 'tick');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tick).toHaveBeenCalled();
    stop();
    tick.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tick).not.toHaveBeenCalled();
  });

  it('refuses a driver nobody registered, saying which ones there are', () => {
    const root = app('executions: { driver: postgres }\nsources:\n  - dir: ./sources/flow\n');
    expect(() =>
      createEngineFromYaml(join(root, 'engine.yaml'), { catalogs: catalogs([]) }),
    ).toThrow(/executions.driver "postgres" no está registrado — hay: memory/);
  });

  it('reads its config from a section of a bigger file (e.g. the engine: of an app runner.yaml)', () => {
    const root = app(`
settings: { port: 3001 }
engine:
  maxEventDepth: 3
  sources:
    - dir: ./sources/flow
      id: mounted
`);
    const mounted = createEngineFromYaml(join(root, 'engine.yaml'), {
      section: 'engine',
      catalogs: catalogs([]),
    });
    expect(mounted.engine.maxEventDepth).toBe(3);
    expect(mounted.sources.map((source) => source.id)).toEqual(['mounted']);
    mounted.stop();
    expect(() =>
      createEngineFromYaml(join(root, 'engine.yaml'), { section: 'nope', catalogs: catalogs([]) }),
    ).toThrow(/engine\.yaml: inválido/);
  });

  it('takes no sources from the file when the app passes its own, and needs one or the other', async () => {
    const root = app('maxEventDepth: 3\n');
    const own = createEngineFromYaml(join(root, 'engine.yaml'), {
      sources: [
        new YamlPipelineSource({ dir: join(root, 'sources/flow'), catalogs: catalogs([]) }),
      ],
    });
    expect((await own.engine.select(event('build', {}))).map((p) => p.id)).toEqual(['build']);
    own.stop();
    expect(() => createEngineFromYaml(join(root, 'engine.yaml'))).toThrow(/no hay ninguna fuente/);
  });
});

describe('formatMessage template', () => {
  it('renders against the payload; empty, falls back to the default message', () => {
    const format = messageTemplate('{{message}}') as (e: ReturnType<typeof createEvent>) => string;
    expect(format(createEvent('issue_comment', { message: 'Comentario de @ana' }))).toBe(
      'Comentario de @ana',
    );
    expect(format(createEvent('x', { n: 1 }))).toBe('Evento x: {"n":1}');
    expect(messageTemplate(undefined)).toBeUndefined();
  });
});
