import type { GithubAuth } from '../auth/GithubAuth.js';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

export interface GithubClientOptions {
  auth: GithubAuth;
  fetchImpl?: typeof fetch;
}

/**
 * Cliente delgado de la REST API de GitHub: resuelve el token vía `GithubAuth` (sea
 * `GithubTokenAuth` o `GithubAppAuth`, el cliente no sabe la diferencia) y arma los headers
 * estándar. No sabe nada de `Tool`s ni de agentes — es la pieza que usaría cualquier caller que
 * necesite pegarle a la API con identidad resuelta (`@ia-tools/github-tools`, un script, lo que
 * sea).
 */
export class GithubClient {
  constructor(private readonly options: GithubClientOptions) {}

  /** `path` relativo a `https://api.github.com` (ej. `/repos/o/r/issues/1`) o una URL absoluta
   *  (para seguir un `Link` header de paginación tal cual) — en los dos casos, el resultado
   *  tiene que resolver al host de la API de GitHub. Sin este chequeo, un path armado con datos
   *  de afuera (el modelo, un `Link` header manipulado) podía mandar el `Authorization: Bearer
   *  <token>` a CUALQUIER host. */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.options.auth.getToken();
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = new URL(path, GITHUB_API_URL);
    if (url.origin !== GITHUB_API_URL) {
      throw new Error(`GithubClient: URL fuera de la API de GitHub: "${url}"`);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };
    return fetchImpl(url.toString(), { ...init, headers });
  }

  /** Como `request`, pero ya decodificado y con el 4xx/5xx convertido en excepción — el caso
   *  común de "quiero el JSON o quiero saber por qué no vino". */
  async requestJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GithubClient: GitHub API → ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }
}
