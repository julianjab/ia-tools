# @ia-tools/agent-pipeline

Harness domain-agnostic para componer agentes en pipelines que reaccionan a eventos
(GitHub, Slack, cron, un pedido de viaje — lo que sea). Ver `README.md` para el contrato
completo; esto es guía específica para trabajar en el código del paquete.

## Qué es y qué NO es este paquete

Es **contrato puro, sin I/O**: interfaces y clases (`DomainEvent`, `EventBus`, `Condition`,
`Runnable`, `Agent`, `Pipeline`, `Engine`, `AgentDefinitionProps`, `Provider`,
`ProviderRegistry`, `ToolRegistry`, `SchemaTool`, `Action`, `Project`, la cascada de rutas). Las
dependencias runtime son `zod` — la usan `SchemaTool`, `Action`, el `input` de `Agent` y los
schemas de `submit_*`; es validación pura en memoria — y las APIs de OpenTelemetry
(`@opentelemetry/api`, `@opentelemetry/api-logs`; ver "Telemetría" abajo), que sin un SDK
registrado son no-ops sin I/O. Ninguna rompe la regla de abajo. No sumes otra sin una razón
igual de fuerte — y nunca un SDK de OTel: eso lo elige la app.

La regla NO es "nada que mencione un LLM" — `Agent` sabe
que existe un `prompt`, `systemPrompts`, sus salidas; eso es dominio, no infra, porque es
TypeScript puro sin `fetch` ni credenciales. La línea real es **contrato vs. implementación
con I/O real**: un `Provider` CONCRETO que le pega a la API de Anthropic/OpenAI/lo que sea
(hace `fetch`, lee `process.env`, maneja retries) es infra — vive en su propio paquete
(`@ia-tools/provider-anthropic`), nunca en `src/` de ESTE paquete. Antes de agregar algo acá,
preguntate: ¿esto compila sin tocar la red ni el filesystem? Si la respuesta es no, no va acá.

## Estructura

```
src/
├── agent/
│   ├── Agent.ts             clase concreta — un Runnable respaldado por un LLM
│   ├── AgentDefinition.ts   AgentDefinitionProps + tipos (SystemPromptRef, Tool, McpServerRef, ...)
│   ├── Provider.ts          Provider (interfaz) + ProviderRegistry + providerRegistry (singleton)
│   ├── ToolRegistry.ts      base genérica de registry de Tool con AUTO-REGISTRO por clase
│   ├── SchemaTool.ts        base de Tool con input declarado como z.strictObject (valida + JSON Schema)
│   └── tests/               Agent.test.ts, Provider.test.ts, ToolRegistry.test.ts, SchemaTool.test.ts
├── condition/
│   ├── Condition.ts, Conditional.ts
│   └── tests/
├── events/
│   ├── DomainEvent.ts, EventBus.ts
│   └── tests/
├── pipeline/
│   ├── Pipeline.ts
│   ├── Runnable.ts          base de todo lo que vive en Pipeline.do[]
│   ├── tests/
│   └── actions/
│       ├── Action.ts         Action (input tipado) + BoundAction (bind) + AllowedAction (allowWrite)
│       ├── EmitAction.ts, HttpAction.ts, FunctionAction.ts
│       └── tests/
├── routing/
│   ├── ExitRoutes.ts        END, ExitRoutes, resolveRoutes (la cascada), submitSchemaFor
│   └── tests/
├── engine/
│   ├── Engine.ts, PipelineSource.ts, Project.ts
│   └── tests/
├── telemetry/
│   ├── telemetry.ts         withSpan, emitLog, atributos heredados (OpenTelemetry por API)
│   └── tests/
├── index.ts
└── tests/                index.test.ts
```

Los examples (los tres casos de uso que motivaron el paquete) NO viven acá — ver
"Por qué los examples no viven adentro de este paquete" en `README.md`. Viven en
`ia-tools/examples/` (raíz del monorepo, gitignoreado), porque combinan este paquete con
`@ia-tools/provider-anthropic`, y ese paquete depende de éste — meterlos adentro crearía una
dependencia cíclica entre workspaces de pnpm.

### `Runnable` — la base única de `Pipeline.do[]`

Antes había dos contratos separados: `PipelineAction` (lo que vivía en `do[]`) y `Agent`
(resuelto por id vía un `AgentRegistry`, puenteado por un `AgentAction`). Se colapsaron en
uno: `Runnable` es la base, `EmitAction`/`HttpAction`/`FunctionAction` la extienden para
pasos genéricos, y `Agent` la extiende directo para pasos respaldados por LLM — sin
indirección de por medio. `AgentAction`, `AgentRegistry` y `functionAgent` ya NO EXISTEN:
reusar el mismo agente en dos pipelines es, como con cualquier otro objeto TS, importar la
misma instancia dos veces; un paso determinístico nombrado es un `FunctionAction` (con su
propio `when`/`id`), no un "agente" fingido.

`isAgent(step)` (en `Pipeline.ts`) es el type guard para distinguir un `Agent` de un
`Runnable` genérico dentro de un `do[]` construido dinámicamente.

## Tests — en un `tests/` DENTRO de cada carpeta, no colocados ni en un árbol aparte

Cada carpeta de `src/` que tiene código tiene su propia subcarpeta `tests/` al lado — NO
`Agent.test.ts` junto a `Agent.ts` (colocado), y NO un árbol `tests/` separado en la raíz
del paquete que espeje a `src/` (esquema anterior, se descartó). `src/agent/tests/Agent.test.ts`
prueba `src/agent/Agent.ts`; un archivo nuevo en `src/foo/Bar.ts` implica crear
`src/foo/tests/Bar.test.ts`.

El import al módulo que prueba es siempre `../Bar.js` (un nivel arriba de `tests/`, directo
al hermano); un import a OTRO módulo del paquete sale desde ahí con la profundidad relativa
que corresponda (ej. `src/pipeline/actions/tests/EmitAction.test.ts` importa
`../../../events/DomainEvent.js`). Nunca importa desde otro archivo de test.

`vitest.config.ts` mira `src/**/tests/**/*.test.ts`. Correr con `pnpm test` (o
`vitest run` / `vitest` desde este directorio).

## TypeScript — dos tsconfig, dos propósitos

- **`tsconfig.json`** — el que usa el editor y `pnpm typecheck` (`tsc --noEmit`, sin `-p`).
  Incluye sólo `src` (que ya trae sus `tests/` anidados) — no hay `examples/` acá, ver
  arriba por qué. `noEmit: true` porque este archivo nunca genera output.
- **`tsconfig.build.json`** — el que usa `pnpm build` (`tsc -p tsconfig.build.json`).
  Incluye `src` con `rootDir: "src"` y `outDir: "dist"`, pero EXCLUYE explícitamente
  `src/**/tests/**` — sin ese exclude, cada `tests/` anidado (al estar dentro de `src/`)
  terminaría compilado dentro de `dist/`.

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

## `ToolRegistry<TArgs>` — auto-registro de `Tool` por clase, no un array a mano

Nace de portar `@ia-tools/github-tools` (y después `fs-tools`) a clases: cada dominio de tools
(GitHub, filesystem, lo que sea) tiene su propio registry (`GithubToolRegistry`,
`FsToolRegistry`) que resuelve tools por nombre — mismo contrato que `ProviderRegistry`
(`get`/`resolve`), pero para tools que un consumidor NO instancia a mano, sino que se
auto-registran al definirse.

El patrón: una tool concreta extiende una clase base DEL DOMINIO (`GithubTool`, `FsTool` — no
viven acá, cada paquete de tools define la suya con SU lógica compartida); el registro
(`SuRegistry.register(SuTool)`) vive CENTRALIZADO en `SuRegistry.ts`, una línea por tool,
DESPUÉS de la declaración de la clase — no repartido en cada archivo de tool. La forma "más
auto" (cada tool se registra sola al final de su propio archivo) se probó y se descartó: crea
una dependencia circular real con el archivo del registry (que a su vez necesita importar los
archivos de tools), y en ESM eso cae en TDZ — la clase del registry todavía no terminó de
inicializarse en el punto donde el archivo de la tool, importado a mitad de esa evaluación,
intenta usarla. `new SuRegistry(...)` instancia recién ahí todo lo registrado. Agregar una tool
nueva nunca toca la lógica de construcción del registry (`ToolRegistry`, acá) — sólo el archivo
de la tool nueva, el barrel `tools/index.ts`, y una línea de `.register(...)` en `SuRegistry.ts`.

**El único punto no-obvio**: `protected static registeredTools` se declara en la base
(`ToolRegistry`) pero cada subclase concreta TIENE QUE redeclararlo (`protected static
registeredTools: ToolConstructor<[TusArgs]>[] = [];`) — un `static` de la base es una única
propiedad compartida por prototype chain; sin la redeclaración, dos dominios distintos
terminarían empujando a la MISMA lista. El test que lo prueba (`ToolRegistry.test.ts`, "dos
subclases que redeclaran su propio registeredTools NUNCA comparten lista") es el que hay que
mirar si esto se rompe.

**Riesgo conocido, sin guarda en runtime**: si una subclase nueva se OLVIDA de redeclarar
`registeredTools`, `register()` no tira — empuja en silencio a la lista de la BASE, compartida
por cualquier otro dominio que tampoco la haya redeclarado. No hay ningún chequeo (`Object.
hasOwn(this, 'registeredTools')` u otro) que lo detecte hoy; queda como algo a mirar si un
registry nuevo aparece con tools de otro dominio mezcladas.

`static register()` usa `this.registeredTools` con `this` POLIMÓRFICO a propósito (la subclase
real que llamó `.register`) — de ahí el `biome-ignore lint/complexity/noThisInStatic` puntual:
el fix automático de biome ("usar el nombre de la clase") rompería justo el aislamiento que
este diseño busca.

## `SchemaTool<S>` — el input de una tool se declara una vez, en zod

El input de una `Tool` lo escribe el MODELO, nunca un caller de confianza — y `AnthropicProvider`
se lo pasa a `handler` tal cual. Antes cada tool mantenía a mano una `interface` TS y un
`inputSchema` JSON que podían divergir, y nada validaba en runtime (un `fs_edit` sin `newString`
escribía el literal "undefined" en el archivo). `SchemaTool` junta las tres cosas: la subclase
declara `input` (un `z.strictObject`), implementa `execute(input: z.infer<S>)`, y la base deriva
`inputSchema` (`z.toJSONSchema`, sin `$schema`) y valida en `handler` antes de llamar a `execute`.

- `handler` es `async` y RECHAZA con `z.prettifyError` si el input no valida — `AnthropicProvider`
  ya convierte cualquier rechazo de un handler en un `tool_result` con `is_error: true`, así que
  el modelo ve qué campo falló y se corrige solo.
- `ToolInputSchema` fuerza `strictObject` a nivel de tipo: claves que el modelo invente se
  rechazan en vez de descartarse en silencio.
- `inputSchema` es un getter perezoso, no un field: `input` es un field de la SUBCLASE, que
  todavía no está asignado cuando corre el constructor de la base.
- La interfaz `Tool` no cambia: un consumidor puede seguir implementándola a mano con JSON Schema
  plano (los fixtures de `ToolRegistry.test.ts` lo hacen). `SchemaTool` es opt-in.

## Salidas de un agente — `routing/ExitRoutes.ts`

Reemplaza a `exits`/`comment`/`emitOn` (el modelo de ia-flow). Un agente termina eligiendo una
SALIDA con una tool `submit_<salida>`, cuyo schema es el input de los pasos a los que lleva — ver
`submitSchemaFor`. Qué salidas hay y a dónde llevan se resuelve en cascada, **paso > pipeline >
agente > proyecto**, con `resolveRoutes` (pura, sin I/O). Reglas que no son obvias al leer el código:

- **Sólo el agente crea salidas** (vocabulario + `when`). Un override de una salida no declarada
  tira: un typo tiene que romper al construir, no quedar como config muerta.
- **Las rutas base del agente sólo apuntan a acciones.** Encadenar agentes se declara en la
  pipeline (`routes.<agentId>`), donde se ve el grafo completo; si no, incluir un agente
  arrastraría el grafo de otros. `Agent` lo valida en su constructor.
- **Una salida sin `to` es sólo vocabulario** (ej. `comment-triage.actionable`): la pipeline
  tiene que ponerle destino o la construcción falla.
- **`report` corre ANTES que los destinos.** El siguiente agente (disparado por un cambio de
  status) lee los comentarios del issue; si la transición fuera primero, arrancaría sin ver el
  hallazgo que lo mandó ahí. Este orden vive en `Pipeline.runStep`, en un solo lugar.
- **Proyecto y pipeline sólo definen `onError`/`report`** (`ExitDefaults`): no conocen a los
  agentes, no pueden inventarles salidas.
- **Los loops no van por rutas.** `Pipeline` rechaza ciclos entre agentes; un "review → build"
  pasa por un evento (el cambio de status), con el tope de profundidad del `Engine`.

`Pipeline` valida todo el cableado en su constructor llamando a `resolveRoutes` sin el nivel
proyecto (que llega en runtime vía `ctx.defaults` y sólo aporta `onError`/`report`).

## Telemetría — `telemetry/telemetry.ts`, OpenTelemetry sólo por API

Todo lo que corre por causa de UN evento cuelga de UNA traza: `Engine.dispatch` abre el span
`event <type>` (raíz, o hijo si lo publicó un paso de otra pipeline), `Pipeline.execute` abre
`pipeline <id>` y `runStep` abre `agent <id>` / `action <id>` por cada paso — los destinos de una
salida cuelgan del agente que la eligió. Reglas que no son obvias al leer el código:

- **El scope del evento se hereda, no se repite.** `event.scope` → atributos `ia.<clave>`
  (`ia.projectId`, `ia.repo`, `ia.issue`, …) guardados en el `Context` de OTel con una clave
  propia; `withSpan` y `emitLog` los suman a cada span y log creado debajo, también en otros
  paquetes (el provider los recibe sin plumbing). NO va en baggage: el baggage se propaga en los
  headers HTTP salientes y le mandaría el issue a GitHub/Anthropic.
- **"No pasó nada" también deja traza.** Cada pipeline que escucha el tipo del evento deja un
  span event `pipeline.match` con `ia.pipeline.skip_reason` (`Pipeline.explainMismatch`), y un
  evento que no dispara nada igual abre su span.
- **Un error manejado igual se ve.** Un paso que falla y lo cubre un `onError` queda en ERROR con
  `ia.step.error_handled`; el `onError` corre como hijo con `ia.step.via: onError`.
- **Sin SDK, no-op.** La app (el runner, un servidor) registra el SDK y el exporter (OTLP); los
  tests usan el SDK en memoria (`devDependencies`), ver `telemetry/tests/`.

## Antes de tocar código

```bash
pnpm --filter @ia-tools/agent-pipeline typecheck
pnpm --filter @ia-tools/agent-pipeline test
pnpm --filter @ia-tools/agent-pipeline build
```

Los tres tienen que estar en verde antes de commitear (regla global del repo, ver
`~/.claude/CLAUDE.md` del usuario). `pnpm build` importa: valida que `tsconfig.build.json`
sigue compilando sólo lo publicable, sin arrastrar ningún `tests/` anidado.
