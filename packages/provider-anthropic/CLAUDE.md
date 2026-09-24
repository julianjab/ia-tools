# @ia-tools/provider-anthropic

`Provider` de Anthropic para `@ia-tools/agent-pipeline`, portado de
`ia-flow/packages/ai-providers/src/anthropic-api`. Ver `README.md` para el contrato de uso;
esto es guía específica para trabajar en el código del paquete.

## Qué es este paquete

Es infra CONCRETA (a diferencia de `agent-pipeline`, que es contrato puro): hace `fetch` real
contra `https://api.anthropic.com`, lee `process.env`, maneja retries de red. Depende de
`@ia-tools/agent-pipeline` (implementa su `Provider`), nunca al revés — si algún día hiciera
falta que `agent-pipeline` supiera algo de este paquete, es señal de que ese algo pertenece en
`agent-pipeline/src/` como contrato, no acá.

## Estructura

```
src/
├── AnthropicClient.ts   clase AnthropicClient — auth + headers + retry + streaming.
│                         Reusable sola, sin saber nada de tools/agentes.
├── AnthropicProvider.ts  clase AnthropicProvider (implementa Provider) — compone un
│                         AnthropicClient y le agrega el loop de tool_use, MCP remoto,
│                         thinking/task budgets, checkpointing.
├── sse.ts                reensamblado de streaming SSE → misma forma que un response
│                         no-streaming. Funciones puras, detalle de implementación de
│                         AnthropicClient (no se exporta).
├── index.ts
└── tests/                AnthropicClient.test.ts, AnthropicProvider.test.ts, sse.test.ts
```

## Por qué dos clases y no una

`AnthropicClient` no sabe qué es un `Tool`, un `Agent` ni un loop — sólo sabe hablar el wire
protocol (headers, retry, SSE). Es la pieza que usaría cualquier OTRO caller que necesite pegarle
a la API sin todo el aparato de `AnthropicProvider` (ej. un clasificador liviano de una sola
vuelta, sin tools). `AnthropicProvider` es la que sabe de `ProviderRunContext`/`ProviderRunOutput`
(el contrato de `agent-pipeline`) y arma el loop de tool_use sobre ese `AnthropicClient`.

Si necesitás agregar algo que es puramente "cómo le hablamos a la API" (un header nuevo, un modo
de retry distinto), va en `AnthropicClient`. Si es "cómo interpretamos la respuesta para un
`Agent`" (un `stop_reason` nuevo, cómo se arma el loop de tools), va en `AnthropicProvider`.

`AnthropicClient.send` soporta streaming incremental vía `onDelta` (llamado con cada
`text_delta`/`thinking_delta`, no el acumulado) — vive en `sse.ts`
(`readAnthropicSseStream(res, onDelta)`), no en `AnthropicProvider`: éste necesita el `content`
completo para resolver `stop_reason`/tool_use/exit, así que expone observabilidad batch
(`onToolCall`/`onToolResult`) pero no un `onDelta` propio. Un caller que quiera texto en vivo
(un chat) usa `AnthropicClient` directo — ver `README.md` y `examples/apps/chat.ts`.

## Ciclo de dependencias con `agent-pipeline` — por qué los examples NO viven acá ni ahí

Este paquete depende de `@ia-tools/agent-pipeline` (implementa su `Provider`). Si
`agent-pipeline` a su vez dependiera de este paquete —aunque sea sólo en `devDependencies`, para
sus propios examples— `pnpm` lo marca como dependencia cíclica entre workspaces, lo que rompe el
orden de `pnpm -r build`. Por eso las apps de ejemplo que combinan los dos paquetes
(`github-issue-triage.ts`, `slack-support-reply.ts`, `travel-planner.ts`) viven en
`ia-tools/examples/` (raíz del monorepo, gitignoreado, ver `.gitignore` y `pnpm-workspace.yaml`)
— un tercer lugar que depende de ambos sin que ninguno de los dos dependa del otro.

## Tests — mismo esquema que `agent-pipeline`

`src/*/tests/` al lado de lo que prueban (acá todo vive en `src/tests/` porque no hay
subcarpetas). `vitest.config.ts` mira `src/**/tests/**/*.test.ts`.

Los tests de `AnthropicProvider`/`AnthropicClient` NUNCA pegan a la red real: `fetchImpl` es
inyectable (`AnthropicClientOptions.fetchImpl`) y todos los tests pasan un `vi.fn()` que arma un
`Response` de `node-fetch`/`undici` a mano. `sse.test.ts` construye un `ReadableStream` con
frames SSE crudos para probar `readAnthropicSseStream` sin pasar por HTTP en absoluto.

## Antes de tocar código

```bash
pnpm --filter @ia-tools/provider-anthropic typecheck
pnpm --filter @ia-tools/provider-anthropic test
pnpm --filter @ia-tools/provider-anthropic build
```

`pnpm build` importa igual que en `agent-pipeline`: `tsconfig.build.json` excluye
`src/**/tests/**`, así que un `dist/` viejo con archivos de un módulo renombrado/borrado hay que
limpiarlo a mano antes de rebuildear (`tsc` no borra outputs huérfanos):
`find dist -type f -delete && find dist -type d -empty -delete`.
