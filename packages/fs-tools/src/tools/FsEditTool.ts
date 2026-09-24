import { readFile, writeFile } from 'node:fs/promises';
import { FsTool } from '../FsTool.js';

export interface FsEditInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

export class FsEditTool extends FsTool<FsEditInput> {
  readonly name = 'fs_edit';
  readonly description =
    `Reemplaza \`oldString\` por \`newString\` en un archivo dentro de ${this.baseDir} — tira si \`oldString\` no aparece, o aparece más de una vez sin \`replaceAll\`.`;
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relativo a la raíz del worktree' },
      oldString: { type: 'string', description: 'Texto exacto a reemplazar' },
      newString: { type: 'string', description: 'Texto de reemplazo' },
      replaceAll: {
        type: 'boolean',
        description: 'Reemplazar todas las ocurrencias, default false',
      },
    },
    required: ['path', 'oldString', 'newString'],
  };

  async handler(input: FsEditInput): Promise<string> {
    const absPath = this.resolveSafePath(input.path);
    const content = await readFile(absPath, 'utf-8');
    const occurrences = countOccurrences(content, input.oldString);
    if (occurrences === 0) {
      throw new Error(`fs_edit: "${input.oldString}" no aparece en ${input.path}`);
    }
    if (occurrences > 1 && !input.replaceAll) {
      throw new Error(
        `fs_edit: "${input.oldString}" aparece ${occurrences} veces en ${input.path} — agregá más contexto para que sea único, o pasá replaceAll: true`,
      );
    }
    const updated = input.replaceAll
      ? content.split(input.oldString).join(input.newString)
      : content.replace(input.oldString, input.newString);
    await writeFile(absPath, updated, 'utf-8');
    return `Editado: ${input.path} (${occurrences} ocurrencia${occurrences > 1 ? 's' : ''})`;
  }
}
