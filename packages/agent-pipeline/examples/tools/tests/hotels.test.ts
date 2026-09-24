import { describe, expect, it } from 'vitest';
import { searchHotelsTool } from '../hotels.js';

describe('searchHotelsTool', () => {
  it('declares its Anthropic tool shape', () => {
    expect(searchHotelsTool.name).toBe('search_hotels');
    expect(searchHotelsTool.inputSchema).toMatchObject({ type: 'object' });
  });

  it('returns a JSON list of hotels for a known city', async () => {
    const result = await searchHotelsTool.handler({ city: 'MDE', nights: 3 });
    const hotels = JSON.parse(result);
    expect(Array.isArray(hotels)).toBe(true);
    expect(hotels.length).toBeGreaterThan(0);
    expect(hotels[0]).toHaveProperty('name');
    expect(hotels[0]).toHaveProperty('pricePerNightUsd');
  });

  it('returns a human-readable message for an unknown city instead of an empty array', async () => {
    const result = await searchHotelsTool.handler({ city: 'ZZZ', nights: 2 });
    expect(result).toBe('No se encontraron hoteles para esa ciudad.');
  });
});
