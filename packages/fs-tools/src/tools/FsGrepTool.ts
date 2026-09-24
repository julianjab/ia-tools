import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { FsTool } from '../FsTool.js';
import { SKIPPED_DIR_NAMES } from '../shared.js';

export interface FsGrepInput {
  pattern: string;
  path?: string;
}

const MAX_MATCHES = 200;
const MAX_FILES_SCANNED = 5000;

interface Match {
  file: string;
  line: number;
  text: string;
}

async function walk(
  dir: string,
  baseDir: string,
  matches: Match[],
  regex: RegExp,
  budget: { filesScanned: number },
) {
  if (matches.length >= MAX_MATCHES || budget.filesScanned >= MAX_FILES_SCANNED) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= MAX_MATCHES || budget.filesScanned >= MAX_FILES_SCANNED) return;
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      await walk(join(dir, entry.name), baseDir, matches, regex, budget);
      continue;
    }
    budget.filesScanned++;
    const absPath = join(dir, entry.name);
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      continue; // binario u otro error de lectura — se salta, no se aborta el grep entero
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_MATCHES) break;
      if (regex.test(lines[i])) {
        matches.push({ file: relative(baseDir, absPath), line: i + 1, text: lines[i].trim() });
      }
      regex.lastIndex = 0; // regex global reusada entre líneas — sin esto .test() pisa el cursor
    }
  }
}

export class FsGrepTool extends FsTool<FsGrepInput> {
  readonly name = 'fs_grep';
  readonly description =
    `Busca un patrón (regex) en los archivos de texto dentro de ${this.baseDir}, recursivo. Salta node_modules/.git/dist/.turbo/.cache.`;
  readonly inputSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex (sintaxis JS)' },
      path: { type: 'string', description: 'Subdirectorio relativo donde buscar, default "."' },
    },
    required: ['pattern'],
  };

  async handler(input: FsGrepInput): Promise<string> {
    const startDir = this.resolveSafePath(input.path ?? '.');
    const regex = new RegExp(input.pattern, 'g');
    const matches: Match[] = [];
    await walk(startDir, this.resolveSafePath('.'), matches, regex, { filesScanned: 0 });
    return JSON.stringify(matches);
  }
}
