import type { DomainEvent } from '../events/DomainEvent.js';
import type { ExecutionJournal, ExecutionRecord } from './Execution.js';

/**
 * Dónde viven los datos de las ejecuciones. El `ExecutionStore` coordina (turnos, tope, pausas) y
 * le anota acá cada cambio; un repositorio persistente es lo que deja recuperar las pausas tras un
 * reinicio.
 *
 * Síncrono a propósito: el store marca la task ocupada en el mismo tick del `start`, y una
 * escritura asíncrona abriría una ventana en la que otra corrida la vería libre.
 */
export interface ExecutionRepository extends ExecutionJournal {
  /** Un id que ninguna ejecución guardada tiene. */
  nextId(): string;
  /** Las ejecuciones que quedaron vivas (`running` o `paused`) — para recuperarlas al arrancar. */
  live(): ExecutionRecord[];
  /** Lo que se le entregó a `executionId` y nadie leyó. */
  unread(executionId: string): DomainEvent<any>[];
}

/** Repositorio en memoria: alcanza para un proceso. Un reinicio lo pierde todo. */
export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly inboxes = new Map<string, Array<{ event: DomainEvent<any>; read: boolean }>>();
  private sequence = 1;

  nextId(): string {
    return `exec-${this.sequence++}`;
  }

  save(record: ExecutionRecord): void {
    if (record.status === 'running' || record.status === 'paused') {
      this.records.set(record.id, record);
      return;
    }
    // Una ejecución cerrada ya no se recupera: en memoria no hace falta guardarla.
    this.records.delete(record.id);
    this.inboxes.delete(record.id);
  }

  delivered(executionId: string, event: DomainEvent<any>): void {
    const inbox = this.inboxes.get(executionId) ?? [];
    inbox.push({ event, read: false });
    this.inboxes.set(executionId, inbox);
  }

  read(executionId: string): void {
    for (const entry of this.inboxes.get(executionId) ?? []) entry.read = true;
  }

  live(): ExecutionRecord[] {
    return [...this.records.values()];
  }

  unread(executionId: string): DomainEvent<any>[] {
    return (this.inboxes.get(executionId) ?? [])
      .filter((entry) => !entry.read)
      .map((entry) => entry.event);
  }
}
