import { Condition } from '../condition/Condition.js';
import type { DomainEvent } from '../events/DomainEvent.js';
import { AgentAction } from './actions/AgentAction.js';
import type { PipelineAction, PipelineExecutionContext } from './actions/PipelineAction.js';

export interface PipelineProps {
  id: string;
  /** Tipos de DomainEvent que este pipeline escucha — al menos uno. */
  on: string[];
  when?: Condition[];
  /**
   * Filtro sobre `event.scope` — cada clave presente acá tiene que matchear EXACTO en el
   * evento (fail-closed, igual que `Pipeline.matchesScope` de engine-v2, pero genérico:
   * cualquier clave de scope, no sólo projectId/repoName). Ausente = sin restricción.
   */
  scope?: Record<string, unknown>;
  enabled?: boolean;
  position?: number;
  /** Si matchea, impide que corran los pipelines de menor prioridad para este evento. */
  exclusive?: boolean;
  do: PipelineAction[];
}

/**
 * Filtra eventos y ejecuta su cadena de `do` en orden, acumulando el output de cada paso
 * nombrado en `ctx.steps` para que los pasos siguientes lo lean.
 */
export class Pipeline {
  readonly id: string;
  readonly on: string[];
  readonly when: Condition[];
  readonly scope?: Record<string, unknown>;
  readonly enabled: boolean;
  readonly position: number;
  readonly exclusive: boolean;
  readonly do: PipelineAction[];

  constructor(props: PipelineProps) {
    this.id = props.id;
    this.on = props.on;
    this.when = props.when ?? [];
    this.scope = props.scope;
    this.enabled = props.enabled ?? true;
    this.position = props.position ?? 0;
    this.exclusive = props.exclusive ?? false;
    this.do = props.do;
  }

  matches(event: DomainEvent): boolean {
    if (!this.enabled) return false;
    if (!this.on.includes(event.type)) return false;
    if (!this.matchesScope(event)) return false;
    return Condition.evaluateAll(this.when, event.payload);
  }

  private matchesScope(event: DomainEvent): boolean {
    if (this.scope == null) return true;
    return Object.entries(this.scope).every(([key, value]) => event.scope?.[key] === value);
  }

  /**
   * Corre `this.do` en orden; cada paso puede leer `ctx.steps` de los anteriores. Un paso
   * saltado (`shouldRun` false) no deja rastro en `ctx.steps`. Un error frena el Pipeline
   * salvo que el paso tenga `continueOnError`.
   */
  async execute(ctx: PipelineExecutionContext): Promise<Record<string, unknown>> {
    const runCtx: PipelineExecutionContext = { ...ctx, pipelineId: this.id };
    for (const step of this.do) {
      if (!step.shouldRun(runCtx)) continue;
      try {
        const out = await step.run(runCtx);
        if (step.id) runCtx.steps[step.id] = out;
      } catch (err) {
        if (!step.continueOnError) throw err;
      }
    }
    return runCtx.steps;
  }
}

/** Type guard útil para quien construye pipelines dinámicamente desde config. */
export function isAgentAction(action: PipelineAction): action is AgentAction {
  return action instanceof AgentAction;
}
