import { dirname, isAbsolute, resolve } from 'node:path';
import {
  AnthropicTextClassifier,
  type DomainEvent,
  Engine,
  EventBus,
  type ExecutionStore,
  InMemoryExecutionStore,
  type PipelineSource,
  type TextClassifier,
} from '@ia-tools/agent-pipeline';
import type { YamlCatalogs } from './YamlCatalogs.js';
import { YamlPipelineSource } from './YamlPipelineSource.js';
import { YamlReader } from './YamlReader.js';
import { EngineDoc } from './schema.js';

/** Arma el store de ejecuciones que nombra `executions.driver`. `path` ya viene resuelto. */
export type ExecutionStoreDriver = (options: {
  path?: string;
  maxConcurrent?: number;
}) => ExecutionStore;

export interface CreateEngineFromYamlOptions {
  /** Default: un `EventBus` nuevo. */
  bus?: EventBus;
  catalogs?: YamlCatalogs;
  /** Drivers además de `memory` (ej. `{ sqlite: sqliteStoreDriver }`). */
  drivers?: Record<string, ExecutionStoreDriver>;
  /** Fuentes armadas en código, además de las del YAML (ej. las pipelines que traducen un webhook
   *  a los eventos que escuchan los proyectos). Van primero. */
  sources?: PipelineSource[];
  executionKey?: (event: DomainEvent<any>) => string | undefined;
  formatMessage?: (event: DomainEvent<any>) => string;
  /** Quién evalúa los `whenText`. Default: el de `engine.yaml` (`whenText:`), si lo declara. */
  textClassifier?: TextClassifier;
}

export interface EngineFromYaml {
  engine: Engine;
  bus: EventBus;
  sources: YamlPipelineSource[];
  executions?: ExecutionStore;
  /** Deja de escuchar el bus y de vencer pausas, y cierra el store si tiene cómo. */
  stop(): void;
}

const memoryDriver: ExecutionStoreDriver = ({ maxConcurrent }) =>
  new InMemoryExecutionStore(maxConcurrent !== undefined ? { maxConcurrent } : {});

/**
 * La raíz de composición: lee `engine.yaml`, arma las fuentes (`YamlPipelineSource`), el store que
 * nombra su driver y el `Engine`, lo suscribe al bus y, con `tick.everyMs`, vence las pausas solo.
 * Es el único lugar que conoce las clases concretas.
 *
 * ```yaml
 * maxEventDepth: 10
 * executions: { driver: sqlite, path: ./data/executions.db, maxConcurrent: 4 }
 * sources:
 *   - root: ./projects
 * tick: { everyMs: 60000 }
 * whenText: { model: claude-haiku-4-5 }   # el clasificador de los `whenText`
 * ```
 */
export function createEngineFromYaml(
  path: string,
  options: CreateEngineFromYamlOptions = {},
): EngineFromYaml {
  const doc = new YamlReader().read(path, EngineDoc);
  const base = dirname(resolve(path));
  const at = (relative: string) => (isAbsolute(relative) ? relative : resolve(base, relative));

  const sources = doc.sources.flatMap((entry) =>
    'dir' in entry
      ? [new YamlPipelineSource({ dir: at(entry.dir), ...optional('catalogs', options.catalogs) })]
      : YamlPipelineSource.fromRoot(at(entry.root), options.catalogs),
  );
  if (sources.length === 0) throw new Error(`${path}: sources no tiene ningún proyecto`);

  const executions = doc.executions ? store(path, doc.executions, options.drivers, at) : undefined;
  const bus = options.bus ?? new EventBus();
  const engine = new Engine({
    bus,
    pipelines: [...(options.sources ?? []), ...sources],
    ...optional('maxEventDepth', doc.maxEventDepth),
    ...optional('executions', executions),
    ...optional('executionKey', options.executionKey),
    ...optional('formatMessage', options.formatMessage),
    ...optional('textClassifier', options.textClassifier ?? classifier(doc.whenText)),
  });
  const unsubscribe = engine.start();
  const ticker = doc.tick ? setInterval(() => engine.tick(), doc.tick.everyMs) : undefined;
  ticker?.unref();

  return {
    engine,
    bus,
    sources,
    ...optional('executions', executions),
    stop() {
      unsubscribe();
      if (ticker) clearInterval(ticker);
      (executions as { close?: () => void } | undefined)?.close?.();
    },
  };
}

function store(
  path: string,
  config: NonNullable<EngineDoc['executions']>,
  drivers: Record<string, ExecutionStoreDriver> | undefined,
  at: (relative: string) => string,
): ExecutionStore {
  const available: Record<string, ExecutionStoreDriver> = { memory: memoryDriver, ...drivers };
  const driver = available[config.driver];
  if (!driver) {
    throw new Error(
      `${path}: executions.driver "${config.driver}" no está registrado — hay: ${Object.keys(available).join(', ')}`,
    );
  }
  return driver({
    ...optional(
      'path',
      config.path === undefined || config.path === ':memory:' ? config.path : at(config.path),
    ),
    ...optional('maxConcurrent', config.maxConcurrent),
  });
}

/** El clasificador de `engine.yaml`: la Messages API de Anthropic, con la key de su env var. */
function classifier(config: EngineDoc['whenText']): TextClassifier | undefined {
  if (!config) return undefined;
  const env = config.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
  return new AnthropicTextClassifier({
    apiKey: () => process.env[env],
    ...optional('model', config.model),
  });
}

/** `{ [key]: value }` si `value` está definido; `{}` si no. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
