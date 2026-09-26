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
 */
export type ExecutionStatus = 'running' | 'done' | 'failed';

interface Delivered {
  message: string;
  event: DomainEvent<any>;
  read: boolean;
}

export class Execution {
  readonly startedAt = new Date().toISOString();
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
  ) {}

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

  /** Deja un mensaje para la próxima vuelta del agente activo; `event` es el evento que lo trajo,
   *  por si nadie llega a leerlo. */
  deliver(message: string, event: DomainEvent<any>): void {
    this.delivered.push({ message, event, read: false });
  }

  /** Lo que llegó desde la última vez, en orden — y lo marca leído. */
  drain(): string[] {
    const fresh = this.delivered.filter((entry) => !entry.read);
    for (const entry of fresh) entry.read = true;
    return fresh.map((entry) => entry.message);
  }

  /** Los eventos entregados que ningún agente leyó. */
  unread(): DomainEvent<any>[] {
    return this.delivered.filter((entry) => !entry.read).map((entry) => entry.event);
  }

  /** @internal lo llama el store al cerrarla. */
  close(status: Exclude<ExecutionStatus, 'running'>): void {
    this.status = status;
    this.agent = undefined;
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
   *  nunca corre dos a la vez) y a que haya lugar bajo el tope global. */
  start(input: StartExecution): Promise<Execution>;
  finish(execution: Execution, status: Exclude<ExecutionStatus, 'running'>): void;
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

    const execution = new Execution(`exec-${this.nextId++}`, key, pipelineId, agentIds);
    this.byKey.set(key, execution);
    void execution.finished.then(() => {
      if (this.byKey.get(key) === execution) this.byKey.delete(key);
      this.releaseSlot();
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return execution;
  }

  finish(execution: Execution, status: Exclude<ExecutionStatus, 'running'>): void {
    if (execution.status !== 'running') return;
    execution.close(status);
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
