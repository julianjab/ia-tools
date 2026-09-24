# @ia-tools/github-tools

Puente entre `@ia-tools/github` y `@ia-tools/agent-pipeline`. Ver `README.md` para el contrato
de uso; esto es guía específica para trabajar en el código del paquete.

## Por qué este paquete y no uno de los otros dos

`@ia-tools/github` no puede definir `Tool[]` — no depende de `agent-pipeline` (es standalone a
propósito, ver su CLAUDE.md). `agent-pipeline` no puede saber hablar con la REST API de GitHub —
es contrato puro, sin I/O. Este paquete es el único punto que importa los dos: `GithubClient`
(de `github`) + el tipo `Tool` (de `agent-pipeline`).

## Estructura

```
src/
├── GithubTools.ts   la clase — un método por tool + .all()
├── index.ts
└── tests/
```

Package chico, sin subcarpetas por funcionalidad (a diferencia de `@ia-tools/github`) — sólo
hay una funcionalidad: envolver un `GithubClient` en `Tool[]`. Si esto crece (más tools, o
tools que agrupen por dominio — issues vs. PRs vs. releases), ahí sí conviene subdividir.

## Agregar una tool nueva

1. Un método en `GithubTools` que devuelve `Tool<TInput>` — `name`, `description`,
   `inputSchema` (JSON Schema que el modelo va a ver) y `handler` (async, usa
   `this.client.requestJson`/`.request`).
2. Sumalo a `all()`.
3. Un `describe()` en `GithubTools.test.ts` con un `fetchImpl` fake — nunca pega a la red real
   (mismo criterio que `provider-anthropic`/`github`).
4. Si el endpoint devuelve un shape que ya usa otra tool (ej. un issue), reusá
   `GithubIssueApiShape`/`summarizeIssue` en vez de duplicar el parseo.

## Contrato de errores — coincide con `AnthropicProvider`

Un `handler` que tira (`GithubClient.requestJson` ya tira con el status + body en un 4xx/5xx) NO
se atrapa acá — `AnthropicProvider.run` (en `provider-anthropic`) envuelve cada `tool.handler` en
su propio try/catch y lo convierte en un `tool_result` con `is_error: true`. Agregar un
try/catch acá sería redundante y escondería el mensaje de error real detrás de uno genérico.

## Antes de tocar código

```bash
pnpm --filter @ia-tools/github-tools typecheck
pnpm --filter @ia-tools/github-tools test
pnpm --filter @ia-tools/github-tools build
```

`pnpm build` con `dist/` limpio primero (`tsc` no borra outputs huérfanos):
`find dist -type f -delete && find dist -type d -empty -delete`.
