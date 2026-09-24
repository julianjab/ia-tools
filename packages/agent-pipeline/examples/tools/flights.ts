import type { Tool } from '../agent.js';

export interface FlightSearchInput {
  origin: string;
  destination: string;
  departDate: string;
}

interface FlightOption {
  airline: string;
  priceUsd: number;
  departTime: string;
}

/** Catálogo fijo — acá iría una llamada real a una API de vuelos (Amadeus, Skyscanner, ...).
 *  La tool sólo sabe hablar el protocolo de Anthropic; esto es lógica de negocio pura. */
async function searchFlights(input: FlightSearchInput): Promise<FlightOption[]> {
  const catalog: Record<string, FlightOption[]> = {
    'BOG-MDE': [
      { airline: 'Avianca', priceUsd: 320, departTime: '07:10' },
      { airline: 'LATAM', priceUsd: 290, departTime: '14:45' },
    ],
    'BOG-CTG': [{ airline: 'Wingo', priceUsd: 180, departTime: '09:00' }],
  };
  const key = `${input.origin}-${input.destination}`;
  return catalog[key] ?? [];
}

export const searchFlightsTool: Tool<FlightSearchInput> = {
  name: 'search_flights',
  description: 'Busca vuelos disponibles entre dos ciudades para una fecha dada.',
  inputSchema: {
    type: 'object',
    properties: {
      origin: { type: 'string', description: 'Código IATA de origen, ej. BOG' },
      destination: {
        type: 'string',
        description: 'Código IATA de destino, ej. MDE',
      },
      departDate: {
        type: 'string',
        description: 'Fecha de salida, YYYY-MM-DD',
      },
    },
    required: ['origin', 'destination', 'departDate'],
  },
  handler: async (input) => {
    const flights = await searchFlights(input);
    if (flights.length === 0) return 'No se encontraron vuelos para esa ruta.';
    return JSON.stringify(flights);
  },
};
