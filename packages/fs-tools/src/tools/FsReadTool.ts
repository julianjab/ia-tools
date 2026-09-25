import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { FsTool } from '../FsTool.js';

export const FsReadInput = z.strictObject({
  path: z.string().describe('Path relativo a la raíz del worktree'),
});
export type FsReadInput = z.infer<typeof FsReadInput>;

const MAX_BYTES = 256 * 1024;

export class FsReadTool extends FsTool<typeof FsReadInput> {
  readonly name = 'fs_read';
  readonly description =
    `Lee el contenido completo de un archivo de texto dentro de ${this.baseDir} (path relativo).`;
  readonly input = FsReadInput;

  protected async execute(input: FsReadInput): Promise<string> {
    const absPath = await this.resolveSafePath(input.path);
    // `readFile` sobre un FIFO (armable con `bash_run "mkfifo p"`) no tira ni devuelve — se
    // queda esperando para siempre a que algo lo abra en escritura. `stat().isFile()` filtra
    // eso (y sockets/devices) ANTES de intentar leer; a diferencia de `readFile`, `stat` nunca
    // bloquea esperando un writer.
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new Error(`fs_read: "${input.path}" no es un archivo regular`);
    }
    const content = await readFile(absPath, 'utf-8');
    if (Buffer.byteLength(content, 'utf-8') > MAX_BYTES) {
      return `${content.slice(0, MAX_BYTES)}\n\n[truncado — el archivo supera ${MAX_BYTES} bytes]`;
    }
    return content;
  }
}
