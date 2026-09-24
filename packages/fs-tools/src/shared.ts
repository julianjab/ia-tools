import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Directorios que `fs_grep`/`fs_list` recursivos nunca bajan — ruido pesado o binario, nunca
 *  lo que un agente busca en un repo. */
export const SKIPPED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.turbo', '.cache']);

/**
 * Resuelve `relativePath` contra `baseDir` y garantiza que el resultado sigue DENTRO de
 * `baseDir` — sin esto, `../../etc/passwd` (o un absoluto directo) se escapa del worktree que
 * el caller pensó que estaba conteniendo. Mismo criterio que `issuePath` en
 * `@ia-tools/github-tools`: los inputs de una tool son controlados por el modelo, nunca se
 * confían tal cual.
 */
export function resolveSafePath(baseDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`fs-tools: path absoluto no permitido: "${relativePath}"`);
  }
  const resolvedBase = resolve(baseDir);
  const resolved = resolve(resolvedBase, relativePath);
  const rel = relative(resolvedBase, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`fs-tools: path fuera de baseDir: "${relativePath}"`);
  }
  return resolved;
}
