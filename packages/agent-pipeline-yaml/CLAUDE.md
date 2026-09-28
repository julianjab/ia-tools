# @ia-tools/agent-pipeline-yaml

Proyectos, agentes y pipelines de `@ia-tools/agent-pipeline` escritos en YAML, y el `Engine`
armado desde un `engine.yaml`. Hace I/O (lee archivos): por eso vive fuera del core.

## Qué es este paquete

- **`YamlPipelineSource`** — un `PipelineSource` por carpeta de proyecto, leído en vivo: el engine
  llama `list()` en cada evento y, si cambió algún archivo (fecha, tamaño, uno nuevo o borrado), se
  recarga. Una versión inválida se loguea y sigue la última buena; la primera carga tira.
- **`createEngineFromYaml`** — la raíz de composición (acepta además `sources` armadas en código):
  lee `engine.yaml`, arma fuentes, store y
  `Engine`, lo suscribe al bus y vence pausas con `tick.everyMs`. El store se elige por nombre de
  driver: `memory` viene incluido, el resto se inyecta (`drivers: { sqlite: sqliteStoreDriver }`)
  — este paquete no depende de `@ia-tools/agent-pipeline-sqlite` (sólo en tests).

## Estructura

```
src/
├── YamlPipelineSource.ts    la fuente: caché por firma de archivos + recarga
├── ProjectLoader.ts         qué archivos forman un proyecto, y leerlos
├── ProjectBuilder.ts        documentos → Project (agentes compartidos, pipelines, defaults, refs)
├── YamlReader.ts            leer + validar un archivo contra su schema (errores con archivo)
├── schema.ts                la forma de cada archivo (zod): project, agent, pipeline, engine
├── StepFactory.ts           el contrato de un tipo de paso (keyword + schema + create)
├── StepFactoryRegistry.ts   qué factory arma cada nodo (la primera clave registrada)
├── factories/               una por tipo incluido: agent, action, emit, http, pause, function
├── steps/                   los pasos propios del YAML: HttpStep (select, GraphQL), EmitStep
├── Template.ts              `{{path}}` al correr (render) y `{{vars.x}}` al cargar (substituteVars)
├── YamlCatalogs.ts          lo que el YAML nombra y la app registra en código
├── createEngineFromYaml.ts  la raíz de composición
├── located.ts               anteponer archivo y ruta a un error
└── tests/
```

## Reglas que no son obvias

- **El YAML nunca trae funciones.** Acciones, funciones, tools, schemas de input, mappers de
  `onError` (`input`/`report` a partir del error), providers y system prompts se nombran en el YAML
  y se registran en `YamlCatalogs`.
- **Una acción que depende de dónde se usa es un `ActionProvider`** en `catalogs.actions`: una
  función que recibe `{ projectId, agentId?, options }` (las `options` de la entrada del YAML) y
  arma la acción — un board por proyecto, un comentario con el nombre del agente, una shell con
  sus comandos permitidos. Como tool de un agente puede armar varias; como paso, una sola.
- **`allowWrites: true` en un agente** habilita todas sus acciones aunque escriban: listarlas ya
  es la decisión del operador. Sin eso, cada una que escribe lleva `allowWrite: true`.
- **Un paso de agente con `brief` o `when`** es una instancia propia de ese paso (el `brief` se
  antepone al prompt). Sin ellos, el agente es uno por proyecto, compartido.
- **`systemPrompts` del proyecto** van antes de los de cada agente: el prefijo compartido.
- **MCP por id** salen de `catalogs.mcpServers`; un id que no está se omite con un aviso (un
  servidor que no respondió al arrancar) y el agente corre sin él.
- **Un tipo de paso nuevo es una `StepFactory`** en `catalogs.steps`: no se toca el loader.
- **`{ ref: <id> }`** reusa un paso declarado ANTES en el `do` de la misma pipeline (ej. como
  destino de una ruta). Un agente (`{ agent: <id> }`) es uno por proyecto, compartido.
- **Dos momentos de plantilla.** `{{vars.x}}` se sustituye AL CARGAR en cualquier archivo (también
  en un `when`, que no se resuelve al correr); una var que no existe rompe la carga. Las vars salen
  de `project.yaml` sobre `catalogs.projectVars(projectId)`. El resto de los `{{...}}` de `http`,
  `emit` y `function.with` se resuelven AL CORRER contra el payload (en la raíz, como un `when`) y
  `steps` — y `item` dentro de un `forEach`. Un valor que es SÓLO `{{x}}` conserva su tipo.
- **`intake/`** son las pipelines de entrada del proyecto: ven el evento antes del `when` del
  proyecto. Son las que convierten un evento crudo (un webhook) en los que escuchan `pipelines/`
  — con scope, para que corran como ejecución de su task.
- **Un paso `http` con `connection`** va al host de esa conexión (`catalogs.connections`) con su
  credencial; el path tiene que empezar con `/` y no puede cambiar el host. Cada valor que una
  plantilla inserta en el path va con `encodeURIComponent` (no agrega segmentos ni una query) y un
  `.`/`..` se rechaza: lo que trae un webhook no lleva el token a otro endpoint. Un path que es
  entero una plantilla (`http: '{{path}}'`) no carga: el endpoint lo escribe el YAML. La query va en
  `query:`; un path con `?`/`#` falla.
  Sin `connection`, `http` es una URL y no lleva secretos. `graphql` hace el POST y lee `data`
  (con `errors`, falla); `select` es el dot path de lo que queda como output.
- **Una función de catálogo con `with`** recibe esos valores como input: así es pura y sirve en
  cualquier pipeline. Sin `with`, recibe `(ctx, undefined)`.
- **Los errores dicen dónde**: `<archivo>: <ruta del campo>: <qué>` (`located`).
- **Una pausa sobrevive a una recarga** si la pipeline no cambió de forma: el `Checkpoint` compara
  `shape` y falla en vez de seguir en otro paso.

## Antes de commitear

```bash
pnpm --filter @ia-tools/agent-pipeline-yaml typecheck
pnpm --filter @ia-tools/agent-pipeline-yaml test
pnpm --filter @ia-tools/agent-pipeline-yaml build
```
