import { describe, expect, it } from 'vitest';
import { exitSet } from '../AgentDefinition.js';

describe('exitSet', () => {
  it('returns undefined for undefined', () => {
    expect(exitSet(undefined)).toBeUndefined();
  });

  it('returns a short-form exit as-is', () => {
    expect(exitSet('actionable')).toBe('actionable');
  });

  it('reads `set` off a long-form exit', () => {
    expect(exitSet({ set: 'review', comment: 'pr' })).toBe('review');
  });
});
