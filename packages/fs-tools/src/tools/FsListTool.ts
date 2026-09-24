import { readdir } from 'node:fs/promises';
import { FsTool } from '../FsTool.js';

export interface FsListInput {
  path?: string;
}

export class FsListTool extends FsTool<FsListInput> {
  readonly name = 'fs_list';
  readonly description =
    `Lista archivos y carpetas de un directorio dentro de ${this.baseDir} (path relativo, default: la raíz).`;
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relativo, default "."' },
    },
  };

  async handler(input: FsListInput): Promise<string> {
    const absPath = this.resolveSafePath(input.path ?? '.');
    const entries = await readdir(absPath, { withFileTypes: true });
    const listing = entries
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify(listing);
  }
}
