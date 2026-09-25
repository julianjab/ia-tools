import { spawn } from 'node:child_process';
import { SchemaTool } from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import { type BashPolicy, isAllowed, isDenied } from './BashPolicy.js';
import { tokenize } from './tokenize.js';

export const BashRunInput = z.strictObject({
  command: z.string().min(1).describe('Comando + args separados por espacio, ej. "git status"'),
});
export type BashRunInput = z.infer<typeof BashRunInput>;

export interface BashRunToolOptions {
  /** Directorio donde corre el proceso — típicamente el worktree del agente. */
  baseDir: string;
  policy: BashPolicy;
  /** Default 60s. */
  timeoutMs?: number;
  /** Tope de stdout/stderr combinado antes de truncar Y matar el proceso. Default 64KB. */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Acumula chunks de un stream con un tope de BYTES real (no de caracteres — un tope por
 *  caracteres deja pasar de largo con UTF-8 multibyte) y deja de acumular apenas lo alcanza,
 *  en vez de truncar recién al final: sin esto, un comando como `yes` o un `cat` de un archivo
 *  gigante puede llenar la memoria del proceso mucho antes de que `close` llegue. */
class BoundedCollector {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  push(chunk: Buffer, maxBytes: number): void {
    if (this.truncated) return;
    const remaining = maxBytes - this.bytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.bytes += remaining;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  toString(): string {
    const text = Buffer.concat(this.chunks).toString('utf-8');
    return this.truncated ? `${text}\n[truncado — salida supera el tope configurado]` : text;
  }
}

/**
 * Única tool del paquete — a diferencia de `github-tools`/`fs-tools` no hay una jerarquía de
 * clases de dominio que compartir (sólo existe ESTA tool), así que extiende `SchemaTool` directo,
 * sin base intermedia.
 */
export class BashRunTool extends SchemaTool<typeof BashRunInput> {
  readonly name = 'bash_run';
  readonly description: string;
  readonly input = BashRunInput;

  constructor(private readonly options: BashRunToolOptions) {
    super();
    this.description = `Ejecuta un comando SIN shell (sin pipes, redirecciones ni expansión) dentro de ${options.baseDir} — usa comillas para args con espacios.`;
  }

  protected async execute(input: BashRunInput): Promise<string> {
    const argv = tokenize(input.command);
    if (argv.length === 0) {
      throw new Error('bash_run: comando vacío');
    }
    // Sin esto, un path calificado (`/bin/rm`, `./rm`, `bin/curl`) se salta CUALQUIER regla de
    // deny que compare contra el nombre pelado ('rm', 'curl', 'bash') — la policy entera es
    // texto plano contra `argv[0]`, no resuelve símlinks ni PATH. bash_run sólo corre nombres
    // de binario resueltos por PATH, nunca un path explícito.
    if (argv[0].includes('/')) {
      throw new Error(
        `bash_run: el comando no puede incluir un path ("${argv[0]}") — usá el nombre del binario resuelto por PATH`,
      );
    }

    const deniedBy = isDenied(argv, this.options.policy);
    if (deniedBy) {
      throw new Error(
        `bash_run: comando denegado por la policy (matchea "${deniedBy}"): "${input.command}"`,
      );
    }
    if (!isAllowed(argv, this.options.policy)) {
      throw new Error(`bash_run: comando no está en la allowlist: "${input.command}"`);
    }

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    return new Promise<string>((resolve, reject) => {
      // `detached: true` en POSIX hace que el child sea el LÍDER de su propio grupo de
      // procesos — es lo que permite matar el árbol entero (`process.kill(-pid, ...)`), no
      // sólo el proceso directo. Sin esto, un timeout mata a `npm test` pero deja corriendo a
      // los procesos que `npm test` lanzó, que quedan con stdout/stderr abiertos — `close`
      // nunca llega y la Promise queda colgada para siempre.
      const child = spawn(argv[0], argv.slice(1), {
        cwd: this.options.baseDir,
        shell: false,
        detached: process.platform !== 'win32',
      });

      const stdout = new BoundedCollector();
      const stderr = new BoundedCollector();
      let settled = false;

      const killGroup = () => {
        if (child.pid == null) return;
        try {
          if (process.platform === 'win32') {
            child.kill('SIGKILL');
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          // el proceso (o el grupo) ya puede haber terminado solo entre el chequeo y el kill —
          // no es un error real, `close` va a llegar igual.
        }
      };

      const timeoutTimer = setTimeout(killGroup, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk, maxOutputBytes);
        if (stdout.truncated) killGroup();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk, maxOutputBytes);
        if (stderr.truncated) killGroup();
      });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        const status = signal ? `señal ${signal}` : `exit ${code}`;
        resolve(JSON.stringify({ status, stdout: stdout.toString(), stderr: stderr.toString() }));
      });
    });
  }
}
