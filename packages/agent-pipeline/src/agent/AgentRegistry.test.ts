import { describe, expect, it } from 'vitest';
import { AgentRegistry } from './AgentRegistry.js';
import { functionAgent } from './FunctionAgent.js';

describe('AgentRegistry', () => {
  it('resolves a registered agent by id', () => {
    const registry = new AgentRegistry();
    const agent = functionAgent('a', () => 'ok');

    registry.register(agent);

    expect(registry.get('a')).toBe(agent);
  });

  it('returns undefined for an unknown id', () => {
    const registry = new AgentRegistry();
    expect(registry.get('missing')).toBeUndefined();
  });

  it('register returns `this` so calls can chain', () => {
    const registry = new AgentRegistry();
    const result = registry
      .register(functionAgent('a', () => 'ok'))
      .register(functionAgent('b', () => 'ok'));

    expect(result).toBe(registry);
    expect(registry.get('a')).toBeDefined();
    expect(registry.get('b')).toBeDefined();
  });

  it('registering the same id twice overwrites the previous agent', () => {
    const registry = new AgentRegistry();
    registry.register(functionAgent('a', () => 'first'));
    registry.register(functionAgent('a', () => 'second'));

    expect(registry.get('a')).toBeDefined();
  });
});
