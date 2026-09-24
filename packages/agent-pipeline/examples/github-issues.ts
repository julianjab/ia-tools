/**
 * Caso 1: pipelines que reaccionan a tareas en GitHub.
 *
 * En una app real, un webhook de GitHub (o un poller sobre la API) traduce cada
 * evento a un `DomainEvent` y lo publica en el bus — ESE es el único código
 * específico de GitHub. Todo lo demás (matching, cadena de agentes, condiciones)
 * es el harness genérico.
 */
import {
  AgentAction,
  AgentRegistry,
  Condition,
  Engine,
  EventBus,
  Pipeline,
  StaticPipelineSource,
  createEvent,
  functionAgent,
} from '../src/index.js';

interface GithubIssuePayload {
  title: string;
  body: string;
  number: number;
  repo: string;
}

const agents = new AgentRegistry()
  // En producción esto sería un Agent propio que llama a un LLM leyendo título/body —
  // ese cliente concreto (SDK, API key, etc.) vive en la app, no en este paquete.
  .register(
    functionAgent<{ actionable: boolean; label: string }>('triage', (input) => {
      const payload = input.event.payload as GithubIssuePayload;
      const isBug = /bug|crash|error/i.test(payload.title);
      return { output: { actionable: isBug, label: isBug ? 'bug' : 'question' }, exit: 'success' };
    }),
  )
  .register(
    functionAgent<string>('open-fix-pr', (input) => {
      const payload = input.event.payload as GithubIssuePayload;
      return `PR abierto para ${payload.repo}#${payload.number}: "${payload.title}"`;
    }),
  );

const githubTriagePipeline = new Pipeline({
  id: 'github-bug-triage',
  on: ['github.issue.opened'],
  // Sólo issues de este repo — el resto de repos los ignora sin tocar código.
  scope: { repo: 'julianjab/accountant' },
  do: [
    new AgentAction({ id: 'triage', agentId: 'triage' }),
    new AgentAction({
      id: 'fix',
      agentId: 'open-fix-pr',
      when: Condition.fromRows([
        { field: 'steps.triage.output.actionable', op: 'eq', value: true },
      ]),
      brief: (ctx) =>
        `Label detectado: ${(ctx.steps.triage as { output: { label: string } }).output.label}`,
    }),
  ],
});

async function main() {
  const bus = new EventBus();
  const engine = new Engine({
    bus,
    agents,
    pipelines: new StaticPipelineSource([githubTriagePipeline]),
  });
  engine.start();

  // Esto es lo que un handler de webhook (POST /webhooks/github) haría con el body real.
  await bus.publish(
    createEvent<GithubIssuePayload>(
      'github.issue.opened',
      { title: 'Crash on login screen', body: '...', number: 42, repo: 'julianjab/accountant' },
      { scope: { repo: 'julianjab/accountant' } },
    ),
  );
}

main();
