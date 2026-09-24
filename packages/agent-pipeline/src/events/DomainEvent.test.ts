import { describe, expect, it } from 'vitest';
import { createEvent, deriveEvent } from './DomainEvent.js';

describe('createEvent', () => {
  it('defaults depth to 0 and stamps occurredAt', () => {
    const event = createEvent('github.issue.opened', { title: 'x' });
    expect(event.type).toBe('github.issue.opened');
    expect(event.payload).toEqual({ title: 'x' });
    expect(event.depth).toBe(0);
    expect(event.scope).toBeUndefined();
    expect(typeof event.occurredAt).toBe('string');
    expect(new Date(event.occurredAt).toString()).not.toBe('Invalid Date');
  });

  it('accepts explicit scope/depth/occurredAt overrides', () => {
    const event = createEvent(
      'slack.message',
      { text: 'hi' },
      { scope: { channel: 'C1' }, depth: 2, occurredAt: '2026-01-01T00:00:00.000Z' },
    );
    expect(event.scope).toEqual({ channel: 'C1' });
    expect(event.depth).toBe(2);
    expect(event.occurredAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('deriveEvent', () => {
  it('increments depth relative to the parent event', () => {
    const parent = createEvent('a', {}, { depth: 3 });
    const child = deriveEvent(parent, 'b', { x: 1 });
    expect(child.depth).toBe(4);
    expect(child.type).toBe('b');
    expect(child.payload).toEqual({ x: 1 });
  });

  it('allows overriding scope on the derived event', () => {
    const parent = createEvent('a', {});
    const child = deriveEvent(parent, 'b', {}, { scope: { tripId: 't1' } });
    expect(child.scope).toEqual({ tripId: 't1' });
  });
});
