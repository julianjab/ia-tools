import { createLogger } from '@ia-tools/telemetry';
import type { DomainEvent } from '../events/DomainEvent.js';
import type { IfPaused } from '../pipeline/Pipeline.js';
import { Execution } from './Execution.js';
import { type ExecutionRepository, InMemoryExecutionRepository } from './ExecutionRepository.js';
import { ExecutionScheduler } from './ExecutionScheduler.js';

export interface StartExecution {
  key: string;
  pipelineId: string;
  /** Si la task tiene una ejecución pausada cuando le toca: reemplazarla (default) o esperar a
   *  que termine (`Pipeline.ifPaused`). */
  ifPaused?: IfPaused;
}

export interface ExecutionStoreOptions {
  repository: ExecutionRepository;
  /** Cuántas ejecuciones corren a la vez, entre todas las tasks. Default: sin tope. */
  maxConcurrent?: number;
}

/** Lo que una ejecución interrumpida (el proceso murió mientras corría) había recibido sin leer. */
export interface OrphanedEvents {
  executionId: string;
  events: DomainEvent<any>[];
}

/**
 * Dónde viven las ejecuciones: una por task (serie por `key`), un tope global en paralelo
 * (`ExecutionScheduler`), y qué pasa con una pausa cuando a su task le toca otra corrida
 * (`ifPaused`). Cada ejecución le anota sus cambios al `ExecutionRepository`; con uno persistente,
 * al construirse recupera lo que quedó vivo: las pausadas vuelven a esperar, y las que corrían
 * cuando el proceso murió se cierran `failed` (`interrupted`) y dejan lo que no leyeron en
 * `takeOrphaned()` para que el engine lo re-despache.
 */
export class ExecutionStore {
  readonly log = createLogger('agent-pipeline.execution');
  private readonly repository: ExecutionRepository;
  private readonly scheduler: ExecutionScheduler;
  private readonly byKey = new Map<string, Execution>();
  private orphaned: OrphanedEvents[] = [];

  constructor(options: ExecutionStoreOptions) {
    const max = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
    if (!(max >= 1)) {
      throw new Error(`${this.constructor.name}: maxConcurrent tiene que ser ≥ 1 (llegó ${max})`);
    }
    this.repository = options.repository;
    this.scheduler = new ExecutionScheduler(max);
    this.recover();
  }

  /** La de esta task, corriendo o pausada, si hay. */
  current(key: string): Execution | undefined {
    return this.byKey.get(key);
  }

  /** Si la task tiene una ejecución corriendo O esperando turno — una pausada no la ocupa. Se
   *  marca en el mismo tick del `start`/`resume`, así que no hay ventana en la que una task
   *  ocupada parezca libre. */
  busy(key: string): boolean {
    return this.scheduler.busy(key);
  }

  /**
   * Abre una ejecución: espera a que termine la que esté corriendo para la misma task (una task
   * nunca corre dos a la vez) y a que haya lugar bajo el tope global. Si la task tenía una
   * pausada, la reemplaza (`superseded`) — o, con `ifPaused: 'wait'`, espera a que termine SIN
   * ocupar la task ni un lugar, así la pausa puede despertar o vencer.
   */
  async start({ key, pipelineId, ifPaused = 'supersede' }: StartExecution): Promise<Execution> {
    const queuedAt = Date.now();
    for (;;) {
      const { ready, release } = this.scheduler.enter(key);
      await ready;
      const previous = this.byKey.get(key);
      if (previous?.status === 'paused' && ifPaused === 'wait') {
        // Devuelve la task y el lugar mientras espera: reteniéndolos, la pausa no podría despertar
        // ni vencer (`wake` y `tick` no tocan una task ocupada) y se esperarían entre sí.
        release();
        this.log.info(`${pipelineId} espera a que ${previous.id} termine su pausa`, {
          'ia.execution.id': previous.id,
          'ia.pipeline.id': pipelineId,
        });
        await previous.finished;
        continue;
      }
      // Primero cierra la pausa que reemplaza: una task tiene una sola ejecución viva.
      if (previous?.status === 'paused') previous.close('superseded');
      const execution = Execution.open({
        id: this.repository.nextId(),
        key,
        pipelineId,
        queuedAt,
        journal: this.repository,
      });
      this.admit(execution, release);
      return execution;
    }
  }

  /** Vuelve a admitir una ejecución que despertó (`Execution.wake`): espera su turno en la task
   *  y lugar bajo el tope, igual que `start`. La parte que ocupa la task corre en el mismo tick. */
  async resume(execution: Execution): Promise<void> {
    const { ready, release } = this.scheduler.enter(execution.key);
    await ready;
    this.admit(execution, release);
  }

  /** Las pausadas — para ver cuáles vencieron. */
  paused(): Execution[] {
    return [...this.byKey.values()].filter((execution) => execution.status === 'paused');
  }

  get stats(): { running: number; waiting: number; paused: number } {
    return {
      running: this.scheduler.running,
      waiting: this.scheduler.waiting,
      paused: this.paused().length,
    };
  }

  /** Lo que las ejecuciones interrumpidas por un reinicio recibieron sin leer — y lo consume. */
  takeOrphaned(): OrphanedEvents[] {
    const orphaned = this.orphaned;
    this.orphaned = [];
    return orphaned;
  }

  private recover(): void {
    for (const record of this.repository.live()) {
      if (record.status === 'paused') {
        this.track(Execution.restore(record, this.repository));
        continue;
      }
      // Corría cuando el proceso murió: su agente murió con él.
      const events = this.repository.unread(record.id);
      this.repository.read(record.id);
      this.repository.save({
        ...record,
        status: 'failed',
        closedAt: new Date().toISOString(),
        closeReason: 'interrupted',
      });
      if (events.length > 0) this.orphaned.push({ executionId: record.id, events });
      this.log.warn(`${record.id} se interrumpió con el proceso: queda failed`, {
        'ia.execution.id': record.id,
      });
    }
  }

  private admit(execution: Execution, release: () => void): void {
    this.track(execution);
    execution.admit(release);
  }

  private track(execution: Execution): void {
    this.byKey.set(execution.key, execution);
    void execution.finished.then(() => {
      if (this.byKey.get(execution.key) === execution) this.byKey.delete(execution.key);
    });
  }
}

export interface InMemoryExecutionStoreOptions {
  /** Cuántas ejecuciones corren a la vez, entre todas las tasks. Default: sin tope. */
  maxConcurrent?: number;
}

/** Store en memoria: alcanza para un proceso. Un reinicio pierde todo — también las pausas. */
export class InMemoryExecutionStore extends ExecutionStore {
  constructor(options: InMemoryExecutionStoreOptions = {}) {
    super({ ...options, repository: new InMemoryExecutionRepository() });
  }
}
