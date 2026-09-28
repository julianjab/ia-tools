# @ia-tools/agent-pipeline-yaml

Proyectos, agentes y pipelines de `@ia-tools/agent-pipeline` escritos en YAML, y el `Engine`
armado desde un `engine.yaml`. Hace I/O (lee archivos): por eso vive fuera del core.

## Qué es este paquete

- **`YamlPipelineSource`** — un `PipelineSource` por carpeta de proyecto, leído en vivo: el engine
  llama `list()` en cada evento y, si cambió algún archivo (fecha, tamaño, uno nuevo o borrado), se
  recarga. Una versión inválida se loguea y sigue la última buena; la primera carga tira.
- **`createEngineFromYaml`** — la raíz de composición: lee `engine.yaml`, arma fuentes, store y
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
├── YamlCatalogs.ts          lo que el YAML nombra y la app registra en código
├── createEngineFromYaml.ts  la raíz de composición
├── located.ts               anteponer archivo y ruta a un error
└── tests/
```

## Reglas que no son obvias

- **El YAML nunca trae funciones.** Acciones, funciones, tools, schemas de input, mappers de
  `onError` (`input`/`report` a partir del error), providers y system prompts se nombran en el YAML
  y se registran en `YamlCatalogs`.
- **Un tipo de paso nuevo es una `StepFactory`** en `catalogs.steps`: no se toca el loader.
- **`{ ref: <id> }`** reusa un paso declarado ANTES en el `do` de la misma pipeline (ej. como
  destino de una ruta). Un agente (`{ agent: <id> }`) es uno por proyecto, compartido.
- **Los errores dicen dónde**: `<archivo>: <ruta del campo>: <qué>` (`located`).
- **Una pausa sobrevive a una recarga** si la pipeline no cambió de forma: el `Checkpoint` compara
  `shape` y falla en vez de seguir en otro paso.

## Antes de commitear

```bash
pnpm --filter @ia-tools/agent-pipeline-yaml typecheck
pnpm --filter @ia-tools/agent-pipeline-yaml test
pnpm --filter @ia-tools/agent-pipeline-yaml build
```
