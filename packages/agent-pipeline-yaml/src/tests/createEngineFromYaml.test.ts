import { join } from 'node:path';
import { Action, ProviderRegistry, createEvent, scopeExecutionKey } from '@ia-tools/agent-pipeline';
import { sqliteStoreDriver } from '@ia-tools/agent-pipeline-sqlite/node';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { YamlCatalogs } from '../YamlCatalogs.js';
import { createEngineFromYaml } from '../createEngineFromYaml.js';
import { CI_GATE, projectDir } from './fixtures.js';

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

/** Una app: `engine.yaml` + `projects/flow/…`. */
function app(engineYaml: string): string {
  return projectDir({
    'engine.yaml': engineYaml,
    ...Object.fromEntries(
      Object.entries(CI_GATE).map(([file, content]) => [`projects/flow/${file}`, content]),
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
  - root: ./projects
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
    const root = app('sources:\n  - dir: ./projects/flow\n');
    const plain = createEngineFromYaml(join(root, 'engine.yaml'), { catalogs: catalogs([]) });
    expect(plain.executions).toBeUndefined();
    plain.stop();

    const withMemory = app('executions: { driver: memory }\nsources:\n  - dir: ./projects/flow\n');
    const memory = createEngineFromYaml(join(withMemory, 'engine.yaml'), {
      catalogs: catalogs([]),
    });
    expect(memory.executions?.stats).toEqual({ running: 0, waiting: 0, paused: 0 });
    memory.stop();
  });

  it('ticks on its own when tick.everyMs is set, until stopped', async () => {
    const root = app('tick: { everyMs: 5 }\nsources:\n  - dir: ./projects/flow\n');
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
    const root = app('executions: { driver: postgres }\nsources:\n  - dir: ./projects/flow\n');
    expect(() =>
      createEngineFromYaml(join(root, 'engine.yaml'), { catalogs: catalogs([]) }),
    ).toThrow(/executions.driver "postgres" no está registrado — hay: memory/);
  });
});
