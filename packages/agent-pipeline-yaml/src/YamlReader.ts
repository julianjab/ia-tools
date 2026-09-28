import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/** Lee un archivo YAML y lo valida contra su schema; los errores dicen qué archivo y qué campo.
 *  `transform` corre sobre el documento crudo, ANTES de validar (ej. sustituir las `vars`). */
export class YamlReader {
  read<T>(path: string, schema: z.ZodType<T>, transform?: (raw: unknown) => unknown): T {
    let raw: unknown;
    try {
      raw = parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`${path}: no es YAML válido (${(error as Error).message})`);
    }
    const parsed = schema.safeParse((transform ? transform(raw ?? {}) : raw) ?? {});
    if (!parsed.success) throw new Error(`${path}: inválido\n${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }
}
