# @ia-tools/github-tools

`Tool[]` de [`@ia-tools/agent-pipeline`](../../agent-pipeline) respaldadas por la REST API de
GitHub — leer un issue, comentar, agregar labels, buscar issues. Es el ÚNICO puente entre
[`@ia-tools/github-api`](../api) (el client, no sabe qué es un `Agent`) y `agent-pipeline`
(el tipo `Tool`, no sabe hablar con GitHub) — ninguno de los dos se conoce entre sí.

## Instalar (dentro del monorepo)

```bash
pnpm --filter @ia-tools/github-tools build
pnpm --filter @ia-tools/github-tools test
```

## Uso

```ts
import { Agent } from '@ia-tools/agent-pipeline';
import { GithubTokenAuth } from '@ia-tools/github-auth';
import { GithubClient } from '@ia-tools/github-api';
import { GithubToolRegistry } from '@ia-tools/github-tools';

const client = new GithubClient({ auth: new GithubTokenAuth(process.env.GITHUB_TOKEN!) });
const registry = new GithubToolRegistry(client);

const triage = new Agent({
  id: 'triage',
  provider: 'anthropic-api',
  prompt: 'Leé el issue #{{number}} de {{owner}}/{{repo}} y decidí si es un bug accionable.',
  tools: registry.all(), // las 4 — o elegí por nombre: registry.resolve(['github_get_issue', ...])
  exits: { actionable: 'actionable', 'not-actionable': 'not-actionable' },
});
```

### Acceso por nombre

`GithubToolRegistry` resuelve tools por string — útil cuando la lista de tools que un agente
puede usar viene de config (ej. un YAML de pipeline) en vez de estar hardcodeada en el código:

```ts
registry.names(); // ['github_get_issue', 'github_comment_issue', 'github_add_labels', 'github_search_issues']
registry.get('github_get_issue'); // Tool — tira con mensaje útil si el nombre no existe
registry.resolve(['github_get_issue', 'github_add_labels']); // Tool[] en el orden pedido
```

Cada tool (`GetIssueTool`, `CommentIssueTool`, `AddLabelsTool`, `SearchIssuesTool`) también se
exporta suelta, por si una app quiere una sola sin pasar por el registry: `new
GetIssueTool(client)`.

## Las cuatro tools

| Tool | Qué hace |
| --- | --- |
| `github_get_issue` | Lee título, cuerpo, estado y labels de un issue |
| `github_comment_issue` | Publica un comentario (issue o PR — la API los trata igual) |
| `github_add_labels` | Agrega labels a un issue (no reemplaza las existentes) |
| `github_search_issues` | Busca con la sintaxis de búsqueda de GitHub (`repo:o/r is:open label:bug`) |

Un error de la API (404, 401, rate limit) hace que un `handler` tire — `AnthropicProvider` ya
convierte eso en un `tool_result` con `is_error: true` en vez de tumbar el run entero (ver
`provider-anthropic`), así que las tools acá no necesitan su propio try/catch defensivo.

## Por qué es un paquete propio y no vive en `@ia-tools/github-api`

`@ia-tools/github-api` es standalone a propósito (cero dependencia de `agent-pipeline`, usable
por cualquier engine). El tipo `Tool` es vocabulario de `agent-pipeline`, así que envolver
`GithubClient` en `Tool[]` necesita conocer los dos — de ahí que sea un cuarto paquete, no que
uno de los otros importe al que le falta.
