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
parseGithubIssuePayload         extrae los campos de un payload `issues` — pura, sin decidir type
parseGithubIssueCommentPayload  igual, para `issue_comment`
createGithubWebhookEvent        arma el GithubWebhookEvent alrededor de un `type` que VOS elegiste
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

## Webhook: verificar + parsear — el traductor lo escribe la APP

Este paquete NO decide qué `action` de GitHub importa ni cómo se llama el evento resultante —
esa es la pieza que une `@ia-tools/github` con el engine que la app use (`agent-pipeline` u
otro), y cada app tiene su propio vocabulario de eventos. Lo que el paquete expone son los
primitivos para que la app escriba ese traductor como una función simple, sin reinventar el
parseo del payload de GitHub:

```ts
import {
  createGithubWebhookEvent,
  GithubWebhookVerifier,
  parseGithubIssuePayload,
} from '@ia-tools/github';

const verifier = new GithubWebhookVerifier(process.env.GITHUB_WEBHOOK_SECRET!);

// Esta función es TUYA — mapeá action → type como tus Pipelines lo esperen.
function translate(eventType: string, payload: Record<string, unknown>) {
  if (eventType !== 'issues') return undefined;
  const action = payload.action;
  const type = { opened: 'github.issue.opened', closed: 'github.issue.closed' }[action as string];
  if (!type) return undefined;
  const issue = parseGithubIssuePayload(payload);
  return createGithubWebhookEvent(type, issue, { owner: issue.owner, repo: issue.repo });
}

// `rawBody` tiene que ser el string/Buffer CRUDO del request — la firma es sobre esos bytes.
if (!verifier.verify(rawBody, req.headers['x-hub-signature-256'])) {
  res.writeHead(401).end();
} else {
  const event = translate(req.headers['x-github-event'], JSON.parse(rawBody));
  if (event) await bus.publish(event); // agent-pipeline lo acepta tal cual — mismo shape que DomainEvent
}
```

`parseGithubIssuePayload`/`parseGithubIssueCommentPayload` son puras — extraen `title`, `body`,
`number`, `owner`, `repo`, `labels`, `sender` (y `commentId`/`commentBody` la segunda) del shape
que GitHub manda, sin mirar `action` ni decidir nada. `createGithubWebhookEvent(type, payload,
scope)` completa `occurredAt`/`depth` alrededor del `type` y el `scope: { owner, repo }` que la
app arma. Tu función de traducción devuelve `undefined` cuando el delivery no le importa a tu
app — vos decidís qué hacer con eso (ignorar, 200 vacío).

## Lo que NO hace este paquete

- **No sirve un servidor HTTP** — `GithubWebhookVerifier` y las funciones de parseo son puras;
  montarlas detrás de un `node:http`, Hono, lo que sea, es trabajo del caller (ver
  `examples/apps/chat-web/server.ts` para el patrón que ya usamos en este monorepo).
- **No decide el mapeo `action` → nombre de evento** — es la pieza que une este paquete con el
  engine de la app, y cada app tiene su propio vocabulario. Ver la sección de arriba.
- **No define `Tool`s para un `Agent`** — eso vive en `@ia-tools/github-tools`, que sí depende
  de `@ia-tools/agent-pipeline` (para el tipo `Tool`) y de este paquete (para `GithubAuth`).
- **No escanea issues ni pollea** — sólo reacciona a webhooks ya recibidos. Un scan periódico
  (el equivalente al modo `polling` de ia-flow) es otra pieza, no ésta.
