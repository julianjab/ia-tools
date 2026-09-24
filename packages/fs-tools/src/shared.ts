import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Directorios que `fs_grep`/`fs_list` recursivos nunca bajan — ruido pesado o binario, nunca
 *  lo que un agente busca en un repo. */
export const SKIPPED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.turbo', '.cache']);

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Sube por los ancestros de `target` hasta encontrar uno que EXISTA de verdad (para un `fs_write`
 * a un archivo nuevo, o a directorios nuevos, `target` mismo — y varios de sus padres — todavía
 * no existen) y valida que, una vez resueltos los symlinks de esa parte real (`realpath`), el
 * path resultante siga DENTRO de `realBase`. Sin esto, un symlink DENTRO de `baseDir` que apunte
 * afuera pasaría el chequeo puramente léxico de `resolveSafePath` — ese chequeo sólo mira el
 * texto del path, nunca a dónde apunta un link real en disco.
 *
 * Devuelve el path FINAL ya resuelto (real ancestro + sufijo lexical de lo que todavía no
 * existe) — `resolveSafePath` opera sobre ESE valor, no sobre el lexical original. Es mitigación,
 * no una garantía TOCTOU-proof: entre este `realpath` y la lectura/escritura real todavía cabe
 * una carrera si otro proceso cambia un directorio del medio por un symlink en el medio — cerrar
 * eso del todo pide abrir con `O_NOFOLLOW` a nivel de file descriptor, fuera de alcance acá.
 */
async function resolveRealPath(
  realBase: string,
  target: string,
  baseDirLexical: string,
  originalInput: string,
): Promise<string> {
  let current = target;
  let suffix = '';
  while (true) {
    try {
      const realCurrent = await realpath(current);
      const finalPath = suffix ? resolve(realCurrent, suffix) : realCurrent;
      const rel = relative(realBase, finalPath);
      if (rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(`fs-tools: path fuera de baseDir (symlink): "${originalInput}"`);
      }
      return finalPath;
    } catch (err) {
      if (!isEnoent(err) || current === baseDirLexical) throw err;
      suffix = suffix ? join(basename(current), suffix) : basename(current);
      current = dirname(current);
    }
  }
}

/**
 * Resuelve `relativePath` contra `baseDir` y garantiza que el resultado sigue DENTRO de
 * `baseDir` — sin esto, `../../etc/passwd` (o un absoluto directo) se escapa del worktree que
 * el caller pensó que estaba conteniendo. Mismo criterio que `issuePath` en
 * `@ia-tools/github-tools`: los inputs de una tool son controlados por el modelo, nunca se
 * confían tal cual.
 *
 * Async (a diferencia de la versión anterior, puramente léxica) porque el chequeo de symlinks
 * necesita tocar disco (`realpath`) — ver `assertNoSymlinkEscape`.
 */
export async function resolveSafePath(baseDir: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath)) {
    throw new Error(`fs-tools: path absoluto no permitido: "${relativePath}"`);
  }
  const resolvedBase = resolve(baseDir);
  const resolved = resolve(resolvedBase, relativePath);
  const rel = relative(resolvedBase, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`fs-tools: path fuera de baseDir: "${relativePath}"`);
  }

  const realBase = await realpath(resolvedBase);
  return resolveRealPath(realBase, resolved, resolvedBase, relativePath);
}
