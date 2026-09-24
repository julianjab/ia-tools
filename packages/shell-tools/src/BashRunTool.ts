import { spawn } from 'node:child_process';
import type { Tool } from '@ia-tools/agent-pipeline';
import { type BashPolicy, isAllowed, isDenied } from './BashPolicy.js';
import { tokenize } from './tokenize.js';

export interface BashRunInput {
  command: string;
}

export interface BashRunToolOptions {
  /** Directorio donde corre el proceso — típicamente el worktree del agente. */
  baseDir: string;
  policy: BashPolicy;
  /** Default 60s. */
  timeoutMs?: number;
  /** Tope de stdout/stderr combinado antes de truncar. Default 64KB. */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n[truncado — salida supera ${maxBytes} bytes]`;
}

/**
 * Única tool del paquete — a diferencia de `github-tools`/`fs-tools` no hay una jerarquía de
 * clases que compartir (sólo existe ESTA tool), así que implementa `Tool` directo, sin base
 * abstracta de por medio.
 */
export class BashRunTool implements Tool<BashRunInput> {
  readonly name = 'bash_run';
  readonly description: string;
  readonly inputSchema = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Comando + args separados por espacio, ej. "git status"',
      },
    },
    required: ['command'],
  };

  constructor(private readonly options: BashRunToolOptions) {
    this.description = `Ejecuta un comando SIN shell (sin pipes, redirecciones ni expansión) dentro de ${options.baseDir} — usa comillas para args con espacios.`;
  }

  async handler(input: BashRunInput): Promise<string> {
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
      const child = spawn(argv[0], argv.slice(1), {
        cwd: this.options.baseDir,
        shell: false,
        timeout: timeoutMs,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf-8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code, signal) => {
        const status = signal ? `señal ${signal}` : `exit ${code}`;
        resolve(
          JSON.stringify({
            status,
            stdout: truncate(stdout, maxOutputBytes),
            stderr: truncate(stderr, maxOutputBytes),
          }),
        );
      });
    });
  }
}
