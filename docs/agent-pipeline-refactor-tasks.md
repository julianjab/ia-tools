# agent-pipeline — refactor SOLID + data sources

Rama: `feat/github-webhook-payloads`. Un commit por fase (dos: el hook de pre-commit no deja mezclar código y tests). Después de cada fase: borrar lo que
quedó sin uso o implementado en otra clase. Gates por fase: `test`, `typecheck`, `biome check`,
`build` del paquete y `typecheck`/`test` de `examples/` (consumidor real).

Regla del usuario: una clase con comportamiento por archivo (excepción documentada: `BoundAction` en `Action.ts`, por el ciclo ESM).

Decisiones (recomendadas en el plan): `node:sqlite` síncrono · al boot `running` → `failed`
(`interrupted`) + re-despachar lo no leído · un proceso por base · hot reload YAML por `mtime` ·
adaptadores en paquetes aparte.

## F0 — tests de contrato
- [x] `executionStoreContract(makeStore)` en `src/engine/tests/contracts/`
- [x] `pipelineSourceContract(makeSource)`
- [x] correrlos contra `InMemoryExecutionStore`, `StaticPipelineSource`, `Project`
- [x] exportarlos para los paquetes adaptadores (subpath `./testing`)
- [x] commit `test(agent-pipeline): …`

## A1 — partir Engine
- [x] `DispatchPlanner` (plan, select, findCandidate) + `planTag`
- [x] `ExecutionCoordinator` (inject, wake, currentFor, resolveRunning, resumption, expire, wakeLate, wokeLate)
- [x] `Redelivery` (redispatch, redeliver, origins)
- [x] `RunLauncher` (runCandidates, runDetached)
- [x] `contextFor` único y `runAsExecution` único
- [x] tracing: specs apuntan a la clase dueña, nombres de span/log iguales
- [x] Engine = fachada (start, dispatch, tick, select, executions, maxEventDepth)
- [x] limpiar: métodos privados muertos, tipos que ya no se exportan
- [x] commit `refactor(agent-pipeline): …`

## A2 — partir Execution y el store
- [x] `Inbox` (delivered + missed)
- [x] `KeyedQueue`, `Semaphore` en `ExecutionScheduler` (la política `ifPaused` queda en el store: necesita la ejecución viva de la task)
- [x] puerto `ExecutionRepository` + `InMemoryExecutionRepository` (ids `exec-N`)
- [x] `ExecutionJournal`: Execution notifica transiciones y eventos
- [x] `Condition.toRow`, `Pause.toJSON/fromJSON` (sin `EventFilter.toProps`: `Pause` lee `on`/`when` directo)
- [x] `ExecutionStore` como clase (scheduler + repo); `InMemoryExecutionStore` como subclase fina
- [x] rehidratación al construir el store (running → failed interrupted + `takeOrphaned`, paused → vivas); el Engine re-despacha lo huérfano
- [x] limpiar
- [x] commit

## A3 — partir Pipeline
- [x] `PipelineGraph` (reachableAgents, reachablePauses, validate, assertNoCycles, assertPausesResumable), calculado una vez
- [x] `StepRunner` (runStep, runDueStep, errorHandling, runErrorRoute) + `stepTrace`
- [x] `Checkpointing` (pauseAt, findPause, shape)
- [x] matching vía `EventFilter` + scope
- [x] polimorfismo en `Runnable` (`graphTargets`, `kind`) → fuera `instanceof` de Pipeline/tracing
- [x] `StepOutcome` tipado; fuera `ctx.paused`
- [x] limpiar
- [x] commit

## Una clase por archivo
- [x] `Pause.ts`, `InMemoryExecutionStore.ts`, `InMemoryExecutionRepository.ts`, `ActionTool.ts`
- [x] `SubmitTool`/`FailTool` fuera de `Agent.ts` (en A4)

## A4 — partir Agent
- [x] `TurnProtocol` (submit/fail tools, resolve)
- [x] `PromptRenderer` + puerto `SystemPromptCatalog`
- [x] `Toolset`
- [x] `onStart` vía `StepRunner`
- [x] limpiar
- [x] commit

## B1 — YAML (paquete `@ia-tools/agent-pipeline-yaml`)
- [x] schemas zod: project, agent, pipeline, steps, condiciones
- [x] `StepFactoryRegistry` (agent, emit, http, pause, action) + catálogos (actions, tools, mappers, providers)
- [x] `YamlPipelineSource` (un Project por carpeta, caché por mtime, conserva la última versión buena)
- [x] pasa `pipelineSourceContract`; fixture equivalente a un test del engine
- [x] commit `feat(agent-pipeline-yaml): …`

## B2 — SQLite (paquete `@ia-tools/agent-pipeline-sqlite`)
- [x] migraciones (`schema_version`), WAL
- [x] `SqliteExecutionRepository` síncrono
- [x] pasa `executionStoreContract`
- [x] test: pausa → cerrar → reabrir → reanudar
- [x] commit `feat(agent-pipeline-sqlite): …`

## B3 — engine.yaml
- [x] schema de `engine.yaml` (maxEventDepth, executions.driver/path/maxConcurrent, sources, tick)
- [x] `createEngineFromYaml(path, catalogs)` → `{ engine, stop }`
- [x] e2e: sqlite + pausa + reinicio + reanudar
- [x] commit

## Cierre
- [x] actualizar `packages/agent-pipeline/CLAUDE.md` (estructura, ejecuciones, repositorio)
- [x] actualizar `docs/agent-pipeline.mmd`
- [x] repasar exports de `index.ts` (nada muerto)
- [x] `pnpm lint` (0 errores), `pnpm typecheck`, `pnpm build` en el root; tests de los 12 paquetes y de examples
