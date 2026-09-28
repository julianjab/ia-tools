import { Condition, type PipelineExecutionContext } from '@ia-tools/agent-pipeline';
import { z } from 'zod';
import type { StepBuildContext, StepFactory } from '../StepFactory.js';
import { hasTemplate, render, renderText, templateRoot } from '../Template.js';
import { type HttpConnection, lookup } from '../YamlCatalogs.js';
import { CommonStepShape } from '../schema.js';
import { HttpStep } from '../steps/HttpStep.js';

const Node = z.strictObject({
  /** Una URL, o el path en la `connection`. Admite `{{...}}`. */
  http: z.string().min(1),
  /** Una conexión del catálogo (`connections`): su host y su credencial. */
  connection: z.string().min(1).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  /** Se agregan a la URL; uno que resuelve vacío se omite. */
  query: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  /** La query GraphQL: el paso hace `POST { query, variables }` y lee `data`. */
  graphql: z.string().min(1).optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  /** Qué parte de la respuesta es el output del paso (dot path). */
  select: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  ...CommonStepShape,
});
type Node = z.infer<typeof Node>;

/**
 * `{ http: /repos/{{owner}}/{{repo}}/issues/{{number}}, connection: github }`: un request
 * (`HttpStep`) con sus `{{...}}` resueltos al correr, contra el payload y los `steps`. El secreto
 * nunca va en el YAML: sale de la `connection`, que además fija el host — el path que arma una
 * plantilla no lo puede cambiar.
 */
export class HttpStepFactory implements StepFactory<Node> {
  readonly keyword = 'http';
  readonly schema = Node;

  create(node: Node, context: StepBuildContext): HttpStep {
    const connection = node.connection
      ? lookup(context.catalogs.connections, node.connection, 'una conexión')
      : undefined;
    if (!connection && !hasTemplate(node.http)) new URL(node.http);
    const headers = connection?.headers;
    return new HttpStep({
      url: (ctx) => url(node, connection, ctx),
      method: node.graphql ? 'POST' : (node.method ?? 'GET'),
      headers: async (ctx) => ({
        ...(headers ? await headers() : {}),
        ...(node.headers
          ? (render(node.headers, templateRoot(ctx)) as Record<string, string>)
          : {}),
      }),
      ...(node.graphql
        ? {
            body: (ctx: PipelineExecutionContext) => ({
              query: node.graphql,
              variables: render(node.variables ?? {}, templateRoot(ctx)),
            }),
          }
        : node.body !== undefined
          ? { body: (ctx: PipelineExecutionContext) => render(node.body, templateRoot(ctx)) }
          : {}),
      ...(node.timeoutMs ? { timeoutMs: node.timeoutMs } : {}),
      ...(connection?.fetch ? { fetch: connection.fetch } : {}),
      graphql: node.graphql !== undefined,
      ...(node.select ? { select: node.select } : {}),
      id: node.id,
      when: Condition.fromRows(node.when),
      continueOnError: node.continueOnError,
    });
  }
}

function url(node: Node, connection: HttpConnection | undefined, ctx: PipelineExecutionContext) {
  const root = templateRoot(ctx);
  const target = connection
    ? connectionUrl(node.http, connection, root)
    : new URL(String(render(node.http, root)));
  for (const [key, value] of Object.entries(node.query ?? {})) {
    const rendered = render(value, root);
    if (rendered !== undefined && rendered !== null && rendered !== '') {
      target.searchParams.set(key, String(rendered));
    }
  }
  return target.href;
}

/**
 * La URL de un paso con `connection`: su host y el path del YAML. Lo que viene del evento no puede
 * llevar la credencial a otro endpoint: cada valor que se inserta en el path va codificado (no
 * agrega segmentos, ni una query, ni un fragmento), un `.`/`..` se rechaza, y el path final tiene
 * que quedar tal cual se armó — si la URL lo normaliza (un `..`), falla.
 */
function connectionUrl(
  template: string,
  connection: HttpConnection,
  root: Record<string, unknown>,
) {
  const dotSegment = (value: string) => /^(\.|%2e){1,2}$/i.test(value);
  const whole = hasTemplate(template) && /^\{\{[^}]*\}\}$/.test(template.trim());
  const path = whole
    ? String(render(template, root))
    : renderText(template, root, (value) => {
        if (dotSegment(value)) throw new Error(`http: "${value}" no puede ir en un path`);
        return encodeURIComponent(value);
      });
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`http: con \`connection\` va un path que empieza con "/" (llegó "${path}")`);
  }
  if (/[?#]/.test(path) || path.split('/').some(dotSegment)) {
    throw new Error(`http: "${path}" no es un path simple — la query va en \`query\``);
  }
  const base = new URL(connection.baseUrl);
  const expected = `${base.pathname.replace(/\/$/, '')}${path}`;
  const target = new URL(`${base.origin}${expected}`);
  if (target.origin !== base.origin || target.pathname !== expected) {
    throw new Error(`http: "${path}" sale de ${base.origin}${base.pathname}`);
  }
  return target;
}
