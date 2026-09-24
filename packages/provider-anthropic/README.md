# @ia-tools/provider-anthropic

`Provider` de Anthropic para [`@ia-tools/agent-pipeline`](../agent-pipeline) — habla la Messages
API real: streaming, retries con backoff, extended thinking, task budgets, MCP remoto y
checkpointing. Portado de `ia-flow/packages/ai-providers/src/anthropic-api`, adaptado al
contrato `Provider` (`{ id, run(ctx) }`) del harness en vez del `IAgentProvider` completo de
ia-flow (que necesita `ToolExecutionPort`, `WorkspaceProvisionerPort` y un compilador de policy
que `agent-pipeline` no modela).

## Instalar (dentro del monorepo)

```bash
pnpm --filter @ia-tools/provider-anthropic build
pnpm --filter @ia-tools/provider-anthropic test
```

`"@ia-tools/provider-anthropic": "workspace:*"` en el `package.json` de quien lo use. Fuera del
monorepo: `npm pack` o un registry privado — su única dependencia runtime es
`@ia-tools/agent-pipeline`.

## Uso mínimo

```ts
import { Agent, Pipeline, providerRegistry } from '@ia-tools/agent-pipeline';
import { AnthropicProvider } from '@ia-tools/provider-anthropic';

providerRegistry.register(new AnthropicProvider({ id: 'anthropic-api', model: 'claude-sonnet-5' }));

const pipeline = new Pipeline({
  id: 'triage',
  on: ['github.issue.opened'],
  do: [new Agent({ id: 'triage', provider: 'anthropic-api', prompt: '...' })],
});
```

Auth por `apiKey`/`oauthToken` en las opciones, o `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`
en el entorno (el OAuth token gana si están los dos).

## Las dos clases

```
AnthropicClient    auth + headers + retry con backoff + reensamblado de streaming SSE.
                    No sabe nada de tools ni de loops — es lo que hablaría CUALQUIER caller
                    (un clasificador liviano, un script). Se puede usar sola.

AnthropicProvider   implementa Provider (agent-pipeline). Compone un AnthropicClient y le
                    agrega el loop de tool_use, MCP remoto, thinking/task budgets y
                    checkpointing — todo lo que sabe de "cómo correr UN Agent".
```

## Perillas — todas opcionales

| Opción | Qué hace | Default |
| --- | --- | --- |
| `stream` | Streaming SSE (mantiene la conexión viva en runs largos) | `true` |
| `maxRetries` | Reintentos en 429/5xx/529 con backoff exponencial + jitter | `3` |
| `maxToolRounds` | Tope de vueltas del loop de tools | `8` |
| `bumpMaxTokensOnTruncation` | Un corte por `max_tokens` reintenta UNA vez con el doble de presupuesto | `true` |
| `thinking` | Extended thinking — `{ type: 'adaptive' }` o `{ type: 'enabled', budgetTokens }` | apagado |
| `effort` / `taskBudgetTokens` | `output_config` — nivel de esfuerzo / presupuesto total de tokens | apagado |
| `eagerMcpTools` | Carga el catálogo MCP entero de una, en vez de diferido con búsqueda | `false` |
| `onCheckpoint(messages, ctx)` | Se llama antes de cada request — el caller decide si/dónde persistir | — |
| `onToolCall` / `onToolResult` | Observabilidad del loop de tools | — |
| `onRetry` | Observabilidad de los reintentos HTTP | — |

Todas menos `onCheckpoint`/`onToolCall`/`onToolResult`/`onRetry` también se pueden overridear
**por agente**, vía `AgentDefinitionProps.providerConfig` (ver `AnthropicAgentProviderConfig`):

```ts
new Agent({
  id: 'x',
  provider: 'anthropic-api',
  prompt: '...',
  providerConfig: { model: 'claude-haiku-4-5-20251001', maxTokens: 512, effort: 'low' },
});
```

## MCP remoto

`AgentDefinitionProps.mcpServers` (id + `config` libre) mapea a `mcp_servers[]` de la API cuando
`config.url` está presente — es el conector MCP **remoto** de Anthropic (Anthropic abre la
conexión, no este paquete); `stdio` no cruza la red y no está soportado acá.

```ts
new Agent({
  id: 'x',
  provider: 'anthropic-api',
  prompt: '...',
  mcpServers: [{ id: 'gh', config: { url: 'https://mcp.example/gh', authorizationToken: 'tok' } }],
});
```

## Checkpointing y reanudación

Este paquete no tiene storage propio — `onCheckpoint` es sólo un canal. El caller que quiera
reanudar un run pausado/cortado:

1. Persiste `messages` en `onCheckpoint(messages, ctx)`.
2. En el próximo run, pasa esa conversación de vuelta vía
   `providerConfig: { resumeMessages: [...] }` — `AnthropicProvider` arranca de ahí en vez de
   `ctx.prompt`.

Un `stop_reason: 'pause_turn'` (el modelo se pausó a mitad de turno) no se reanuda solo dentro de
una sola llamada a `run` — tira un error explícito en vez de adivinar. Reanudarlo es
responsabilidad del caller, con el mismo mecanismo de arriba.

## Lo que NO porta de ia-flow (a propósito)

- **`ToolExecutionPort`/`WorkspaceProvisionerPort`/policy compilada** — `agent-pipeline` no
  modela worktrees ni un compilador de allow/deny; las `tools[]` de un `Agent` ya vienen
  resueltas.
- **Contexto a disco (`logContext`)** — sin logger port en este harness; usá `onToolCall`/
  `onToolResult`/`onRetry` si necesitás observabilidad.
- **`retryTruncatedToolUse` fino** (reintento específico de un `tool_use` con JSON cortado a
  mitad de streaming) — `bumpMaxTokensOnTruncation` cubre el caso general (doblar presupuesto),
  no la reconstrucción puntual del bloque.
