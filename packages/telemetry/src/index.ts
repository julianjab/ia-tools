export type { ConsoleSinkOptions, LogLevel, LogRecord, LogSink, Logger } from './logging.js';
export { addLogSink, consoleSink, createLogger, otelSink, setLogSinks } from './logging.js';
export type { Attributes, Span, SpanOptions, TagOptions, TraceOptions } from './tracing.js';
export {
  INSTRUMENTATION_SCOPE,
  MAX_ATTRIBUTE_LENGTH,
  SpanKind,
  inheritedAttributes,
  markError,
  scopeAttributes,
  tagged,
  traced,
  truncate,
  withInheritedAttributes,
  withSpan,
} from './tracing.js';
