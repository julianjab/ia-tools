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
  /** Env del proceso hijo. Default: un subset mínimo de `process.env` (ver
   *  `DEFAULT_SAFE_ENV_KEYS`) — NUNCA el entorno completo. Pasá esto explícito si el comando
   *  necesita algo puntual del entorno (una API key, un flag de build). */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Lo mínimo para que un binario común (git, node, un linter) arranque sin romperse — nunca
 *  tokens/keys. Heredar `process.env` ENTERO (el default de `child_process.spawn`) le pasaría
 *  al proceso todo lo que el host tenga seteado (GITHUB_TOKEN, ANTHROPIC_API_KEY, credenciales
 *  de Slack, lo que sea) — con un solo intérprete que se cuele por el deny-list (`awk`, `sed`,
 *  uno que no esté en la lista todavía), esos valores quedan a un `ENVIRON`/`getenv` de
 *  distancia. Un caller que necesite algo puntual del entorno lo pasa explícito por `env`. */
const DEFAULT_SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'USER', 'SHELL'];

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value != null) env[key] = value;
  }
  return env;
}

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

    // PATH resuelve el nombre del binario SIN distinguir mayúsculas en macOS/Windows (APFS/NTFS
    // default) — "Bash"/"PYTHON3" encuentran exactamente los mismos binarios que "bash"/
    // "python3". Sin normalizar, toda la policy (patrones + los chequeos dedicados de git) se
    // esquiva con sólo cambiar la capitalización del comando. El resto de los tokens (args) no
    // pasan por una resolución de filesystem, así que sólo `argv[0]` necesita normalizarse.
    const policyArgv = [argv[0].toLowerCase(), ...argv.slice(1)];

    const deniedBy = isDenied(policyArgv, this.options.policy);
    if (deniedBy) {
      throw new Error(
        `bash_run: comando denegado por la policy (matchea "${deniedBy}"): "${input.command}"`,
      );
    }
    if (!isAllowed(policyArgv, this.options.policy)) {
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
        env: this.options.env ?? buildSafeEnv(),
        // Sin esto, stdin queda como un pipe abierto que nadie escribe ni cierra — cualquier
        // comando que lea de stdin (`git commit` sin `-m`, que abre un editor; `cat`/`tee`/`grep`
        // sin archivo; un prompt interactivo) se cuelga hasta `timeoutMs`, y el modelo sólo ve
        // "señal SIGKILL" sin ninguna pista de por qué. `bash_run` no tiene ningún mecanismo para
        // mandarle stdin a un comando, así que no hay razón para dejarlo abierto.
        stdio: ['ignore', 'pipe', 'pipe'],
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
