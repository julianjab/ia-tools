# @ia-tools/github-api

Cliente delgado y autenticado de la REST API de GitHub. Toma cualquier `GithubAuth` de
[`@ia-tools/github-auth`](../auth) (login de usuario o de GitHub App) — no sabe ni le importa
cuál de las dos le diste.

## Instalar (dentro del monorepo)

```bash
pnpm --filter @ia-tools/github-api build
pnpm --filter @ia-tools/github-api test
```

## Uso

```ts
import { GithubTokenAuth } from '@ia-tools/github-auth';
import { GithubClient } from '@ia-tools/github-api';

const client = new GithubClient({ auth: new GithubTokenAuth(process.env.GITHUB_TOKEN!) });

const issue = await client.requestJson('/repos/o/r/issues/1');
// o, para lo que no tiene un 2xx garantizado:
const res = await client.request('/repos/o/r/issues/1');
```

`request` valida que la URL resuelta (relativa o absoluta) caiga dentro de
`https://api.github.com` antes de adjuntar el token — un path armado con datos externos (un
`Link` header manipulado, un valor que vino de un modelo) no puede hacer que el cliente mande el
`Authorization` a otro host.

## Quién lo consume

[`@ia-tools/github-tools`](../tools) — envuelve un `GithubClient` en `Tool[]` para
`@ia-tools/agent-pipeline`. Este paquete no sabe qué es un `Tool` ni un `Agent`.
