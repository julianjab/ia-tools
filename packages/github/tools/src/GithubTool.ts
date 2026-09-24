import type { Tool } from '@ia-tools/agent-pipeline';
import type { GithubClient } from '@ia-tools/github-api';
import { type GithubIssueApiShape, issuePath, summarizeIssue } from './shared.js';

/**
 * Base de las 4 tools de GitHub — la herencia acá es sólo para lo COMPARTIDO entre ellas
 * (`this.client`, `this.issuePath(...)`, `this.summarizeIssue(...)`); `issuePath`/
 * `summarizeIssue` siguen viviendo como funciones puras en `shared.ts` (ahí las prueba
 * `shared.test.ts` directo, sin instanciar ninguna tool) — esta clase sólo las expone como
 * métodos protegidos para que una subclase no tenga que importarlas aparte.
 */
export abstract class GithubTool<TInput = any> implements Tool<TInput> {
  constructor(protected readonly client: GithubClient) {}

  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: Record<string, unknown>;
  abstract handler(input: TInput): Promise<string> | string;

  protected issuePath(owner: string, repo: string, number: number, suffix = ''): string {
    return issuePath(owner, repo, number, suffix);
  }

  protected summarizeIssue(issue: GithubIssueApiShape): string {
    return summarizeIssue(issue);
  }
}
