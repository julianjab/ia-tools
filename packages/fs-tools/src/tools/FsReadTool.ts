import { readFile } from 'node:fs/promises';
import { FsTool } from '../FsTool.js';

export interface FsReadInput {
  path: string;
}

const MAX_BYTES = 256 * 1024;

export class FsReadTool extends FsTool<FsReadInput> {
  readonly name = 'fs_read';
  readonly description =
    `Lee el contenido completo de un archivo de texto dentro de ${this.baseDir} (path relativo).`;
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relativo a la raíz del worktree' },
    },
    required: ['path'],
  };

  async handler(input: FsReadInput): Promise<string> {
    const absPath = this.resolveSafePath(input.path);
    const content = await readFile(absPath, 'utf-8');
    if (Buffer.byteLength(content, 'utf-8') > MAX_BYTES) {
      return `${content.slice(0, MAX_BYTES)}\n\n[truncado — el archivo supera ${MAX_BYTES} bytes]`;
    }
    return content;
  }
}
