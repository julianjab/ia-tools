/**
 * Qué deja `Pipeline` en la traza — lo usan los decorators de `Pipeline.ts`, así correr los pasos
 * no mezcla spans con la lógica.
 */
import { Agent, type AgentRunResult } from '../agent/Agent.js';
import {
  type Attributes,
  type TraceOptions,
  emitLog,
  markError,
  truncate,
} from '../telemetry/telemetry.js';
import type { Pipeline, StepRun, StepVia } from './Pipeline.js';
import type { PipelineExecutionContext, Runnable } from './Runnable.js';
import { AllowedAction } from './actions/Action.js';

type StepArgs = [Runnable, unknown, PipelineExecutionContext, StepVia, boolean?];

const stepName = (step: Runnable) => step.id ?? step.constructor.name;
const stepKind = (step: Runnable) => (step instanceof Agent ? 'agent' : 'action');

/** Con qué corre un agente: provider, tools configuradas (sin las `submit_*`) y MCP servers. */
function agentAttributes({ definition: def }: Agent): Attributes {
  return {
    'ia.agent.provider': def.provider,
    'ia.agent.tools': [
      ...(def.tools ?? []).map((tool) => tool.name),
      ...(def.actions ?? []).map(
        (entry) => (entry instanceof AllowedAction ? entry.action : entry).id,
      ),
    ],
    'ia.agent.mcp_servers': (def.mcpServers ?? []).map((server) => server.id),
  };
}

/** `pipeline <id>`: cuelga del evento; todo lo de adentro hereda `ia.pipeline.id`. */
export const pipelineTrace: TraceOptions<
  Pipeline,
  [PipelineExecutionContext],
  Record<string, unknown>
> = {
  name() {
    return `pipeline ${this.id}`;
  },
  inherit() {
    return { 'ia.pipeline.id': this.id };
  },
};

/**
 * `agent <id>` / `action <id>` por cada paso que corre. Los spans y logs de adentro (el request al
 * modelo, una tool, los destinos de la salida elegida) heredan de qué paso —y de qué agente—
 * vienen. Un error cubierto por un `onError` o `continueOnError` igual deja el paso en ERROR.
 */
export const stepTrace: TraceOptions<Pipeline, StepArgs, StepRun> = {
  name: (step) => `${stepKind(step)} ${stepName(step)}`,
  inherit: (step) => ({
    'ia.step.id': stepName(step),
    ...(step instanceof Agent ? { 'ia.agent.id': stepName(step) } : {}),
  }),
  attributes: (step, input, _ctx, via) => ({
    'ia.step.id': stepName(step),
    'ia.step.kind': stepKind(step),
    'ia.step.via': via,
    ...(input === undefined ? {} : { 'ia.step.input': truncate(input) }),
    ...(step instanceof Agent ? agentAttributes(step) : {}),
  }),
  onResult(span, run, step) {
    const name = stepName(step);
    if ('error' in run) {
      markError(span, run.error);
      span.setAttribute('ia.step.error_handled', run.handledBy);
      emitLog('error', `paso "${name}" falló: ${run.error.message}`);
      return;
    }
    if (!(step instanceof Agent)) {
      if (run.output !== undefined) span.setAttribute('ia.step.output', truncate(run.output));
      return;
    }
    const { output } = run.output as AgentRunResult;
    span.setAttributes({
      'ia.agent.outcome': output.outcome,
      ...(output.summary ? { 'ia.agent.summary': truncate(output.summary) } : {}),
    });
    if (!run.exit) {
      emitLog('warn', `agente "${name}" terminó sin salida (${output.outcome})`);
      return;
    }
    const { exit, payload } = run.exit;
    const targets = exit.targets.map(stepName);
    span.setAttributes({ 'ia.agent.exit': exit.name, 'ia.agent.exit_origin': exit.origin });
    span.addEvent('route', {
      'ia.route.exit': exit.name,
      'ia.route.targets': targets,
      ...(exit.report ? { 'ia.route.report': exit.report.id ?? 'report' } : {}),
      'ia.route.payload': truncate(payload),
    });
    emitLog('info', `agente "${name}" eligió "${exit.name}" → ${targets.join(' → ') || 'fin'}`, {
      'ia.agent.exit': exit.name,
    });
  },
};
