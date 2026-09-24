/**
 * Un evento crudo — misma FORMA que `DomainEvent` de `@ia-tools/agent-pipeline` (`type`,
 * `payload`, `scope?`, `occurredAt`, `depth`), pero SIN importar ese paquete: este package no
 * depende de ningún engine. Cualquier consumidor que tipe sus eventos como `DomainEvent<any>`
 * (como hace `agent-pipeline`) acepta este objeto tal cual por matching estructural — no hace
 * falta convertir nada.
 */
export interface GithubWebhookEvent<TPayload = Record<string, unknown>> {
  type: string;
  payload: TPayload;
  scope?: Record<string, unknown>;
  occurredAt: string;
  depth: number;
}

// `type`, no `interface`: una interface sin index signature no es asignable a
// `Record<string, unknown>` (el default de `GithubWebhookEvent['payload']`) sin un cast — un
// type alias sí, estructuralmente, sin que haga falta declarar el índice a mano.
export type GithubIssuePayload = {
  title: string;
  body: string;
  number: number;
  owner: string;
  repo: string;
  labels: string[];
  sender: string;
};

export type GithubIssueCommentPayload = GithubIssuePayload & {
  commentId: number;
  commentBody: string;
};

const ISSUE_ACTION_EVENTS: Record<string, string> = {
  opened: 'github.issue.opened',
  closed: 'github.issue.closed',
  reopened: 'github.issue.reopened',
  labeled: 'github.issue.labeled',
  unlabeled: 'github.issue.unlabeled',
  edited: 'github.issue.edited',
};

const ISSUE_COMMENT_ACTION_EVENTS: Record<string, string> = {
  created: 'github.issue.comment.created',
  edited: 'github.issue.comment.edited',
  deleted: 'github.issue.comment.deleted',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function issueLabels(issue: Record<string, unknown>): string[] {
  const labels = issue.labels;
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => str((label as Record<string, unknown>)?.name));
}

function baseIssuePayload(payload: Record<string, unknown>): GithubIssuePayload {
  const issue = payload.issue as Record<string, unknown>;
  const repository = payload.repository as Record<string, unknown>;
  const owner = repository.owner as Record<string, unknown>;
  const sender = payload.sender as Record<string, unknown> | undefined;
  return {
    title: str(issue.title),
    body: str(issue.body),
    number: num(issue.number),
    owner: str(owner.login),
    repo: str(repository.name),
    labels: issueLabels(issue),
    sender: str(sender?.login),
  };
}

/**
 * Traduce un delivery de webhook de GitHub (`x-github-event` + body ya parseado) a un
 * `GithubWebhookEvent` — nunca verifica firma (eso es `GithubWebhookVerifier`, un paso ANTES) y
 * nunca llama a la API de GitHub (el payload del webhook ya trae todo lo que traduce). `scope`
 * siempre es `{ owner, repo }` — matchea directo contra `Pipeline.scope` de `agent-pipeline`
 * sin que el caller arme nada.
 */
export class GithubWebhookTranslator {
  translate(eventType: string, payload: Record<string, unknown>): GithubWebhookEvent | undefined {
    if (eventType === 'issues') return this.translateIssues(payload);
    if (eventType === 'issue_comment') return this.translateIssueComment(payload);
    return undefined;
  }

  private translateIssues(payload: Record<string, unknown>): GithubWebhookEvent | undefined {
    const action = str(payload.action);
    const type = ISSUE_ACTION_EVENTS[action];
    if (!type) return undefined;
    const issuePayload = baseIssuePayload(payload);
    return {
      type,
      payload: issuePayload,
      scope: { owner: issuePayload.owner, repo: issuePayload.repo },
      occurredAt: new Date().toISOString(),
      depth: 0,
    };
  }

  private translateIssueComment(payload: Record<string, unknown>): GithubWebhookEvent | undefined {
    const action = str(payload.action);
    const type = ISSUE_COMMENT_ACTION_EVENTS[action];
    if (!type) return undefined;
    const comment = payload.comment as Record<string, unknown>;
    const issuePayload = baseIssuePayload(payload);
    const commentPayload: GithubIssueCommentPayload = {
      ...issuePayload,
      commentId: num(comment.id),
      commentBody: str(comment.body),
    };
    return {
      type,
      payload: commentPayload,
      scope: { owner: issuePayload.owner, repo: issuePayload.repo },
      occurredAt: new Date().toISOString(),
      depth: 0,
    };
  }
}
