/**
 * Caso 2: pipelines que reaccionan a mensajes de Slack.
 *
 * El handler de Socket Mode / Events API de Slack traduce cada mensaje entrante a
 * un `DomainEvent` — igual que el webhook de GitHub del otro ejemplo. El mismo
 * `Engine`, sin ninguna línea nueva, sirve para los dos mundos.
 */
import {
  AgentAction,
  AgentRegistry,
  Condition,
  Engine,
  EventBus,
  FunctionAction,
  Pipeline,
  StaticPipelineSource,
  createEvent,
  functionAgent,
} from '../src/index.js';

interface SlackMessagePayload {
  text: string;
  channel: string;
  user: string;
}

const agents = new AgentRegistry().register(
  // En producción: un Agent propio que le pasa el texto del mensaje a un LLM.
  functionAgent<string>('answer-question', (input) => {
    const payload = input.event.payload as SlackMessagePayload;
    return `Buena pregunta, ${payload.user} — dejame revisarlo y te aviso en este hilo.`;
  }),
);

const supportPipeline = new Pipeline({
  id: 'slack-support-triage',
  on: ['slack.message'],
  scope: { channel: 'C_SUPPORT' },
  // Sólo responde si el mensaje termina en "?" — cualquier otro texto lo ignora.
  when: Condition.fromRows([{ field: 'text', op: 'contains', value: '?' }]),
  do: [
    new AgentAction({
      id: 'reply',
      agentId: 'answer-question',
      emitOn: () => 'slack.reply.drafted',
    }),
    new FunctionAction({
      id: 'log',
      fn: (ctx) => console.log('[slack-support-triage] respuesta:', ctx.steps.reply),
    }),
  ],
});

async function main() {
  const bus = new EventBus();
  const engine = new Engine({
    bus,
    agents,
    pipelines: new StaticPipelineSource([supportPipeline]),
  });
  engine.start();

  // Esto sale del handler `app.message(...)` de @slack/bolt en una app real.
  await bus.publish(
    createEvent<SlackMessagePayload>(
      'slack.message',
      { text: '¿cómo conecto mi cuenta de banco?', channel: 'C_SUPPORT', user: 'U123' },
      { scope: { channel: 'C_SUPPORT' } },
    ),
  );
}

main();
