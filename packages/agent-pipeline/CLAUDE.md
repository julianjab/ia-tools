# @ia-tools/agent-pipeline

Harness domain-agnostic para componer agentes en pipelines que reaccionan a eventos
(GitHub, Slack, cron, un pedido de viaje — lo que sea). Ver `README.md` para el contrato
completo; esto es guía específica para trabajar en el código del paquete.

## Qué es y qué NO es este paquete

Es **contrato puro, sin I/O**: interfaces y clases (`DomainEvent`, `EventBus`, `Condition`,
`Runnable`, `Agent`, `Pipeline`, `Engine`, `AgentDefinitionProps`, `Provider`,
`ProviderRegistry`, `ToolRegistry`, `SchemaTool`). La única dependencia runtime es `zod`, y
sólo la usa `SchemaTool` — es validación pura en memoria, no I/O, así que no rompe la regla de
abajo. No sumes otra sin una razón igual de fuerte.

La regla NO es "nada que mencione un LLM" — `Agent` sabe
que existe un `prompt`, `systemPrompts`, `exits`; eso es dominio, no infra, porque es
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
│   ├── AgentDefinition.ts   AgentDefinitionProps + tipos (SystemPromptRef, Tool, AgentExit, ...)
│   ├── Provider.ts          Provider (interfaz) + ProviderRegistry + providerRegistry (singleton)
│   ├── ToolRegistry.ts      base genérica de registry de Tool con AUTO-REGISTRO por clase
│   ├── SchemaTool.ts        base de Tool con input declarado como z.strictObject (valida + JSON Schema)
│   └── tests/               Agent.test.ts, AgentDefinition.test.ts, Provider.test.ts, ToolRegistry.test.ts, SchemaTool.test.ts
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
│       ├── EmitAction.ts, HttpAction.ts, FunctionAction.ts
│       └── tests/
├── engine/
│   ├── Engine.ts, PipelineSource.ts
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

## Antes de tocar código

```bash
pnpm --filter @ia-tools/agent-pipeline typecheck
pnpm --filter @ia-tools/agent-pipeline test
pnpm --filter @ia-tools/agent-pipeline build
```

Los tres tienen que estar en verde antes de commitear (regla global del repo, ver
`~/.claude/CLAUDE.md` del usuario). `pnpm build` importa: valida que `tsconfig.build.json`
sigue compilando sólo lo publicable, sin arrastrar ningún `tests/` anidado.
