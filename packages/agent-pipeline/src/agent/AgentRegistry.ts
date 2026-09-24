import type { Agent } from './Agent.js';

/**
 * Fuente en vivo de Agents por id — igual criterio que `PipelineSource`: nunca cacheada
 * por el Engine, se consulta en cada dispatch, así que un registry respaldado por DB/YAML
 * puede hidratarse en caliente sin reiniciar nada.
 */
export interface AgentSource {
  get(id: string): Agent | undefined;
}

/** Registry en memoria — alcanza para la mayoría de los casos (agentes definidos en código). */
export class AgentRegistry implements AgentSource {
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): this {
    this.agents.set(agent.id, agent);
    return this;
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }
}
