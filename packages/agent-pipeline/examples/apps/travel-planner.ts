/**
 * Escenario 3: un pipeline que recomienda vuelos y hoteles para un viaje — con un agente REAL
 * que decide cuándo llamar cada tool (search_flights / search_hotels) y arma la recomendación
 * final. Las tools son lógica de negocio pura en ../tools/; el agente sólo orquesta el diálogo.
 *
 * Correr (desde packages/agent-pipeline): `ANTHROPIC_API_KEY=sk-... npx tsx examples/apps/travel-planner.ts`
 */
import {
  AgentAction,
  AgentRegistry,
  Engine,
  EventBus,
  FunctionAction,
  Pipeline,
  StaticPipelineSource,
  createEvent,
} from '../../src/index.js';
import { SUCCESS_EXIT, agent, providerRegistry } from '../agent.js';
import { anthropicProvider } from '../providers/anthropic-provider.js';
import { searchFlightsTool } from '../tools/flights.js';
import { searchHotelsTool } from '../tools/hotels.js';

interface TripRequestPayload {
  tripId: string;
  origin: string;
  destination: string;
  departDate: string;
  nights: number;
}

providerRegistry.register(anthropicProvider({ id: 'anthropic-api', model: 'claude-sonnet-5' }));

const agents = new AgentRegistry().register(
  agent({
    id: 'plan-trip',
    provider: 'anthropic-api',
    prompt:
      'Sos un planificador de viajes. Te paso un JSON con { payload: { origin, destination, ' +
      'departDate, nights } }. Usá las tools search_flights y search_hotels para averiguar ' +
      'opciones reales, y respondé con un resumen breve en texto plano: el vuelo más barato y ' +
      'el hotel mejor calificado, con sus precios.',
    tools: [searchFlightsTool, searchHotelsTool],
    exits: { [SUCCESS_EXIT]: SUCCESS_EXIT },
  }),
);

const pipeline = new Pipeline({
  id: 'trip-planner',
  on: ['travel.trip.requested'],
  do: [
    new AgentAction({ id: 'plan', agentId: 'plan-trip' }),
    new FunctionAction({
      fn: (ctx) => {
        const plan = ctx.steps.plan as { output: { summary?: string } };
        console.log(`\n→ recomendación:\n${plan.output.summary}`);
      },
    }),
  ],
});

async function main() {
  const bus = new EventBus();
  const engine = new Engine({ bus, agents, pipelines: new StaticPipelineSource([pipeline]) });
  engine.start();

  const event = createEvent<TripRequestPayload>('travel.trip.requested', {
    tripId: 't_1',
    origin: 'BOG',
    destination: 'MDE',
    departDate: '2026-10-01',
    nights: 3,
  });

  console.log('→ pedido de viaje:', event.payload);
  await bus.publish(event);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
