/**
 * Caso 3: pipelines que recomiendan vuelos y hoteles para un viaje.
 *
 * Nada de GitHub ni Slack acá — el "evento" es un pedido explícito (podría venir de un
 * formulario, una API, o un mensaje de Slack traducido como en el ejemplo anterior). Lo
 * que importa: dos agentes INDEPENDIENTES (vuelos, hoteles) corren como pasos de la misma
 * cadena, y un tercero combina sus outputs — sin que el Engine sepa nada de viajes.
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
  functionAgent,
} from '../src/index.js';

interface TripRequestPayload {
  tripId: string;
  origin: string;
  destination: string;
  departDate: string;
  budgetUsd: number;
}

interface FlightOption {
  airline: string;
  priceUsd: number;
}

interface HotelOption {
  name: string;
  pricePerNightUsd: number;
}

const agents = new AgentRegistry()
  .register(
    // En producción: llama a una API de vuelos (Amadeus, Skyscanner, …) y deja que un LLM
    // ranquee las opciones — acá simulado con datos fijos.
    functionAgent<FlightOption[]>('search-flights', (input) => {
      const trip = input.event.payload as TripRequestPayload;
      return [
        { airline: 'Avianca', priceUsd: 320 },
        { airline: 'LATAM', priceUsd: 290 },
      ].filter((flight) => flight.priceUsd <= trip.budgetUsd);
    }),
  )
  .register(
    functionAgent<HotelOption[]>('search-hotels', (input) => {
      const trip = input.event.payload as TripRequestPayload;
      return [
        { name: 'Hotel Centro', pricePerNightUsd: 60 },
        { name: 'Boutique Stay', pricePerNightUsd: 95 },
      ].filter((hotel) => hotel.pricePerNightUsd * 3 <= trip.budgetUsd);
    }),
  );

const tripPlannerPipeline = new Pipeline({
  id: 'trip-planner',
  on: ['travel.trip.requested'],
  do: [
    // Dos AgentActions sin `when` entre sí: corren en secuencia dentro del mismo Pipeline,
    // pero no dependen una de la otra — podrían paralelizarse con dos Pipelines separados
    // sobre el mismo evento si el volumen lo justifica.
    new AgentAction({ id: 'flights', agentId: 'search-flights' }),
    new AgentAction({ id: 'hotels', agentId: 'search-hotels' }),
    new FunctionAction({
      id: 'summary',
      fn: (ctx) => {
        const flights = (ctx.steps.flights as { output: FlightOption[] }).output;
        const hotels = (ctx.steps.hotels as { output: HotelOption[] }).output;
        const summary = {
          cheapestFlight: flights.sort((a, b) => a.priceUsd - b.priceUsd)[0],
          cheapestHotel: hotels.sort((a, b) => a.pricePerNightUsd - b.pricePerNightUsd)[0],
        };
        console.log('[trip-planner] recomendación:', summary);
        return summary;
      },
    }),
  ],
});

async function main() {
  const bus = new EventBus();
  const engine = new Engine({
    bus,
    agents,
    pipelines: new StaticPipelineSource([tripPlannerPipeline]),
  });
  engine.start();

  await bus.publish(
    createEvent<TripRequestPayload>('travel.trip.requested', {
      tripId: 't_1',
      origin: 'BOG',
      destination: 'MDE',
      departDate: '2026-10-01',
      budgetUsd: 400,
    }),
  );
}

main();
