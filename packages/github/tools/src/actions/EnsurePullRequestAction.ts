import { Action, type PipelineExecutionContext } from '@ia-tools/agent-pipeline';
import type { GithubClient } from '@ia-tools/github-api';
import { z } from 'zod';
import { issuePath, repoPath } from '../shared.js';
import {
  type BranchResolver,
  type IssueRef,
  type IssueRefResolver,
  branchFromPayload,
  issueFromPayload,
} from './issueRef.js';

/** Nada que decida el modelo: el issue y la rama salen del evento. */
export const EnsurePullRequestInput = z.strictObject({});
export type EnsurePullRequestInput = z.infer<typeof EnsurePullRequestInput>;

export interface EnsurePullRequestActionOptions {
  client: GithubClient;
  issue?: IssueRefResolver;
  branch?: BranchResolver;
  id?: string;
}

interface PullRequestShape {
  number: number;
  html_url: string;
  body: string | null;
}

/** `Closes #n` y sus sinónimos, también en la forma `owner/repo#n` — lo que GitHub reconoce para
 *  vincular el PR al issue y cerrarlo al mergear. */
export function closesIssue(body: string, issue: IssueRef): boolean {
  const ref = `(?:${escape(issue.owner)}/${escape(issue.repo)})?#${issue.number}`;
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+${ref}\\b`, 'i').test(body);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Garantiza que la rama de la task tenga un PR abierto contra la default branch, y que ese PR
 * cierre el issue (`Closes #n`). El modelo sigue escribiendo el PR — título y descripción son
 * suyos —, esto cubre lo que no puede depender de él: que el PR exista y quede vinculado al issue.
 *
 * - Sin PR: lo abre, con el título del issue y `Closes #n` de cuerpo. Si la rama no está en el
 *   remoto tira: sin nada publicado no hay PR posible, y la corrida no debería seguir de largo.
 * - Con PR sin `Closes #n`: se lo agrega al final del body, sin tocar lo demás.
 * - Con PR que ya lo cierra: no hace nada.
 */
export class EnsurePullRequestAction extends Action<typeof EnsurePullRequestInput> {
  readonly description =
    'Asegura un PR abierto desde la rama de la task que cierre el issue (Closes #n).';
  readonly input = EnsurePullRequestInput;
  private readonly client: GithubClient;
  private readonly resolveIssue: IssueRefResolver;
  private readonly resolveBranch: BranchResolver;

  constructor(options: EnsurePullRequestActionOptions) {
    super({ id: options.id ?? 'ensure_pull_request' });
    this.client = options.client;
    this.resolveIssue = options.issue ?? issueFromPayload;
    this.resolveBranch = options.branch ?? branchFromPayload;
  }

  async execute(_input: EnsurePullRequestInput, ctx: PipelineExecutionContext): Promise<string> {
    const issue = this.resolveIssue(ctx);
    const branch = this.resolveBranch(ctx);
    const repo = (suffix = '') => repoPath(issue.owner, issue.repo, suffix);
    const closing = `Closes #${issue.number}`;

    const head = encodeURIComponent(`${issue.owner}:${branch}`);
    const open = await this.client.requestJson<PullRequestShape[]>(
      repo(`/pulls?state=open&head=${head}`),
    );
    const existing = open[0];

    if (existing) {
      const body = existing.body ?? '';
      if (closesIssue(body, issue))
        return `PR #${existing.number} ya cierra #${issue.number}: ${existing.html_url}`;
      await this.client.requestJson(repo(`/pulls/${existing.number}`), {
        method: 'PATCH',
        body: JSON.stringify({ body: body.trim() ? `${body.trimEnd()}\n\n${closing}` : closing }),
      });
      return `PR #${existing.number}: agregado "${closing}" — ${existing.html_url}`;
    }

    const branchRes = await this.client.request(repo(`/branches/${encodeURIComponent(branch)}`));
    if (branchRes.status === 404) {
      throw new Error(
        `ensure_pull_request: la rama ${branch} no está en ${issue.owner}/${issue.repo} — no se publicó nada, no hay PR que abrir`,
      );
    }
    if (!branchRes.ok) {
      throw new Error(
        `ensure_pull_request: no se pudo leer la rama ${branch} → ${branchRes.status}`,
      );
    }

    const [repository, issueData] = await Promise.all([
      this.client.requestJson<{ default_branch: string }>(repo()),
      this.client.requestJson<{ title: string }>(issuePath(issue.owner, issue.repo, issue.number)),
    ]);
    const created = await this.client.requestJson<PullRequestShape>(repo('/pulls'), {
      method: 'POST',
      body: JSON.stringify({
        title: issueData.title,
        head: branch,
        base: repository.default_branch,
        body: closing,
      }),
    });
    return `PR #${created.number} abierto desde ${branch}: ${created.html_url}`;
  }
}
