import {
  PipelineAction,
  type PipelineActionProps,
  type PipelineExecutionContext,
} from './PipelineAction.js';

export interface HttpActionProps extends PipelineActionProps {
  url: string | ((ctx: PipelineExecutionContext) => string);
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string> | ((ctx: PipelineExecutionContext) => Record<string, string>);
  body?: unknown | ((ctx: PipelineExecutionContext) => unknown);
}

/**
 * `HttpAction.url` resuelve contra el host que le pases, sin sustitución de secretos en la
 * URL — a diferencia de `HttpAction.url` de engine-v2 (que interpola `${SECRETO}` sin
 * allow-list de destino, un riesgo documentado en su README). Acá cualquier secreto va en
 * `headers`/`body` ya resuelto por quien arma el Pipeline, nunca parseado desde un string de
 * config — así no hay superficie para mandar un token a una URL arbitraria por config mal
 * escrita.
 */
export class HttpAction extends PipelineAction {
  readonly url: HttpActionProps['url'];
  readonly method: NonNullable<HttpActionProps['method']>;
  readonly headers?: HttpActionProps['headers'];
  readonly body?: HttpActionProps['body'];

  constructor(props: HttpActionProps) {
    super(props);
    this.url = props.url;
    this.method = props.method ?? 'GET';
    this.headers = props.headers;
    this.body = props.body;
  }

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    const url = typeof this.url === 'function' ? this.url(ctx) : this.url;
    const headers = typeof this.headers === 'function' ? this.headers(ctx) : this.headers;
    const body = typeof this.body === 'function' ? this.body(ctx) : this.body;

    const response = await fetch(url, {
      method: this.method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body != null ? JSON.stringify(body) : undefined,
    });

    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new Error(`HttpAction: ${this.method} ${url} → ${response.status}`);
    }
    return data;
  }
}
