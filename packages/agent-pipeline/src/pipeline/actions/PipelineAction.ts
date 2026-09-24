import type { AgentSource } from '../../agent/AgentRegistry.js';
import type { Condition } from '../../condition/Condition.js';
import type { DomainEvent } from '../../events/DomainEvent.js';
import type { EventBus } from '../../events/EventBus.js';

export interface PipelineExecutionContext {
  event: DomainEvent<any>;
  /** Outputs acumulados de los pasos anteriores DE ESTE Pipeline, por `id`. */
  steps: Record<string, unknown>;
  bus: EventBus;
  agents: AgentSource;
  pipelineId: string;
}

export interface PipelineActionProps {
  /** Nombre del paso — si se setea, su output queda en `ctx.steps[id]` para pasos siguientes. */
  id?: string;
  when?: Condition[];
  /** Si el paso tira, seguir con el siguiente en vez de abortar el Pipeline. */
  continueOnError?: boolean;
}

/**
 * Base de toda entrada de `Pipeline.do`. Cada paso ve el `PipelineExecutionContext`
 * completo (no sólo el output del paso anterior) — así un paso puede leer
 * `ctx.steps.triage.output` de cualquier paso nombrado antes, no sólo del inmediato anterior.
 */
export abstract class PipelineAction {
  readonly id?: string;
  readonly when: Condition[];
  readonly continueOnError: boolean;

  constructor(props: PipelineActionProps) {
    this.id = props.id;
    this.when = props.when ?? [];
    this.continueOnError = props.continueOnError ?? false;
  }

  shouldRun(ctx: PipelineExecutionContext): boolean {
    if (this.when.length === 0) return true;
    return evaluateWhen(this.when, ctx);
  }

  abstract run(ctx: PipelineExecutionContext): Promise<unknown>;
}

function evaluateWhen(when: Condition[], ctx: PipelineExecutionContext): boolean {
  const subject = { ...ctx.event.payload, steps: ctx.steps };
  let result = when[0].evaluate(subject);
  for (let i = 1; i < when.length; i++) {
    const condition = when[i];
    const value = condition.evaluate(subject);
    result = condition.logic === 'or' ? result || value : result && value;
  }
  return result;
}
