import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FsTool } from '../FsTool.js';

export interface FsWriteInput {
  path: string;
  content: string;
}

export class FsWriteTool extends FsTool<FsWriteInput> {
  readonly name = 'fs_write';
  readonly description =
    `Escribe (crea o sobreescribe por completo) un archivo dentro de ${this.baseDir} (path relativo).`;
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relativo a la raíz del worktree' },
      content: { type: 'string', description: 'Contenido completo del archivo' },
    },
    required: ['path', 'content'],
  };

  async handler(input: FsWriteInput): Promise<string> {
    const absPath = this.resolveSafePath(input.path);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, input.content, 'utf-8');
    return `Escrito: ${input.path} (${Buffer.byteLength(input.content, 'utf-8')} bytes)`;
  }
}
