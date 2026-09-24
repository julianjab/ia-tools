import { describe, expect, it } from 'vitest';
import { searchFlightsTool } from '../flights.js';

describe('searchFlightsTool', () => {
  it('declares its Anthropic tool shape', () => {
    expect(searchFlightsTool.name).toBe('search_flights');
    expect(searchFlightsTool.inputSchema).toMatchObject({ type: 'object' });
  });

  it('returns a JSON list of flights for a known route', async () => {
    const result = await searchFlightsTool.handler({
      origin: 'BOG',
      destination: 'MDE',
      departDate: '2026-10-01',
    });
    const flights = JSON.parse(result);
    expect(Array.isArray(flights)).toBe(true);
    expect(flights.length).toBeGreaterThan(0);
    expect(flights[0]).toHaveProperty('airline');
    expect(flights[0]).toHaveProperty('priceUsd');
  });

  it('returns a human-readable message for an unknown route instead of an empty array', async () => {
    const result = await searchFlightsTool.handler({
      origin: 'XXX',
      destination: 'YYY',
      departDate: '2026-10-01',
    });
    expect(result).toBe('No se encontraron vuelos para esa ruta.');
  });
});
