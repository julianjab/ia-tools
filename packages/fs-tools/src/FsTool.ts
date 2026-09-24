import type { Tool } from '@ia-tools/agent-pipeline';
import { resolveSafePath } from './shared.js';

/** Base de las 5 fs_* tools — comparte `this.baseDir` y `this.resolveSafePath(...)` (delegado a
 *  la función pura en `shared.ts`, testeada aparte en `shared.test.ts`). Async porque valida
 *  symlinks contra disco (`realpath`) — ver `shared.ts`. */
export abstract class FsTool<TInput = any> implements Tool<TInput> {
  constructor(protected readonly baseDir: string) {}

  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: Record<string, unknown>;
  abstract handler(input: TInput): Promise<string> | string;

  protected resolveSafePath(relativePath: string): Promise<string> {
    return resolveSafePath(this.baseDir, relativePath);
  }
}
