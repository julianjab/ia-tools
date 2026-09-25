/**
 * Instrumentación con OpenTelemetry — sólo contra las APIs (`@opentelemetry/api`,
 * `@opentelemetry/api-logs`), nunca contra un SDK: sin un SDK registrado por la app, cada span y
 * cada log es un no-op sin costo. Es el patrón estándar para librerías: la app decide si exporta,
 * a dónde (OTLP → Collector, Grafana, Datadog) y con qué sampling.
 *
 * Todo lo que corre por causa de UN evento cuelga de UNA traza (`Engine.dispatch` abre la raíz),
 * y cada span y log lleva el scope del evento como atributos `ia.<clave>` (`ia.projectId`,
 * `ia.repo`, `ia.issue`, …) — así se filtra por cualquiera en el backend sin que cada paso tenga
 * que acordarse de etiquetar. El scope viaja en el `Context` de OTel (una clave propia, no
 * baggage: el baggage se propaga en los headers HTTP salientes y le mandaría el issue a terceros).
 */
import {
  type AttributeValue,
  type Attributes,
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  context,
  createContextKey,
  trace,
} from '@opentelemetry/api';
import { SeverityNumber, logs } from '@opentelemetry/api-logs';

export const INSTRUMENTATION_SCOPE = '@ia-tools/agent-pipeline';

const tracer = trace.getTracer(INSTRUMENTATION_SCOPE);
const logger = logs.getLogger(INSTRUMENTATION_SCOPE);
const SCOPE_KEY = createContextKey('ia-tools.scope-attributes');

/** Tope de un atributo con contenido libre (inputs, outputs, texto del modelo). */
export const MAX_ATTRIBUTE_LENGTH = 4000;

/** `value` como string acotado — lo que va a un atributo de span o log. */
export function truncate(value: unknown, max = MAX_ATTRIBUTE_LENGTH): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max})` : text;
}

function toAttribute(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return undefined;
}

/** El scope de un evento como atributos `ia.<clave>`. Sólo valores primitivos (o listas de
 *  strings): un objeto anidado no es filtrable en ningún backend. */
export function scopeAttributes(scope: Record<string, unknown> | undefined): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(scope ?? {})) {
    const attribute = toAttribute(value);
    if (attribute !== undefined) attributes[`ia.${key}`] = attribute;
  }
  return attributes;
}

/** Los atributos heredados en el contexto activo — el scope del evento y lo que se sumó abajo
 *  (ej. `ia.pipeline.id`). */
export function inheritedAttributes(ctx: Context = context.active()): Attributes {
  return (ctx.getValue(SCOPE_KEY) as Attributes | undefined) ?? {};
}

/** Corre `fn` con `attributes` sumados a los heredados: todo span y log creado adentro —en este
 *  paquete, en un provider, en una tool— los lleva. */
export function withInheritedAttributes<T>(attributes: Attributes, fn: () => T): T {
  const merged = { ...inheritedAttributes(), ...attributes };
  return context.with(context.active().setValue(SCOPE_KEY, merged), fn);
}

export interface SpanOptions {
  kind?: SpanKind;
  /** Para instrumentar desde otro paquete (un provider) con su propio instrumentation scope. */
  tracer?: Tracer;
}

/**
 * Corre `fn` dentro de un span activo, con los atributos heredados + `attributes`. Si `fn` tira,
 * el span queda en ERROR con la excepción registrada, y el error se re-lanza tal cual.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  const spanTracer = options.tracer ?? tracer;
  return spanTracer.startActiveSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: { ...inheritedAttributes(), ...attributes },
    },
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        markError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** Marca el span como fallido sin cortar el flujo — para errores que alguien maneja (un
 *  `onError`), que igual tienen que verse en la traza. */
export function markError(span: Span, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/** Un log correlacionado con la traza activa (trace_id/span_id los pone el SDK) y con los
 *  atributos heredados — en Loki/Datadog se filtra por `ia.issue` igual que las trazas. */
export function emitLog(level: LogLevel, body: string, attributes: Attributes = {}): void {
  logger.emit({
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body,
    attributes: { ...inheritedAttributes(), ...attributes },
    context: context.active(),
  });
}

export { SpanKind };
