/**
 * Qué deja `Engine` en la traza — lo usan los decorators de `Engine.ts`, así el despacho no
 * mezcla spans con la lógica.
 */
import type { DomainEvent } from '../events/DomainEvent.js';
import {
  SpanKind,
  type TagOptions,
  type TraceOptions,
  emitLog,
  scopeAttributes,
} from '../telemetry/telemetry.js';
import type { DispatchOutcome, DispatchPlan, Engine } from './Engine.js';

/**
 * `event <type>`: la raíz de la traza de TODO lo que el evento causa (o un hijo, si lo publicó un
 * paso de otra pipeline). Su scope queda heredado como atributos `ia.<clave>` en cada span y log
 * de abajo.
 */
export const dispatchTrace: TraceOptions<Engine, [DomainEvent<any>], DispatchOutcome> = {
  name: (event) => `event ${event.type}`,
  kind: SpanKind.CONSUMER,
  inherit: (event) => ({
    ...scopeAttributes(event.scope),
    'ia.event.type': event.type,
    'ia.event.depth': event.depth,
  }),
  attributes: (event) => ({ 'ia.event.occurred_at': event.occurredAt }),
  onResult(span, outcome, event) {
    span.setAttribute('ia.dispatch.outcome', outcome);
    if (event.depth >= this.maxEventDepth) {
      emitLog(
        'warn',
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
    emitLog(
      ran.length > 0 ? 'info' : 'warn',
      ran.length > 0
        ? `evento "${event.type}": corren ${ran.join(', ')}`
        : `evento "${event.type}": ninguna pipeline corre`,
      { 'ia.pipelines.skipped': skipped },
    );
  },
};
