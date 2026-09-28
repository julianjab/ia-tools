import { ExecutionStore } from '@ia-tools/agent-pipeline';
import { SqliteExecutionRepository } from './SqliteExecutionRepository.js';

export interface SqliteExecutionStoreOptions {
  /** Archivo de la base (se crea si no existe), o `:memory:`. */
  path: string;
  /** Cuántas ejecuciones corren a la vez, entre todas las tasks. Default: sin tope. */
  maxConcurrent?: number;
}

/**
 * Un `ExecutionStore` sobre SQLite: al construirse recupera lo que la base dejó vivo — las pausadas
 * vuelven a esperar y las que corrían cuando el proceso murió se cierran `interrupted` (ver
 * `ExecutionStore`).
 */
export class SqliteExecutionStore extends ExecutionStore {
  /** El repositorio de la base, para inspeccionarla (`find`) o cerrarla. */
  readonly database: SqliteExecutionRepository;

  constructor(options: SqliteExecutionStoreOptions) {
    const repository = new SqliteExecutionRepository({ path: options.path });
    super({
      repository,
      ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
    });
    this.database = repository;
  }

  close(): void {
    this.database.close();
  }
}
