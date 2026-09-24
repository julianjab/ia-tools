import {
  PipelineAction,
  type PipelineActionProps,
  type PipelineExecutionContext,
} from './PipelineAction.js';

const BODYLESS_METHODS = new Set(['GET', 'DELETE']);

export interface HttpActionProps extends PipelineActionProps {
  url: string | ((ctx: PipelineExecutionContext) => string);
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string> | ((ctx: PipelineExecutionContext) => Record<string, string>);
  body?: unknown | ((ctx: PipelineExecutionContext) => unknown);
  /** Corta la request si no responde a tiempo — un host colgado, si no, bloquea el Pipeline
   *  para siempre. Default 30s. */
  timeoutMs?: number;
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
  readonly timeoutMs: number;

  constructor(props: HttpActionProps) {
    super(props);
    this.url = props.url;
    this.method = props.method ?? 'GET';
    this.headers = props.headers;
    this.body = props.body;
    this.timeoutMs = props.timeoutMs ?? 30_000;
  }

  async run(ctx: PipelineExecutionContext): Promise<unknown> {
    const url = typeof this.url === 'function' ? this.url(ctx) : this.url;
    const headers = typeof this.headers === 'function' ? this.headers(ctx) : this.headers;
    const body = typeof this.body === 'function' ? this.body(ctx) : this.body;

    // `fetch` tira TypeError si un método sin cuerpo (GET/DELETE) lleva `body` — así que acá
    // se omite en vez de dejar que el `body` de la config rompa la request entera.
    const requestBody =
      body != null && !BODYLESS_METHODS.has(this.method) ? JSON.stringify(body) : undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let contentType: string;
    let raw: string;
    try {
      // El `finally` de abajo tiene que envolver TAMBIÉN `response.text()`, no sólo el
      // `fetch` — el `AbortController` recién frena la conexión mientras está activo, y
      // `fetch` resuelve en cuanto llegan los headers. Un servidor que manda los headers
      // rápido pero el body nunca (o muy lento) dejaba la lectura del body sin ningún límite
      // de tiempo si el timeout se cancelaba antes, justo lo que `timeoutMs` dice que evita.
      const response = await fetch(url, {
        method: this.method,
        headers: { 'content-type': 'application/json', ...headers },
        body: requestBody,
        signal: controller.signal,
      });
      contentType = response.headers.get('content-type') ?? '';
      // Se lee SIEMPRE como texto primero, nunca `response.json()` directo: un 5xx con
      // `content-type: application/json` pero body vacío o HTML (un proxy, un balanceador)
      // tira un SyntaxError que tapa el status real detrás de un error de parseo confuso. Leer
      // texto primero también cubre un 204 (body vacío) sin que `JSON.parse('')` explote.
      raw = await response.text();
      if (!response.ok) {
        const snippet = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
        throw new Error(
          `HttpAction: ${this.method} ${url} → ${response.status}${snippet ? `: ${snippet}` : ''}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }

    if (raw === '') return undefined;
    return contentType.includes('application/json') ? JSON.parse(raw) : raw;
  }
}
