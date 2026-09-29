import { join } from 'node:path';
import {
  Engine,
  EventBus,
  ProviderRegistry,
  type TextClassifier,
  type WhenText,
  createEvent,
} from '@ia-tools/agent-pipeline';
import { describe, expect, it, vi } from 'vitest';
import type { YamlCatalogs } from '../YamlCatalogs.js';
import { YamlPipelineSource } from '../YamlPipelineSource.js';
import { createEngineFromYaml } from '../createEngineFromYaml.js';
import { projectDir } from './fixtures.js';

/** Dice que sí a los criterios que empiezan con `yes`, y guarda qué le preguntaron. */
function recordingClassifier() {
  const asked: WhenText[] = [];
  const classifier: TextClassifier = {
    classify: async ({ whenText }) => {
      asked.push(whenText);
      return { matches: whenText.text.startsWith('yes'), reason: 'porque sí' };
    },
  };
  return { asked, classifier };
}

const PROJECT = `
id: flow
systemPrompts:
  - id: criterio-pr
    text: Un cambio es algo que alguien tiene que hacer en el código o el PRD.
`;

function mount(files: Record<string, string>, catalogs: YamlCatalogs = {}) {
  const { asked, classifier } = recordingClassifier();
  const ran = vi.fn();
  const source = new YamlPipelineSource({
    dir: projectDir({ 'project.yaml': PROJECT, ...files }),
    catalogs: {
      functions: { ran: (ctx) => ran(ctx.pipelineId) },
      systemPrompts: { resolve: (id) => (id === 'del-catalogo' ? 'Del catálogo.' : undefined) },
      ...catalogs,
    },
  });
  const engine = new Engine({ bus: new EventBus(), pipelines: source, textClassifier: classifier });
  return { engine, asked, ran };
}

describe('whenText in YAML', () => {
  it('a pipeline gate with system prompts by id — the project ones and the catalog ones — and inline', async () => {
    const { engine, asked, ran } = mount({
      'pipelines/yes.yaml': `
id: yes
on: [a]
whenText:
  text: yes, pide un cambio
  systemPrompts: [criterio-pr, del-catalogo, { text: Inline. }]
  model: claude-sonnet-4-6
do:
  - { function: ran }
`,
      'pipelines/no.yaml': `
id: no
on: [a]
whenText: no aplica
do:
  - { function: ran }
`,
    });

    await engine.dispatch(createEvent('a', {}));

    expect(ran.mock.calls.map(([pipeline]) => pipeline)).toEqual(['yes']);
    expect(asked).toContainEqual({
      text: 'yes, pide un cambio',
      systemPrompts: [
        'Un cambio es algo que alguien tiene que hacer en el código o el PRD.',
        'Del catálogo.',
        'Inline.',
      ],
      model: 'claude-sonnet-4-6',
    });
    expect(asked).toContainEqual({ text: 'no aplica' });
  });

  it('on a step and on an agent step (which wins over the agent’s own)', async () => {
    const providers = new ProviderRegistry().register({
      id: 'fake',
      run: async (ctx) => {
        await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({});
        return { outcome: 'done' };
      },
    });
    const { engine, asked, ran } = mount(
      {
        'agents/writer.yaml': `
id: writer
provider: fake
prompt: Escribí.
whenText: no, el del agente
`,
        'pipelines/p.yaml': `
id: p
on: [a]
do:
  - { function: ran, whenText: no corre }
  - { agent: writer, whenText: 'yes, el del paso' }
  - { function: ran, id: after, whenText: 'yes, otro' }
`,
      },
      { providers },
    );

    await engine.dispatch(createEvent('a', {}));

    expect(asked.map((w) => w.text)).toEqual(['no corre', 'yes, el del paso', 'yes, otro']);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('a system prompt id nobody declares breaks the load', () => {
    expect(() =>
      mount({
        'pipelines/p.yaml': `
id: p
on: [a]
whenText: { text: x, systemPrompts: [no-existe] }
do:
  - { function: ran }
`,
      }),
    ).toThrow(
      /pipelines\/p\.yaml: whenText.*no hay un system prompt "no-existe" — el proyecto declara: criterio-pr/,
    );
  });

  it('engine.yaml whenText: builds the Anthropic classifier; a textClassifier option wins', async () => {
    const dir = projectDir({
      'engine.yaml': `
sources: [{ root: ./projects }]
whenText: { model: claude-haiku-4-5, apiKeyEnv: SOME_UNSET_KEY }
`,
      'projects/flow/project.yaml': 'id: flow',
      'projects/flow/pipelines/p.yaml': `
id: p
on: [a]
whenText: yes
do:
  - { function: ran }
`,
    });
    const ran = vi.fn();
    const functions = { ran: () => ran() };

    // Sin la key, el clasificador de Anthropic no decide: no corre.
    const anthropic = createEngineFromYaml(join(dir, 'engine.yaml'), { catalogs: { functions } });
    expect(await anthropic.engine.select(createEvent('a', {}))).toEqual([]);
    anthropic.stop();

    const { classifier } = recordingClassifier();
    const own = createEngineFromYaml(join(dir, 'engine.yaml'), {
      catalogs: { functions },
      textClassifier: classifier,
    });
    expect((await own.engine.select(createEvent('a', {}))).map((p) => p.id)).toEqual(['p']);
    own.stop();
  });
});
