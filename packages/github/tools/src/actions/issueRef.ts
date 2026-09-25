import type { PipelineExecutionContext } from '@ia-tools/agent-pipeline';

export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

/** De dónde sale el issue sobre el que actúa una acción. Nunca del modelo: una acción de pipeline
 *  actúa sobre el issue del evento, y el modelo no puede redirigirla a otro. */
export type IssueRefResolver = (ctx: PipelineExecutionContext) => IssueRef;

/** De dónde sale el número de PR de la corrida, si hay uno. */
export type PrNumberResolver = (ctx: PipelineExecutionContext) => number | undefined;

function payloadOf(ctx: PipelineExecutionContext): Record<string, unknown> {
  const payload = ctx.event.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

/** Default: los campos de `GithubIssuePayload` (`@ia-tools/github-webhook`) — `owner`, `repo`,
 *  `number` en el payload del evento. */
export const issueFromPayload: IssueRefResolver = (ctx) => {
  const { owner, repo, number } = payloadOf(ctx);
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof number !== 'number') {
    throw new Error(
      'GithubAction: el evento no trae owner/repo/number — pasá un `issue` resolver propio',
    );
  }
  return { owner, repo, number };
};

/** Default: `pr.number` o `prNumber` en el payload del evento. */
export const prFromPayload: PrNumberResolver = (ctx) => {
  const payload = payloadOf(ctx);
  const pr = payload.pr as { number?: unknown } | undefined;
  const candidate = pr?.number ?? payload.prNumber;
  return typeof candidate === 'number' ? candidate : undefined;
};
