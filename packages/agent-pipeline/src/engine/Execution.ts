/**
 * Una ejecución: UNA corrida de una pipeline con agentes sobre UNA task (la `key`, que el `Engine`
 * saca del evento). Es lo que le permite al engine contestar "¿ya hay algo corriendo para esta
 * task?" y, si lo hay, entregarle un evento en vez de arrancar otra corrida (`ifRunning`).
 *
 * El inbox es lo que llega mientras corre: el agente lo vacía antes de cada vuelta del modelo
 * (`ProviderRunContext.inbox`), así que un mensaje entra a la conversación en la vuelta
 * siguiente, sin reiniciar nada.
 */
export type ExecutionStatus = 'running' | 'done' | 'failed';

export class Execution {
  readonly startedAt = new Date().toISOString();
  status: ExecutionStatus = 'running';
  private readonly inbox: string[] = [];
  private settle!: () => void;
  /** Resuelve cuando la ejecución termina, bien o mal — nunca rechaza. */
  readonly finished = new Promise<void>((resolve) => {
    this.settle = resolve;
  });

  constructor(
    readonly id: string,
    readonly key: string,
    readonly pipelineId: string,
    /** La profundidad del evento que la abrió: uno más profundo nació ADENTRO de ella. */
    readonly depth: number,
    /** Los agentes de su pipeline: `inject` sólo le entrega eventos de reglas que comparten uno. */
    readonly agentIds: readonly string[] = [],
  ) {}

  /** Deja un mensaje para la próxima vuelta del agente que está corriendo. */
  deliver(message: string): void {
    this.inbox.push(message);
  }

  /** Lo que llegó desde la última vez, en orden — y lo saca del inbox. */
  drain(): string[] {
    return this.inbox.splice(0);
  }

  /** @internal lo llama el store al cerrarla. */
  close(status: Exclude<ExecutionStatus, 'running'>): void {
    this.status = status;
    this.settle();
  }
}

export interface StartExecution {
  key: string;
  pipelineId: string;
  depth: number;
  agentIds?: readonly string[];
}

/**
 * Dónde viven las ejecuciones. El engine sólo usa esta interfaz: el store en memoria de abajo
 * alcanza para un proceso; uno persistente (pausas, recuperación tras un reinicio) implementa lo
 * mismo.
 */
export interface ExecutionStore {
  /** La que está corriendo para esta task, si hay. */
  running(key: string): Execution | undefined;
  /** Abre una ejecución: espera a que termine la que esté corriendo para la misma task (una
   *  task nunca corre dos a la vez) y a que haya lugar bajo el tope global. */
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

  running(key: string): Execution | undefined {
    return this.byKey.get(key);
  }

  async start({ key, pipelineId, depth, agentIds = [] }: StartExecution): Promise<Execution> {
    this.waitingCount++;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    // La cola de la task: el próximo espera a que ESTA ejecución termine.
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    try {
      await previous;
      await this.acquireSlot();
    } finally {
      this.waitingCount--;
    }

    const execution = new Execution(`exec-${this.nextId++}`, key, pipelineId, depth, agentIds);
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
