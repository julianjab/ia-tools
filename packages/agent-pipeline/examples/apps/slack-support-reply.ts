/**
 * Escenario 2: un pipeline que reacciona a mensajes de Slack, con un agente REAL que redacta
 * la respuesta — sólo si el mensaje matchea un `when` de texto (termina en "?"). Sin tools:
 * responder una pregunta de soporte no necesita que el modelo ejecute nada.
 *
 * Correr (desde packages/agent-pipeline): `ANTHROPIC_API_KEY=sk-... npx tsx examples/apps/slack-support-reply.ts`
 */
import {
  Agent,
  Condition,
  Engine,
  EventBus,
  FunctionAction,
  Pipeline,
  SUCCESS_EXIT,
  StaticPipelineSource,
  createEvent,
  providerRegistry,
} from '../../src/index.js';
import { anthropicProvider } from '../providers/anthropic-provider.js';

interface SlackMessagePayload {
  text: string;
  channel: string;
  user: string;
}

providerRegistry.register(
  anthropicProvider({ id: 'anthropic-api', model: 'claude-haiku-4-5-20251001' }),
);

const pipeline = new Pipeline({
  id: 'slack-support-triage',
  on: ['slack.message'],
  scope: { channel: 'C_SUPPORT' },
  // Sólo responde si el mensaje termina en "?" — cualquier otro texto lo ignora.
  when: Condition.fromRows([{ field: 'text', op: 'contains', value: '?' }]),
  do: [
    new Agent({
      id: 'reply',
      provider: 'anthropic-api',
      prompt:
        'Sos soporte de una app de finanzas personales.\n\n' +
        'Usuario: {{user}}\n' +
        'Pregunta: {{text}}\n\n' +
        'Respondé la pregunta en 1-2 oraciones, tono cordial, en español.',
      exits: { [SUCCESS_EXIT]: SUCCESS_EXIT },
    }),
    new FunctionAction({
      fn: (ctx) => {
        const reply = ctx.steps.reply as { output: { summary?: string } };
        console.log(`\n→ respuesta:\n${reply.output.summary}`);
      },
    }),
  ],
});

async function main() {
  const bus = new EventBus();
  const engine = new Engine({ bus, pipelines: new StaticPipelineSource([pipeline]) });
  engine.start();

  const event = createEvent<SlackMessagePayload>(
    'slack.message',
    { text: '¿cómo conecto mi cuenta de banco?', channel: 'C_SUPPORT', user: 'U123' },
    { scope: { channel: 'C_SUPPORT' } },
  );

  console.log('→ mensaje:', event.payload.text);
  await bus.publish(event);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
