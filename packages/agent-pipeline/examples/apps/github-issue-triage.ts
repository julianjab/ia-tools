/**
 * Escenario 1: un pipeline que reacciona a issues de GitHub, con un triage REAL (Claude
 * decide si es un bug) encadenado a un segundo paso determinístico que abre el PR — sin
 * tools, sólo una llamada de una vuelta.
 *
 * Correr (desde packages/agent-pipeline): `ANTHROPIC_API_KEY=sk-... npx tsx examples/apps/github-issue-triage.ts`
 */
import {
  Agent,
  Condition,
  Engine,
  EventBus,
  FunctionAction,
  Pipeline,
  StaticPipelineSource,
  createEvent,
  providerRegistry,
} from '../../src/index.js';
import { anthropicProvider } from '../providers/anthropic-provider.js';

interface GithubIssuePayload {
  title: string;
  body: string;
  number: number;
  repo: string;
}

providerRegistry.register(
  anthropicProvider({
    id: 'anthropic-api',
    model: 'claude-haiku-4-5-20251001',
    resolveOutcome: (text) => (text.trim() === 'actionable' ? 'actionable' : 'not-actionable'),
  }),
);

const pipeline = new Pipeline({
  id: 'github-bug-triage',
  on: ['github.issue.opened'],
  do: [
    new Agent({
      id: 'triage',
      provider: 'anthropic-api',
      prompt:
        'Sos un triager de issues de GitHub.\n\n' +
        'Título: {{title}}\n' +
        'Descripción: {{body}}\n\n' +
        'Respondé EXACTAMENTE "actionable" si describe un bug/crash accionable, o ' +
        '"not-actionable" en cualquier otro caso. Sin explicación, sin puntuación extra.',
      // Identity mapping: `resolveOutcome` (arriba) ya deja el outcome en el valor final —
      // `exits` es igual el punto donde ESTE agente declara qué outcomes son legítimos.
      exits: { actionable: 'actionable', 'not-actionable': 'not-actionable' },
    }),
    new FunctionAction({
      id: 'fix',
      when: Condition.fromRows([{ field: 'steps.triage.exit', op: 'eq', value: 'actionable' }]),
      fn: (ctx) => {
        const payload = ctx.event.payload as GithubIssuePayload;
        return `PR abierto para ${payload.repo}#${payload.number}: "${payload.title}"`;
      },
    }),
    new FunctionAction({
      fn: (ctx) => {
        const triage = ctx.steps.triage as { exit: string };
        console.log(`→ triage: ${triage.exit}`);
        if (ctx.steps.fix) console.log(`→ ${ctx.steps.fix}`);
      },
    }),
  ],
});

async function main() {
  const bus = new EventBus();
  const engine = new Engine({ bus, pipelines: new StaticPipelineSource([pipeline]) });
  engine.start();

  const event = createEvent<GithubIssuePayload>('github.issue.opened', {
    title: 'App crashes on login screen',
    body: 'Steps to reproduce: open the app, tap login, it crashes immediately.',
    number: 42,
    repo: 'julianjab/accountant',
  });

  console.log('→ evento:', event.payload.title);
  await bus.publish(event);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
