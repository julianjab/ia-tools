# @ia-tools/agent-pipeline

Harness domain-agnostic para componer agentes en pipelines que reaccionan a eventos
(GitHub, Slack, cron, un pedido de viaje — lo que sea). Ver `README.md` para el contrato
completo; esto es guía específica para trabajar en el código del paquete.

## Qué es y qué NO es este paquete

Es **sólo dominio**: interfaces y clases puras (`DomainEvent`, `EventBus`, `Condition`,
`Agent`, `Pipeline`, `Engine`). No define nada atado a infraestructura — ni un provider de
LLM concreto, ni un cliente HTTP a un servicio externo, ni una credencial. Eso es
responsabilidad de quien consume la lib: cada app trae su propio `Agent` (con
`functionAgent` como wrapper mínimo, o una clase propia) que adentro llama a lo que
necesite. Antes de agregar algo acá, preguntate: ¿esto es una pieza del harness (le sirve
a cualquier dominio) o es infraestructura de un caso de uso puntual? Si es lo segundo, va
en `examples/` como ilustración, nunca en `src/`.

## Estructura

```
src/
├── agent/       Agent (interfaz), AgentRegistry, functionAgent (wrapper mínimo)
├── condition/    Condition — un `when` puro sobre un payload
├── events/       DomainEvent, EventBus (pub/sub in-process)
├── pipeline/      Pipeline + actions/ (AgentAction, EmitAction, HttpAction, FunctionAction)
└── engine/       Engine (dispatch), PipelineSource
tests/            Mirror 1:1 de src/ — ver "Tests" abajo
examples/         Los tres casos de uso que motivaron el paquete (no se compilan a dist/)
```

## Tests — carpeta separada, no colocados

Los tests viven en `tests/`, **no** junto al código fuente (`src/**/*.test.ts`). La
estructura de `tests/` espeja 1:1 la de `src/` (`tests/agent/Agent.test.ts` prueba
`src/agent/Agent.ts`), así que un archivo nuevo en `src/` implica crear su contraparte en
la misma ruta relativa bajo `tests/`.

Los imports de un test apuntan al módulo real con path relativo completo hacia `../src/...`
(ej. `tests/pipeline/actions/AgentAction.test.ts` importa
`../../../src/pipeline/actions/AgentAction.js`) — nunca a otro archivo de test.

`vitest.config.ts` sólo mira `tests/**/*.test.ts`. Correr con `pnpm test` (o
`vitest run` / `vitest` desde este directorio).

## TypeScript — dos tsconfig, dos propósitos

- **`tsconfig.json`** — el que usa el editor y `pnpm typecheck` (`tsc --noEmit`, sin `-p`).
  Incluye `src`, `tests` Y `examples`: todo el código del paquete se tipa, aunque sólo
  `src/` se publique. `noEmit: true` porque este archivo nunca genera output.
- **`tsconfig.build.json`** — el que usa `pnpm build` (`tsc -p tsconfig.build.json`).
  Sólo incluye `src` con `rootDir: "src"` y `outDir: "dist"` — es lo único que termina en
  el paquete publicado. `tests/` y `examples/` nunca se compilan a `dist/`.

Si agregás una opción de compilador nueva, pensá en cuál de los dos (o los dos)
corresponde: algo que afecta el output publicado va en `tsconfig.build.json`; algo que
sólo afecta la experiencia de tipar (lib, target, strictness) va en `tsconfig.json` y se
hereda desde `../../tsconfig.base.json` si aplica a todo el monorepo.

## `DomainEvent<any>` en las firmas del harness — no es un descuido

`EventBus`, `Engine`, `Pipeline` y `PipelineExecutionContext` tipan sus eventos como
`DomainEvent<any>`, no como `DomainEvent` a secas (que resuelve al default
`DomainEvent<Record<string, unknown>>`). El harness no le exige forma al `payload` — eso
es conocimiento de cada `Agent` de dominio (`GithubIssuePayload`, `SlackMessagePayload`,
`TripRequestPayload`, ...). Si el genérico quedara en su default, cualquier evento creado
con `createEvent<TripRequestPayload>(...)` dejaría de ser asignable a las firmas internas
del motor — que es justo el caso de uso central del paquete. Si tocás una de esas firmas,
mantené `DomainEvent<any>`.

## Antes de tocar código

```bash
pnpm --filter @ia-tools/agent-pipeline typecheck
pnpm --filter @ia-tools/agent-pipeline test
pnpm --filter @ia-tools/agent-pipeline build
```

Los tres tienen que estar en verde antes de commitear (regla global del repo, ver
`~/.claude/CLAUDE.md` del usuario). `pnpm build` importa: valida que `tsconfig.build.json`
sigue compilando sólo lo publicable, sin arrastrar `tests/`/`examples/`.
