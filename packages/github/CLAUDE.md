# @ia-tools/github

Auth de GitHub + webhooks, standalone. Ver `README.md` para el contrato de uso; esto es guía
específica para trabajar en el código del paquete.

## `webhook/` expone primitivos, no un traductor con opinión

Hubo una versión anterior con una clase `GithubWebhookTranslator` que decidía el mapeo
`action` → nombre de evento (`opened` → `github.issue.opened`, etc.) DENTRO del paquete. Se
sacó a propósito: ese mapeo es la pieza que une `@ia-tools/github` con el engine/vocabulario de
eventos de CADA app — no algo que este paquete pueda decidir de una vez para todos. Lo que queda
acá son los primitivos puros para que la app escriba su propio traductor como una función:
`parseGithubIssuePayload`/`parseGithubIssueCommentPayload` (extraen campos, sin mirar `action`)
y `createGithubWebhookEvent(type, payload, scope)` (arma la forma alrededor del `type` que la
app eligió). Si te piden "agregar un evento nuevo" a este paquete, la respuesta casi siempre es
"eso va en la función traductora de la app, no acá" — salvo que sea un campo del payload de
GitHub que ninguna de las dos funciones de parseo todavía extrae.

## Por qué NO depende de `@ia-tools/agent-pipeline`

A diferencia de `provider-anthropic` (que sí depende de `agent-pipeline`, porque implementa su
`Provider`), este paquete no tiene ninguna razón para importarlo: lo único que "presta" hacia
afuera es un objeto con la forma de `DomainEvent` (`GithubWebhookEvent` — mismos campos: `type`,
`payload`, `scope?`, `occurredAt`, `depth`), y esa forma la declara ACÁ, sin importar el tipo
real. TypeScript lo acepta en cualquier sitio tipado `DomainEvent<any>` por matching
estructural. Si en algún momento `agent-pipeline` cambia la forma de `DomainEvent`, este paquete
NO se entera en tiempo de compilación — es el trade-off consciente de portar la forma en vez del
import (ver la nota de memoria/conversación sobre por qué `provider-anthropic` SÍ importa y este
paquete NO: acá la ganancia de ser 100% standalone —usable por cualquier engine, no sólo el
nuestro— pesa más que la garantía de sincronía en compile-time).

Consecuencia práctica: si tocás `GithubWebhookEvent`, no hay ningún test de este repo que te
avise si dejó de matchear `DomainEvent` de `agent-pipeline` — hacelo a mano (correr
`src/tests/index.test.ts` de `agent-pipeline` con un evento producido acá, o un test de
integración en `examples/`).

## Estructura

```
src/
├── auth/
│   ├── GithubAuth.ts            interfaz { getToken(): Promise<string> }
│   ├── GithubTokenAuth.ts       login de usuario — wrapper trivial de un token ya emitido
│   ├── GithubAppAuth.ts         login de GitHub App — JWT RS256 (node:crypto, sin deps) + cache
│   └── tests/
├── webhook/
│   ├── GithubWebhookVerifier.ts   HMAC-SHA256 timing-safe de x-hub-signature-256
│   ├── GithubWebhookEvent.ts      forma de DomainEvent (sin importarlo) + createGithubWebhookEvent
│   ├── GithubIssuePayload.ts      parseGithubIssuePayload/parseGithubIssueCommentPayload — puras
│   └── tests/
├── api/
│   ├── GithubClient.ts          fetch autenticado — toma cualquier GithubAuth (de auth/)
│   └── tests/
├── index.ts
└── tests/                       sólo index.test.ts — el resto vive en su propia carpeta
```

Carpetas por FUNCIONALIDAD (`auth/`, `webhook/`, `api/`), no un solo `src/` plano — `auth/` no
sabe nada de `webhook/` ni de `api/`; `api/` importa `GithubAuth` de `auth/` (la única arista
entre carpetas); `webhook/` no importa de ninguna de las otras dos. Un archivo nuevo entra en la
carpeta de la funcionalidad que le corresponde, con su propio `tests/` al lado — nunca en la
raíz de `src/` salvo `index.ts`.

## `GithubIssuePayload`/`GithubIssueCommentPayload` son `type`, no `interface`

Con `interface` sin index signature, TypeScript rechaza asignarlo a
`GithubWebhookEvent['payload']` (que resuelve a `Record<string, unknown>` por default de
genérico) con "Index signature for type 'string' is missing" — un quirk conocido: una
`interface` necesita declarar el índice a mano, un `type` alias es asignable a `Record<string,
unknown>` por matching estructural sin más. Si agregás un payload nuevo, declaralo `type`.

## JWT de GitHub App sin dependencias

`GithubAppAuth` arma el JWT (header + claims + firma RS256) a mano con `node:crypto`
(`createSign('RSA-SHA256')` + `Buffer.toString('base64url')`) — no hace falta un paquete tipo
`jsonwebtoken`: es tres líneas y así el paquete entero queda en cero dependencias runtime.
`APP_JWT_TTL_SECONDS = 9 * 60` (el tope de GitHub es 10 min, dejamos margen) y
`CLOCK_SKEW_SECONDS = 60` hacia atrás en `iat` (un reloj local adelantado hace que GitHub
rechace el JWT con "not yet valid").

## Tests

Mismo esquema que `agent-pipeline`/`provider-anthropic`: `src/tests/`, `vitest.config.ts` mira
`src/**/tests/**/*.test.ts`. Nada pega a la red real — `fetchImpl` es siempre inyectable.
`GithubAppAuth.test.ts` genera un keypair RSA real con `node:crypto` (`generateKeyPairSync`) y
verifica la firma del JWT contra la clave pública — no basta con decodificar el JWT, hay que
probar que la firma es válida de verdad.

## Antes de tocar código

```bash
pnpm --filter @ia-tools/github typecheck
pnpm --filter @ia-tools/github test
pnpm --filter @ia-tools/github build
```

`pnpm build` con `dist/` limpio primero (`tsc` no borra outputs huérfanos):
`find dist -type f -delete && find dist -type d -empty -delete`.
