import { describe, expect, it } from 'vitest';
import * as lib from './index.js';

describe('package entrypoint', () => {
  it('exports the harness building blocks', () => {
    expect(lib.Condition).toBeDefined();
    expect(lib.EventBus).toBeDefined();
    expect(lib.createEvent).toBeTypeOf('function');
    expect(lib.deriveEvent).toBeTypeOf('function');
    expect(lib.AgentRegistry).toBeDefined();
    expect(lib.functionAgent).toBeTypeOf('function');
    expect(lib.AgentAction).toBeDefined();
    expect(lib.EmitAction).toBeDefined();
    expect(lib.FunctionAction).toBeDefined();
    expect(lib.HttpAction).toBeDefined();
    expect(lib.PipelineAction).toBeDefined();
    expect(lib.Pipeline).toBeDefined();
    expect(lib.isAgentAction).toBeTypeOf('function');
    expect(lib.Engine).toBeDefined();
    expect(lib.DEFAULT_MAX_EVENT_DEPTH).toBe(10);
    expect(lib.StaticPipelineSource).toBeDefined();
  });

  it('wires end-to-end through the public API only', async () => {
    const agents = new lib.AgentRegistry().register(lib.functionAgent('echo', () => 'ok'));
    const pipeline = new lib.Pipeline({
      id: 'p',
      on: ['a'],
      do: [new lib.AgentAction({ id: 'echo', agentId: 'echo' })],
    });
    const bus = new lib.EventBus();
    const engine = new lib.Engine({
      bus,
      agents,
      pipelines: new lib.StaticPipelineSource([pipeline]),
    });

    const outcome = await engine.dispatch(lib.createEvent('a', {}));

    expect(outcome).toBe('dispatched');
  });
});
