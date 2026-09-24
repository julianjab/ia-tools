import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../../../src/agent/AgentRegistry.js';
import { functionAgent } from '../../../src/agent/FunctionAgent.js';
import { createEvent } from '../../../src/events/DomainEvent.js';
import { EventBus } from '../../../src/events/EventBus.js';
import { AgentAction } from '../../../src/pipeline/actions/AgentAction.js';
import type { PipelineExecutionContext } from '../../../src/pipeline/actions/PipelineAction.js';

function makeCtx(agents: AgentRegistry, bus = new EventBus()): PipelineExecutionContext {
  return { event: createEvent('t', { a: 1 }), steps: {}, bus, agents, pipelineId: 'p1' };
}

describe('AgentAction', () => {
  it('runs the referenced agent and returns its AgentRunOutput', async () => {
    const agents = new AgentRegistry().register(functionAgent('fix', () => 'patched'));
    const action = new AgentAction({ agentId: 'fix' });

    const result = await action.run(makeCtx(agents));

    expect(result).toEqual({ output: 'patched', exit: 'success' });
  });

  it('throws when the agentId is not registered', async () => {
    const action = new AgentAction({ agentId: 'missing' });
    await expect(action.run(makeCtx(new AgentRegistry()))).rejects.toThrow(/no hay ningún Agent/);
  });

  it('passes a static brief to the agent', async () => {
    let receivedBrief: string | undefined;
    const agents = new AgentRegistry().register(
      functionAgent('a', (input) => {
        receivedBrief = input.brief;
        return 'ok';
      }),
    );
    await new AgentAction({ agentId: 'a', brief: 'fixed brief' }).run(makeCtx(agents));
    expect(receivedBrief).toBe('fixed brief');
  });

  it('resolves a brief function against the execution context', async () => {
    let receivedBrief: string | undefined;
    const agents = new AgentRegistry().register(
      functionAgent('a', (input) => {
        receivedBrief = input.brief;
        return 'ok';
      }),
    );
    const ctx = makeCtx(agents);
    ctx.steps.triage = { output: { label: 'bug' } };
    await new AgentAction({
      agentId: 'a',
      brief: (c) => `label: ${(c.steps.triage as { output: { label: string } }).output.label}`,
    }).run(ctx);
    expect(receivedBrief).toBe('label: bug');
  });

  it('does not emit a derived event when emitOn is not set', async () => {
    const agents = new AgentRegistry().register(functionAgent('a', () => 'ok'));
    const bus = new EventBus();
    const publishSpy = vi.spyOn(bus, 'publish');
    await new AgentAction({ agentId: 'a' }).run(makeCtx(agents, bus));
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('emits a derived event named by emitOn(exit), merging object output with agentId', async () => {
    const agents = new AgentRegistry().register(
      functionAgent('a', () => ({ output: { label: 'bug' }, exit: 'triaged' })),
    );
    const bus = new EventBus();
    const publishSpy = vi.spyOn(bus, 'publish');
    const ctx = makeCtx(agents, bus);

    await new AgentAction({ agentId: 'a', emitOn: (exit) => `agent.${exit}` }).run(ctx);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const derived = publishSpy.mock.calls[0][0];
    expect(derived.type).toBe('agent.triaged');
    expect(derived.payload).toEqual({ label: 'bug', agentId: 'a' });
    expect(derived.depth).toBe(ctx.event.depth + 1);
  });

  it('wraps a non-object output under { output } before deriving the event', async () => {
    const agents = new AgentRegistry().register(functionAgent('a', () => 'plain-string'));
    const bus = new EventBus();
    const publishSpy = vi.spyOn(bus, 'publish');

    await new AgentAction({ agentId: 'a', emitOn: () => 'derived' }).run(makeCtx(agents, bus));

    expect(publishSpy.mock.calls[0][0].payload).toEqual({ output: 'plain-string', agentId: 'a' });
  });

  it('emitOn returning undefined skips publishing', async () => {
    const agents = new AgentRegistry().register(functionAgent('a', () => 'ok'));
    const bus = new EventBus();
    const publishSpy = vi.spyOn(bus, 'publish');

    await new AgentAction({ agentId: 'a', emitOn: () => undefined }).run(makeCtx(agents, bus));

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('defaults exit to "success" when resolving emitOn', async () => {
    const agents = new AgentRegistry().register(functionAgent('a', () => ({ output: 'x' })));
    const bus = new EventBus();
    const seen: string[] = [];
    await new AgentAction({
      agentId: 'a',
      emitOn: (exit) => {
        seen.push(exit);
        return undefined;
      },
    }).run(makeCtx(agents, bus));
    expect(seen).toEqual(['success']);
  });
});
