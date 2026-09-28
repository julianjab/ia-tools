import { createLogger } from '@ia-tools/telemetry';
import type { DomainEvent } from '../events/DomainEvent.js';
import type { Checkpoint } from '../pipeline/Pipeline.js';
import type { Runnable } from '../pipeline/Runnable.js';
import { type Pause, TIMEOUT_BRANCH } from '../pipeline/actions/PauseAction.js';

/**
 * Una ejecución: UNA corrida de una pipeline con agentes sobre UNA task (la `key`, que el `Engine`
 * saca del evento). Es lo que le permite al engine contestar "¿ya hay algo corriendo para esta
 * task?" y, si lo hay, ofrecerle el evento a su paso activo antes de arrancar otra corrida.
 *
 * El inbox es lo que llega mientras un agente está en su loop con el modelo: lo vacía antes de
 * cada vuelta (`ProviderRunContext.inbox`), así que un mensaje entra a la conversación en la vuelta
 * siguiente, sin reiniciar nada. Lo que llegó y ningún agente alcanzó a leer (llegó después de su
 * última vuelta) queda en `takeUnread()`: el engine lo vuelve a despachar al cerrar la ejecución, así
 * que nunca se pierde.
 *
 * Una ejecución también puede PAUSARSE (una `PauseAction` de su pipeline): libera su lugar y su
 * task, guarda por dónde seguir (`Checkpoint`) y espera un evento que la despierte (`wake`) o
 * que venza (`expired`). Si mientras tanto arranca otra corrida de agentes sobre la task, la
 * pausa queda reemplazada (`superseded`): esa corrida lee el estado nuevo.
 *
 * Lo que es de UNA ejecución vive acá: su paso activo, su inbox, si un evento nació en ella,
 * correr, pausarse, despertar y cerrarse. Qué eventos acepta el paso lo decide el paso
 * (`Runnable.accepts`); lo que es del conjunto (una por task, el tope global) es del store; qué
 * hace una regla si la task está ocupada lo declara la regla (`Pipeline.ifRunning`).
 */
export type ExecutionStatus = 'running' | 'paused' | 'done' | 'failed' | 'superseded' | 'expired';
export type ClosedStatus = Exclude<ExecutionStatus, 'running' | 'paused'>;

interface Delivered {
  message: string;
  event: DomainEvent<any>;
  read: boolean;
}

/** Por qué despertó una pausa: la rama y por dónde seguir. */
export interface Wake {
  branch: string;
  checkpoint: Checkpoint;
}

export class Execution {
  readonly log = createLogger('agent-pipeline.execution');
  private readonly startedMs = Date.now();
  readonly startedAt = new Date(this.startedMs).toISOString();
  /** Cuánto esperó turno (su task ocupada) o lugar bajo el tope antes de arrancar. */
  readonly waitedMs: number;
  status: ExecutionStatus = 'running';
  private readonly delivered: Delivered[] = [];
  /** Lo que se le ofreció mientras corría y ningún paso aceptó: si después se pausa, puede ser
   *  justo lo que la pausa espera (un CI que terminó antes de que llegara a pausarse). */
  private missed: DomainEvent<any>[] = [];
  private step: Runnable | undefined;
  private paused: { pause: Pause; checkpoint: Checkpoint } | undefined;
  /** Devuelve su lugar y su task al store — lo pone el store cada vez que se los da. */
  private releaser: (() => void) | undefined;
  private settle!: () => void;
  /** Resuelve cuando la ejecución termina, bien o mal — nunca rechaza. Una pausa no la termina. */
  readonly finished = new Promise<void>((resolve) => {
    this.settle = resolve;
  });

  constructor(
    readonly id: string,
    readonly key: string,
    readonly pipelineId: string,
    /** Cuándo se pidió (`Date.now()` del `start`); default: ahora, sin espera. */
    queuedAt: number = Date.now(),
  ) {
    this.waitedMs = Math.max(0, this.startedMs - queuedAt);
  }

  /** El paso que está AHORA en su loop con el modelo — el único que puede leer el inbox. Entre
   *  pasos, o antes/después de un agente, no hay ninguno. */
  get active(): Runnable | undefined {
    return this.step;
  }

  /** La pausa en la que está, si está pausada. */
  get pausedOn(): Pause | undefined {
    return this.status === 'paused' ? this.paused?.pause : undefined;
  }

  /** Lo llama el agente al entrar y salir de su loop con el provider. */
  enter(step: Runnable): void {
    this.step = step;
  }

  leave(): void {
    this.step = undefined;
  }

  /** Si `event` nació adentro de esta ejecución (lo emitió un paso suyo): no tiene que esperarla,
   *  sería esperarse a sí misma. */
  owns(event: DomainEvent<any>): boolean {
    return event.executionId === this.id;
  }

  /**
   * Le ofrece `event` al paso activo: si lo acepta (`Runnable.accepts`), `message` le llega en su
   * próxima vuelta y devuelve `true`. Si no hay paso activo o no lo acepta, `false` — el evento
   * sigue su camino por las reglas. `event` queda para volver a despacharlo si nadie lo lee.
   */
  inject(message: string, event: DomainEvent<any>): boolean {
    if (this.status !== 'running') return false;
    if (!this.step?.accepts(event)) {
      this.missed.push(event);
      return false;
    }
    this.delivered.push({ message, event, read: false });
    return true;
  }

  /** Si se pausó, el primer evento que llegó mientras corría (sin que ningún paso lo aceptara) y
   *  despierta su pausa. Vacía lo recordado: se toma una sola vez. */
  takeMissedWake(): DomainEvent<any> | undefined {
    const missed = this.missed;
    this.missed = [];
    const pause = this.pausedOn;
    return pause ? missed.find((event) => pause.match(event) !== undefined) : undefined;
  }

  /** Lo que llegó desde la última vez, en orden — y lo marca leído. */
  drain(): string[] {
    const fresh = this.delivered.filter((entry) => !entry.read);
    for (const entry of fresh) entry.read = true;
    return fresh.map((entry) => entry.message);
  }

  /** Los eventos inyectados que ningún agente leyó — y los consume: se toman una sola vez, así
   *  que una ejecución que se pausa y después cierra no los devuelve dos veces. */
  takeUnread(): DomainEvent<any>[] {
    const unread = this.delivered.filter((entry) => !entry.read);
    for (const entry of unread) entry.read = true;
    return unread.map((entry) => entry.event);
  }

  /** Su pipeline se cortó en una pausa: queda `paused` hasta que la despierte un evento o venza.
   *  Devuelve su lugar y su task cuando `run` termina de desarmar la corrida. */
  pause(pause: Pause, checkpoint: Checkpoint): void {
    if (this.status !== 'running') {
      throw new Error(`${this.id}: no se puede pausar una ejecución ${this.status}`);
    }
    this.status = 'paused';
    this.step = undefined;
    this.paused = { pause, checkpoint };
    this.log.info(`${this.id} se pausa en "${pause.pauseId}" (${pause.describe()})`, {
      'ia.execution.id': this.id,
      'ia.pause.id': pause.pauseId,
    });
  }

  /**
   * Si `event` despierta su pausa, vuelve a `running` en el acto (así otro evento no la despierta
   * dos veces) y devuelve la rama y por dónde seguir. Quien la despierta le pide al store que la
   * vuelva a admitir (`ExecutionStore.resume`) antes de correrla.
   */
  wake(event: DomainEvent<any>): Wake | undefined {
    if (this.status !== 'paused' || !this.paused) return undefined;
    const branch = this.paused.pause.match(event);
    return branch ? this.resumeBy(branch) : undefined;
  }

  /** Si su pausa venció (`now` ≥ `expiresAt`). */
  expired(now: number): boolean {
    return this.status === 'paused' && (this.paused?.pause.expired(now) ?? false);
  }

  /** La despierta por la rama `timeout`. Lo llama el engine con una pausa vencida. */
  wakeOnTimeout(): Wake | undefined {
    return this.status === 'paused' && this.paused ? this.resumeBy(TIMEOUT_BRANCH) : undefined;
  }

  private resumeBy(branch: string): Wake {
    const { checkpoint } = this.paused as { checkpoint: Checkpoint };
    this.status = 'running';
    this.paused = undefined;
    this.missed = [];
    this.log.info(`${this.id} se reanuda por "${branch}"`, {
      'ia.execution.id': this.id,
      'ia.pause.branch': branch,
    });
    return { branch, checkpoint };
  }

  /** Corre `work` como esta ejecución: queda `done` o `failed` según termine, y se cierra — o,
   *  si se pausó en el medio, devuelve su lugar y su task sin cerrarse. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.log.info(
      `${this.id} abre: ${this.pipelineId}${this.waitedMs > 0 ? ` (esperó ${this.waitedMs} ms)` : ''}`,
      { 'ia.execution.id': this.id, 'ia.execution.wait_ms': this.waitedMs },
    );
    try {
      const result = await work();
      if (this.status === 'paused') this.release();
      else this.close('done');
      return result;
    } catch (err) {
      this.close('failed');
      throw err;
    }
  }

  /** La cierra (una sola vez): devuelve su task y su lugar al store. */
  close(status: ClosedStatus): void {
    if (this.status !== 'running' && this.status !== 'paused') return;
    this.status = status;
    this.step = undefined;
    this.paused = undefined;
    this.missed = [];
    this.log[status === 'done' ? 'info' : 'warn'](`${this.id} cierra: ${status}`, {
      'ia.execution.id': this.id,
      'ia.execution.duration_ms': Date.now() - this.startedMs,
    });
    this.release();
    this.settle();
  }

  /** @internal lo llama el store cada vez que le da lugar y task: `release` se los devuelve. */
  admit(release: () => void): void {
    this.releaser = release;
  }

  private release(): void {
    const releaser = this.releaser;
    this.releaser = undefined;
    releaser?.();
  }
}

export interface StartExecution {
  key: string;
  pipelineId: string;
}

/**
 * Dónde viven las ejecuciones. El engine sólo usa esta interfaz: el store en memoria de abajo
 * alcanza para un proceso; uno persistente (recuperar pausas tras un reinicio) implementa lo
 * mismo.
 */
export interface ExecutionStore {
  /** La de esta task, corriendo o pausada, si hay. */
  current(key: string): Execution | undefined;
  /** Si la task tiene una ejecución corriendo O esperando turno — una pausada no la ocupa. Se
   *  marca en el mismo tick del `start`/`resume`, así que no hay ventana en la que una task
   *  ocupada parezca libre. */
  busy(key: string): boolean;
  /** Abre una ejecución: espera a que termine la que esté corriendo para la misma task (una task
   *  nunca corre dos a la vez) y a que haya lugar bajo el tope global. Si la task tenía una
   *  pausada, la reemplaza (`superseded`). */
  start(input: StartExecution): Promise<Execution>;
  /** Vuelve a admitir una ejecución que despertó (`Execution.wake`): espera su turno en la task
   *  y lugar bajo el tope, igual que `start`. La parte que ocupa la task corre en el mismo tick. */
  resume(execution: Execution): Promise<void>;
  /** Las pausadas — para ver cuáles vencieron. */
  paused(): Execution[];
  readonly stats: { running: number; waiting: number; paused: number };
}

export interface InMemoryExecutionStoreOptions {
  /** Cuántas ejecuciones corren a la vez, entre todas las tasks. Default: sin tope. */
  maxConcurrent?: number;
}

/**
 * Store en memoria: serie por task (una cola por `key`) y un tope global de ejecuciones en
 * paralelo. Un reinicio pierde todo — también las pausas.
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

  async start({ key, pipelineId }: StartExecution): Promise<Execution> {
    const queuedAt = Date.now();
    const { ready, release } = this.enqueue(key);
    await ready;
    const execution = new Execution(`exec-${this.nextId++}`, key, pipelineId, queuedAt);
    const previous = this.byKey.get(key);
    if (previous?.status === 'paused') previous.close('superseded');
    this.admit(execution, release);
    return execution;
  }

  async resume(execution: Execution): Promise<void> {
    const { ready, release } = this.enqueue(execution.key);
    await ready;
    this.admit(execution, release);
  }

  paused(): Execution[] {
    return [...this.byKey.values()].filter((execution) => execution.status === 'paused');
  }

  get stats(): { running: number; waiting: number; paused: number } {
    return { running: this.active, waiting: this.waitingCount, paused: this.paused().length };
  }

  /**
   * Pide turno en la task y lugar bajo el tope. Todo lo sincrónico va ANTES del primer await: la
   * task queda ocupada en este mismo tick. `release` devuelve las dos cosas.
   */
  private enqueue(key: string): { ready: Promise<void>; release: () => void } {
    this.waitingCount++;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let free!: () => void;
    const mine = new Promise<void>((resolve) => {
      free = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    const ready = (async () => {
      try {
        await previous;
        await this.acquireSlot();
      } finally {
        this.waitingCount--;
      }
    })();
    const release = () => {
      this.releaseSlot();
      free();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
    return { ready, release };
  }

  private admit(execution: Execution, release: () => void): void {
    this.byKey.set(execution.key, execution);
    execution.admit(release);
    void execution.finished.then(() => {
      if (this.byKey.get(execution.key) === execution) this.byKey.delete(execution.key);
    });
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
