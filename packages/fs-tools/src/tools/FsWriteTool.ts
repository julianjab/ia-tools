import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { FsTool } from '../FsTool.js';

export const FsWriteInput = z.strictObject({
  path: z.string().describe('Path relativo a la raíz del worktree'),
  content: z.string().describe('Contenido completo del archivo'),
});
export type FsWriteInput = z.infer<typeof FsWriteInput>;

export class FsWriteTool extends FsTool<typeof FsWriteInput> {
  readonly name = 'fs_write';
  readonly description =
    `Escribe (crea o sobreescribe por completo) un archivo dentro de ${this.baseDir} (path relativo).`;
  readonly input = FsWriteInput;

  protected async execute(input: FsWriteInput): Promise<string> {
    const absPath = await this.resolveSafePath(input.path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, input.content, 'utf-8');
    return `Escrito: ${input.path} (${Buffer.byteLength(input.content, 'utf-8')} bytes)`;
  }
}
