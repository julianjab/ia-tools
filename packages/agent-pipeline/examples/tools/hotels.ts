import type { Tool } from '../agent.js';

export interface HotelSearchInput {
  city: string;
  nights: number;
}

interface HotelOption {
  name: string;
  pricePerNightUsd: number;
  rating: number;
}

async function searchHotels(input: HotelSearchInput): Promise<HotelOption[]> {
  const catalog: Record<string, HotelOption[]> = {
    MDE: [
      { name: 'Hotel Centro', pricePerNightUsd: 60, rating: 4.1 },
      { name: 'Boutique Stay', pricePerNightUsd: 95, rating: 4.6 },
    ],
    CTG: [{ name: 'Casa Colonial', pricePerNightUsd: 120, rating: 4.8 }],
  };
  return catalog[input.city] ?? [];
}

export const searchHotelsTool: Tool<HotelSearchInput> = {
  name: 'search_hotels',
  description: 'Busca hoteles disponibles en una ciudad para una cantidad de noches.',
  inputSchema: {
    type: 'object',
    properties: {
      city: {
        type: 'string',
        description: 'Código IATA de la ciudad, ej. MDE',
      },
      nights: { type: 'number', description: 'Cantidad de noches' },
    },
    required: ['city', 'nights'],
  },
  handler: async (input) => {
    const hotels = await searchHotels(input);
    if (hotels.length === 0) return 'No se encontraron hoteles para esa ciudad.';
    return JSON.stringify(hotels);
  },
};
