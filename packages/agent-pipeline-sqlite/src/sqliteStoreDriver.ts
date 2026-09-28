import { SqliteExecutionStore } from './SqliteExecutionStore.js';

/**
 * El driver `sqlite` para el `engine.yaml` de `@ia-tools/agent-pipeline-yaml`
 * (`createEngineFromYaml(path, { drivers: { sqlite: sqliteStoreDriver } })`). `path` es obligatorio:
 * sin archivo, las pausas no sobreviven a un reinicio y no hace falta SQLite.
 */
export function sqliteStoreDriver(options: {
  path?: string;
  maxConcurrent?: number;
}): SqliteExecutionStore {
  if (!options.path) {
    throw new Error('executions.path: el driver sqlite necesita el archivo de la base');
  }
  return new SqliteExecutionStore({
    path: options.path,
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
  });
}
