import type { DomainEvent } from '../events/DomainEvent.js';

export interface AgentRunInput {
  // `DomainEvent<any>`: el Agent es quien conoce la forma real del payload de su dominio
  // (GithubIssuePayload, SlackMessagePayload, ...) — el harness no se la impone.
  event: DomainEvent<any>;
  /** Outputs de los pasos anteriores del mismo Pipeline, por su `id`. */
  steps: Record<string, unknown>;
  /** Instrucción específica de ESTE paso (la trae AgentAction, no el Agent). */
  brief?: string;
}

export interface AgentRunOutput<TOutput = unknown> {
  output: TOutput;
  /**
   * Salida nombrada del agente (ej. 'success' | 'error' | 'needs_review') — lo que
   * AgentAction usa para decidir qué evento derivado emitir (`emitOn`). Default 'success'.
   */
  exit?: string;
}

/**
 * La unidad componible del sistema: algo que recibe un input y produce un output.
 * No importa si adentro hay un modelo, una llamada HTTP a un tool o una función pura —
 * Pipeline/AgentAction no lo saben ni les importa. Esto es lo que hace que un Agent
 * "buscar vuelos" y un Agent "triage de issue" convivan en el mismo motor.
 */
export interface Agent<TOutput = unknown> {
  readonly id: string;
  run(input: AgentRunInput): Promise<AgentRunOutput<TOutput>>;
}
