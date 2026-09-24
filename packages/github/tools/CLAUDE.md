# @ia-tools/github-tools

Puente entre `@ia-tools/github-api` y `@ia-tools/agent-pipeline`. Ver `README.md` para el
contrato de uso; esto es guía específica para trabajar en el código del paquete.

## Por qué este paquete y no uno de los otros

`@ia-tools/github-api` no puede definir `Tool[]` — no depende de `agent-pipeline` (es standalone
a propósito). `agent-pipeline` no puede saber hablar con la REST API de GitHub — es contrato
puro, sin I/O. Este paquete es el único punto que importa los dos: `GithubClient` (de
`github-api`) + el tipo `Tool` (de `agent-pipeline`). Vive en `packages/github/tools/` —
hermano de `auth/`, `webhook/` y `api/` dentro de la misma carpeta `github/`, pero como
`package.json` propio, no como subcarpeta de ninguno de los otros tres.

## Estructura

```
src/
├── shared.ts             GithubIssueApiShape, summarizeIssue(), issuePath() + validación
├── tools/
│   ├── getIssue.ts        createGetIssueTool(client)
│   ├── commentIssue.ts    createCommentIssueTool(client)
│   ├── addLabels.ts       createAddLabelsTool(client)
│   ├── searchIssues.ts    createSearchIssuesTool(client)
│   └── tests/             un .test.ts por tool
├── GithubToolRegistry.ts  acceso por nombre — get()/names()/all()/resolve()
├── index.ts
└── tests/                 shared.test.ts, GithubToolRegistry.test.ts, index.test.ts
```

Una tool por archivo — cada una exporta una función `create*Tool(client): Tool<TInput>`, no un
método de clase. `GithubToolRegistry` las instancia todas una vez y las indexa por `tool.name`,
para que un agente (o una config declarativa, ej. YAML de pipeline) pueda pedir tools por string
en vez de tener el import hardcodeado. Mismo patrón que `ProviderRegistry` en `agent-pipeline`.

## Agregar una tool nueva

1. Un archivo nuevo en `src/tools/`, exportando `create<Nombre>Tool(client: GithubClient): Tool<TInput>`
   — `name`, `description`, `inputSchema` (JSON Schema que el modelo va a ver) y `handler` (async,
   usa `client.requestJson`/`.request`).
2. Sumalo al array de tools en el constructor de `GithubToolRegistry`.
3. Sumalo a los exports de `index.ts`.
4. Un `describe()` en `src/tools/tests/<nombre>.test.ts` con un `fetchImpl` fake — nunca pega a la
   red real (mismo criterio que `provider-anthropic`/`github`).
5. Si el endpoint devuelve un shape que ya usa otra tool (ej. un issue), reusá
   `GithubIssueApiShape`/`summarizeIssue`/`issuePath` de `shared.ts` en vez de duplicar el parseo
   o la validación de `owner`/`repo`/`number` (estos son inputs controlados por el modelo — sin
   `issuePath()` un `repo: "../../orgs/other-org/repos"` se escapa del endpoint esperado).

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
