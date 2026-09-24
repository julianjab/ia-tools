import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { FsTool } from '../FsTool.js';
import { SKIPPED_DIR_NAMES } from '../shared.js';

export interface FsGrepInput {
  pattern: string;
  path?: string;
}

const MAX_MATCHES = 200;
const MAX_FILES_SCANNED = 5000;
/** Archivos más grandes se saltan sin leer — ni el ReDoS ni la memoria son manejables si el
 *  input no tiene un tope. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Una línea más larga que esto no se testea contra el regex — el patrón lo manda el modelo,
 *  nunca confiable, y un patrón con backtracking catastrófico (`(a+)+$`) contra una línea larga
 *  bloquea el event loop sin timeout posible (JS no puede preemptar un regex.test() a mitad de
 *  camino). Acotar el largo de la línea acota el peor caso; NO lo elimina para cualquier patrón
 *  — una garantía real pide correr el match en un worker con `terminate()`, fuera de alcance acá. */
const MAX_LINE_LENGTH = 2000;
/** Presupuesto de tiempo total del walk — entre archivos, no puede cortar un regex.test() ya
 *  arrancado, pero evita que muchos archivos "razonables" sumen un tiempo total sin techo. */
const MAX_WALK_MS = 5000;

interface Match {
  file: string;
  line: number;
  text: string;
}

interface WalkBudget {
  filesScanned: number;
  deadline: number;
}

function budgetExhausted(matches: Match[], budget: WalkBudget): boolean {
  return (
    matches.length >= MAX_MATCHES ||
    budget.filesScanned >= MAX_FILES_SCANNED ||
    Date.now() >= budget.deadline
  );
}

async function walk(
  dir: string,
  baseDir: string,
  matches: Match[],
  regex: RegExp,
  budget: WalkBudget,
) {
  if (budgetExhausted(matches, budget)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (budgetExhausted(matches, budget)) return;
    // Un symlink NO es `isDirectory()` (eso mira el link, no el target) — sin este check caería
    // en la rama de archivo de abajo y `readFile` seguiría el link, leyendo lo que sea que
    // apunte, DENTRO o fuera de baseDir. `resolveSafePath` ya audita el path de entrada; el
    // walk recursivo tiene que hacer lo mismo con cada entrada que descubre sola.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      await walk(join(dir, entry.name), baseDir, matches, regex, budget);
      continue;
    }
    budget.filesScanned++;
    const absPath = join(dir, entry.name);
    let content: string;
    try {
      const info = await stat(absPath);
      if (info.size > MAX_FILE_BYTES) continue;
      content = await readFile(absPath, 'utf-8');
    } catch {
      continue; // binario u otro error de lectura — se salta, no se aborta el grep entero
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_MATCHES) break;
      if (lines[i].length > MAX_LINE_LENGTH) continue;
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
    `Busca un patrón (regex) en los archivos de texto dentro de ${this.baseDir}, recursivo. Salta node_modules/.git/dist/.turbo/.cache, archivos >2MB, y líneas >2000 caracteres.`;
  readonly inputSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex (sintaxis JS)' },
      path: { type: 'string', description: 'Subdirectorio relativo donde buscar, default "."' },
    },
    required: ['pattern'],
  };

  async handler(input: FsGrepInput): Promise<string> {
    const startDir = await this.resolveSafePath(input.path ?? '.');
    const regex = new RegExp(input.pattern, 'g');
    const matches: Match[] = [];
    await walk(startDir, await this.resolveSafePath('.'), matches, regex, {
      filesScanned: 0,
      deadline: Date.now() + MAX_WALK_MS,
    });
    return JSON.stringify(matches);
  }
}
