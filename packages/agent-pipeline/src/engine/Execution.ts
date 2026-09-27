import { createLogger } from '@ia-tools/telemetry';
import type { DomainEvent } from '../events/DomainEvent.js';

/**
 * Una ejecución: UNA corrida de una pipeline con agentes sobre UNA task (la `key`, que el `Engine`
 * saca del evento). Es lo que le permite al engine contestar "¿ya hay algo corriendo para esta
 * task?" y, si lo hay, entregarle un evento en vez de arrancar otra corrida (`ifRunning`).
 *
 * El inbox es lo que llega mientras un agente está en su loop con el modelo: lo vacía antes de
 * cada vuelta (`ProviderRunContext.inbox`), así que un mensaje entra a la conversación en la vuelta
 * siguiente, sin reiniciar nada. Lo que llegó y ningún agente alcanzó a leer (llegó después de su
 * última vuelta) queda en `unread()`: el engine lo vuelve a despachar al cerrar la ejecución, así
 * que nunca se pierde.
 *
 * Lo que es de UNA ejecución vive acá: su inbox, qué agente lo puede leer, si un evento nació en
 * ella, correr y cerrarse. Lo que es del conjunto (una por task, el tope global) es del store; qué
 * hacer si la task está ocupada lo declara cada regla (`Pipeline.ifRunning`).
 */
export type ExecutionStatus = 'running' | 'done' | 'failed';

interface Delivered {
  message: string;
  event: DomainEvent<any>;
  /** La regla que lo inyectó: si nadie lo lee, se vuelve a despachar SÓLO contra ella. */
  pipelineId: string;
  read: boolean;
}

/** La regla que quiere inyectar un evento: su id y los agentes que la atienden. */
export interface InjectingRule {
  readonly id: string;
  readonly agentIds: readonly string[];
}

/** Un evento entregado que ningún agente leyó, con la regla que lo había inyectado. */
export interface UnreadDelivery {
  event: DomainEvent<any>;
  pipelineId: string;
}

export class Execution {
  readonly log = createLogger('agent-pipeline.execution');
  private readonly startedMs = Date.now();
  readonly startedAt = new Date(this.startedMs).toISOString();
  /** Cuánto esperó turno (su task ocupada) o lugar bajo el tope antes de arrancar. */
  readonly waitedMs: number;
  status: ExecutionStatus = 'running';
  private readonly delivered: Delivered[] = [];
  private agent: string | undefined;
  private settle!: () => void;
  /** Resuelve cuando la ejecución termina, bien o mal — nunca rechaza. */
  readonly finished = new Promise<void>((resolve) => {
    this.settle = resolve;
  });

  constructor(
    readonly id: string,
    readonly key: string,
    readonly pipelineId: string,
    /** Los agentes de su pipeline. */
    readonly agentIds: readonly string[] = [],
    /** Cuándo se pidió (`Date.now()` del `start`); default: ahora, sin espera. */
    queuedAt: number = Date.now(),
  ) {
    this.waitedMs = Math.max(0, this.startedMs - queuedAt);
  }

  /** El agente que está AHORA en su loop con el modelo — el único que puede leer el inbox. Entre
   *  pasos, o antes/después de un agente, no hay ninguno. */
  get activeAgent(): string | undefined {
    return this.agent;
  }

  /** Lo llama el agente al entrar y salir de su loop con el provider. */
  enter(agentId: string): void {
    this.agent = agentId;
  }

  leave(): void {
    this.agent = undefined;
  }

  /** Si `event` nació adentro de esta ejecución (lo emitió un paso suyo): no tiene que esperarla,
   *  sería esperarse a sí misma. */
  owns(event: DomainEvent<any>): boolean {
    return event.executionId === this.id;
  }

  /**
   * Le entrega `message` al agente activo para su próxima vuelta — SÓLO si ese agente es de la
   * regla: entre pasos, o si corre otro agente, no hay quién lo lea y devuelve `false` (la regla
   * espera). `event` y la regla quedan para volver a despacharlo si nadie llega a leerlo.
   */
  inject(message: string, event: DomainEvent<any>, rule: InjectingRule): boolean {
    if (this.status !== 'running' || !this.agent || !rule.agentIds.includes(this.agent)) {
      return false;
    }
    this.delivered.push({ message, event, pipelineId: rule.id, read: false });
    return true;
  }

  /** Lo que llegó desde la última vez, en orden — y lo marca leído. */
  drain(): string[] {
    const fresh = this.delivered.filter((entry) => !entry.read);
    for (const entry of fresh) entry.read = true;
    return fresh.map((entry) => entry.message);
  }

  /** Los eventos entregados que ningún agente leyó. */
  unread(): UnreadDelivery[] {
    return this.delivered
      .filter((entry) => !entry.read)
      .map(({ event, pipelineId }) => ({ event, pipelineId }));
  }

  /** Corre `work` como esta ejecución: queda `done` o `failed` según termine, y se cierra. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.log.info(
      `${this.id} abre: ${this.pipelineId}${this.waitedMs > 0 ? ` (esperó ${this.waitedMs} ms)` : ''}`,
      { 'ia.execution.id': this.id, 'ia.execution.wait_ms': this.waitedMs },
    );
    try {
      const result = await work();
      this.close('done');
      return result;
    } catch (err) {
      this.close('failed');
      throw err;
    }
  }

  /** La cierra (una sola vez): libera su task y su lugar en el store (vía `finished`). */
  close(status: Exclude<ExecutionStatus, 'running'>): void {
    if (this.status !== 'running') return;
    this.status = status;
    this.agent = undefined;
    this.log[status === 'failed' ? 'warn' : 'info'](`${this.id} cierra: ${status}`, {
      'ia.execution.id': this.id,
      'ia.execution.duration_ms': Date.now() - this.startedMs,
    });
    this.settle();
  }
}

export interface StartExecution {
  key: string;
  pipelineId: string;
  agentIds?: readonly string[];
}

/**
 * Dónde viven las ejecuciones. El engine sólo usa esta interfaz: el store en memoria de abajo
 * alcanza para un proceso; uno persistente (pausas, recuperación tras un reinicio) implementa lo
 * mismo.
 */
export interface ExecutionStore {
  /** La que está corriendo para esta task, si hay. */
  current(key: string): Execution | undefined;
  /** Si la task tiene una ejecución corriendo O esperando turno. Se marca en el mismo tick del
   *  `start`, así que no hay ventana en la que una task ocupada parezca libre. */
  busy(key: string): boolean;
  /** Abre una ejecución: espera a que termine la que esté corriendo para la misma task (una task
   *  nunca corre dos a la vez) y a que haya lugar bajo el tope global. La libera cuando la
   *  ejecución se cierra (`Execution.finished`). */
  start(input: StartExecution): Promise<Execution>;
  readonly stats: { running: number; waiting: number };
}

export interface InMemoryExecutionStoreOptions {
  /** Cuántas ejecuciones corren a la vez, entre todas las tasks. Default: sin tope. */
  maxConcurrent?: number;
}

/**
 * Store en memoria: serie por task (una cola por `key`) y un tope global de ejecuciones en
 * paralelo. Un reinicio pierde todo — el mismo límite que tenía la cola de la app a la que
 * reemplaza.
 */
export class InMemoryExecutionStore implements ExecutionStore {
  private readonly byKey = new Map<string, Execution>();
  /** La cola de cada task: la promesa que el próximo `start` de esa `key` tiene que esperar. */
  private readonly tails = new Map<string, Promise<void>>();
  private readonly slotWaiters: Array<() => void> = [];
  private active = 0;
  private waitingCount = 0;
  private nextId = 1;
  private readonly maxConcurrent: number;

  constructor(options: InMemoryExecutionStoreOptions = {}) {
    const max = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
    if (!(max >= 1)) {
      throw new Error(`InMemoryExecutionStore: maxConcurrent tiene que ser ≥ 1 (llegó ${max})`);
    }
    this.maxConcurrent = max;
  }

  current(key: string): Execution | undefined {
    return this.byKey.get(key);
  }

  busy(key: string): boolean {
    return this.tails.has(key);
  }

  async start({ key, pipelineId, agentIds = [] }: StartExecution): Promise<Execution> {
    // Todo lo sincrónico va ANTES del primer await: la task queda ocupada en este mismo tick.
    const queuedAt = Date.now();
    this.waitingCount++;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    try {
      await previous;
      await this.acquireSlot();
    } finally {
      this.waitingCount--;
    }

    const execution = new Execution(`exec-${this.nextId++}`, key, pipelineId, agentIds, queuedAt);
    this.byKey.set(key, execution);
    void execution.finished.then(() => {
      if (this.byKey.get(key) === execution) this.byKey.delete(key);
      this.releaseSlot();
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return execution;
  }

  get stats(): { running: number; waiting: number } {
    return { running: this.active, waiting: this.waitingCount };
  }

  private async acquireSlot(): Promise<void> {
    // El lugar se TRASPASA al que espera sin bajar `active`: si se liberara y el siguiente lo
    // tomara en un microtask, otro podría colarse en el medio y pasar el tope.
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    } else {
      this.active++;
    }
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) next();
    else this.active--;
  }
}
