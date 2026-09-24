# @ia-tools/github

Auth de GitHub (login de usuario **o** de GitHub App, intercambiables) + verificación y
traducción de webhooks a eventos — **standalone**: no depende de `@ia-tools/agent-pipeline` ni
de ningún otro engine. Los eventos que produce tienen la misma FORMA que un `DomainEvent` de
`agent-pipeline` (matching estructural), pero este paquete no lo importa — lo puede usar
cualquier consumidor, sea `agent-pipeline` u otra cosa.

## Instalar (dentro del monorepo)

```bash
pnpm --filter @ia-tools/github build
pnpm --filter @ia-tools/github test
```

Cero dependencias runtime — sólo `node:crypto` y `fetch` globales.

## Las piezas

```
GithubAuth              interfaz — { getToken(): Promise<string> }
GithubTokenAuth          login de USUARIO: envuelve un PAT o un OAuth user token ya emitido
GithubAppAuth            login de GITHUB APP: PEM → JWT (RS256) → installation token, cacheado
GithubClient             fetch autenticado contra la REST API — toma cualquier GithubAuth
GithubWebhookVerifier    HMAC-SHA256 timing-safe de x-hub-signature-256
GithubWebhookTranslator  payload de webhook (ya parseado) → GithubWebhookEvent
```

## Las dos auths son intercambiables

```ts
import { GithubAppAuth, GithubClient, GithubTokenAuth } from '@ia-tools/github';

// Login de usuario — un PAT o un token OAuth ya conseguido por vos.
const userAuth = new GithubTokenAuth(process.env.GITHUB_TOKEN!);

// Login de GitHub App — PEM (contenido, no path: leerlo de disco es tuyo) + appId + installationId.
const appAuth = new GithubAppAuth({
  appId: '4752324',
  installationId: '157297744',
  privateKey: await readFile('/secrets/github-app/private-key.pem', 'utf8'),
});

// GithubClient no sabe (ni le importa) cuál de las dos le diste.
const client = new GithubClient({ auth: userAuth }); // o { auth: appAuth }
const issue = await client.requestJson('/repos/o/r/issues/1');
```

`GithubAppAuth` cachea el installation token (vive ~1h) y lo refresca solo, con margen
configurable (`refreshMarginMs`, default 5 min) — nunca lo vas a ver hacer un exchange de más.

## Webhook: verificar + traducir

```ts
import { GithubWebhookTranslator, GithubWebhookVerifier } from '@ia-tools/github';

const verifier = new GithubWebhookVerifier(process.env.GITHUB_WEBHOOK_SECRET!);
const translator = new GithubWebhookTranslator();

// `rawBody` tiene que ser el string/Buffer CRUDO del request — la firma es sobre esos bytes.
if (!verifier.verify(rawBody, req.headers['x-hub-signature-256'])) {
  res.writeHead(401).end();
} else {
  const event = translator.translate(req.headers['x-github-event'], JSON.parse(rawBody));
  if (event) await bus.publish(event); // agent-pipeline lo acepta tal cual — mismo shape que DomainEvent
}
```

`translate()` devuelve `undefined` cuando el delivery no matchea nada traducible (otro
`x-github-event`, o una `action` que no está mapeada) — el caller decide qué hacer con eso
(ignorar, 200 vacío), el traductor no asume.

### Eventos que traduce hoy

| `x-github-event` | `action` | `type` del evento |
| --- | --- | --- |
| `issues` | `opened` | `github.issue.opened` |
| `issues` | `closed` | `github.issue.closed` |
| `issues` | `reopened` | `github.issue.reopened` |
| `issues` | `labeled` | `github.issue.labeled` |
| `issues` | `unlabeled` | `github.issue.unlabeled` |
| `issues` | `edited` | `github.issue.edited` |
| `issue_comment` | `created` | `github.issue.comment.created` |
| `issue_comment` | `edited` | `github.issue.comment.edited` |
| `issue_comment` | `deleted` | `github.issue.comment.deleted` |

Todos llevan `scope: { owner, repo }` — matchea directo contra `Pipeline.scope` de
`agent-pipeline` sin que el caller arme nada.

## Lo que NO hace este paquete

- **No sirve un servidor HTTP** — `GithubWebhookVerifier`/`Translator` son puros; montarlos
  detrás de un `node:http`, Hono, lo que sea, es trabajo del caller (ver
  `examples/apps/chat-web/server.ts` para el patrón que ya usamos en este monorepo).
- **No define `Tool`s para un `Agent`** — eso vive en `@ia-tools/github-tools`, que sí depende
  de `@ia-tools/agent-pipeline` (para el tipo `Tool`) y de este paquete (para `GithubAuth`).
- **No escanea issues ni pollea** — sólo reacciona a webhooks ya recibidos. Un scan periódico
  (el equivalente al modo `polling` de ia-flow) es otra pieza, no ésta.
