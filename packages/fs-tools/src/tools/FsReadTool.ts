import { readFile } from 'node:fs/promises';
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
    const content = await readFile(absPath, 'utf-8');
    if (Buffer.byteLength(content, 'utf-8') > MAX_BYTES) {
      return `${content.slice(0, MAX_BYTES)}\n\n[truncado — el archivo supera ${MAX_BYTES} bytes]`;
    }
    return content;
  }
}
