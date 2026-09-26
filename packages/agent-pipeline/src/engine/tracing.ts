/**
 * Qué deja `Engine` en la traza — lo usan los decorators de `Engine.ts`, así el despacho no
 * mezcla spans con la lógica.
 */
import {
  SpanKind,
  type SpanLink,
  type TagOptions,
  type TraceOptions,
  scopeAttributes,
} from '@ia-tools/telemetry';
import type { DomainEvent } from '../events/DomainEvent.js';
import type { Candidate, DispatchOutcome, DispatchPlan, Engine, Resolution } from './Engine.js';

/** Instrumentation scope de los spans de este paquete. */
export const SCOPE = '@ia-tools/agent-pipeline';

/**
 * `event <type>`: la raíz de la traza de TODO lo que el evento causa (o un hijo, si lo publicó un
 * paso de otra pipeline). Su scope queda heredado como atributos `ia.<clave>` en cada span y log
 * de abajo.
 */
export const dispatchTrace: TraceOptions<Engine, [DomainEvent<any>], DispatchOutcome> = {
  name: (event) => `event ${event.type}`,
  kind: SpanKind.CONSUMER,
  scope: SCOPE,
  inherit: (event) => ({
    ...scopeAttributes(event.scope),
    'ia.event.type': event.type,
    'ia.event.depth': event.depth,
  }),
  attributes: (event) => ({ 'ia.event.occurred_at': event.occurredAt }),
  onResult(span, outcome, event) {
    span.setAttribute('ia.dispatch.outcome', outcome);
    if (event.depth >= this.maxEventDepth) {
      this.log.warn(
        `evento "${event.type}" descartado: profundidad ${event.depth} ≥ ${this.maxEventDepth}`,
      );
    }
  },
};

/**
 * Qué corre y por qué no corre el resto: un span event `pipeline.match` por cada pipeline que
 * escucha este tipo de evento (las que escuchan otros tipos serían ruido), y un log con el
 * resumen. Es lo primero que se mira cuando "no pasó nada".
 */
export const planTag: TagOptions<Engine, [DomainEvent<any>], DispatchPlan> = {
  onResult(span, plan, event) {
    const skipped: string[] = [];
    const running = new Set(plan.toRun.map(({ pipeline }) => pipeline));
    for (const { pipeline, mismatch } of plan.candidates) {
      if (!pipeline.on.includes(event.type)) continue;
      const runs = running.has(pipeline);
      const reason = runs
        ? undefined
        : (mismatch ?? `la tapa la exclusive "${plan.winningExclusive?.id}"`);
      if (reason) skipped.push(`${pipeline.id} (${reason})`);
      span.addEvent('pipeline.match', {
        'ia.pipeline.id': pipeline.id,
        'ia.pipeline.runs': runs,
        ...(reason ? { 'ia.pipeline.skip_reason': reason } : {}),
      });
    }
    const ran = [...running].map((pipeline) => pipeline.id);
    span.setAttribute('ia.pipelines.run', ran);
    this.log[ran.length > 0 ? 'info' : 'warn'](
      ran.length > 0
        ? `evento "${event.type}": corren ${ran.join(', ')}`
        : `evento "${event.type}": ninguna pipeline corre`,
      { 'ia.pipelines.skipped': skipped },
    );
  },
};

/**
 * Qué pasó con cada pipeline frente a la ejecución de su task — lo que `pipeline.match` no puede
 * decir (se registra al planear, antes de mirar las ejecuciones): un span event
 * `pipeline.if_running` con la decisión (`Resolution`) y la ejecución con la que chocó, más un
 * log cuando no arranca de una. Las que no pasan por ejecuciones no dejan nada.
 */
export const ifRunningTag: TagOptions<Engine, [Candidate, DomainEvent<any>], Resolution> = {
  onResult(span, resolution, { pipeline }, event) {
    const { decision, executionId, agentId, detach } = resolution;
    if (decision === 'direct') return;
    span.addEvent('pipeline.if_running', {
      'ia.pipeline.id': pipeline.id,
      'ia.pipeline.if_running': decision,
      ...(executionId ? { 'ia.execution.id': executionId } : {}),
      ...(agentId ? { 'ia.agent.id': agentId } : {}),
      ...(detach ? { 'ia.execution.detached': true } : {}),
    });
    const on = executionId ? ` (${executionId})` : '';
    const attributes = {
      'ia.pipeline.id': pipeline.id,
      ...(executionId ? { 'ia.execution.id': executionId } : {}),
    };
    if (decision === 'injected') {
      this.log.info(`evento "${event.type}" inyectado a ${agentId}${on}`, attributes);
    } else if (decision === 'skipped') {
      this.log.info(
        `evento "${event.type}" descartado para ${pipeline.id}: la task está ocupada${on}`,
        attributes,
      );
    } else if (decision === 'waits') {
      this.log.info(
        `evento "${event.type}" espera para ${pipeline.id}: la task está ocupada${on}`,
        attributes,
      );
    }
  },
};

/**
 * `event <type>` de un evento inyectado que nadie leyó y se vuelve a despachar al cerrar la
 * ejecución: una traza NUEVA (corre en `inFreshContext`), enlazada al despacho que lo inyectó.
 */
export const redeliverTrace: TraceOptions<
  Engine,
  [DomainEvent<any>, string, string, SpanLink | undefined],
  DispatchOutcome
> = {
  name: (event) => `event ${event.type}`,
  kind: SpanKind.CONSUMER,
  scope: SCOPE,
  inherit: dispatchTrace.inherit as TraceOptions<
    Engine,
    [DomainEvent<any>, string, string, SpanLink | undefined],
    DispatchOutcome
  >['inherit'],
  attributes: (event, pipelineId, executionId) => ({
    'ia.event.occurred_at': event.occurredAt,
    'ia.dispatch.redelivered_from': executionId,
    'ia.dispatch.pipeline': pipelineId,
  }),
  links: (_event, _pipelineId, _executionId, origin) => (origin ? [origin] : []),
  onResult(span, outcome) {
    span.setAttribute('ia.dispatch.outcome', outcome);
  },
};
