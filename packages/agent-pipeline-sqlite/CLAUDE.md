# @ia-tools/agent-pipeline-sqlite

`ExecutionRepository` de `@ia-tools/agent-pipeline` sobre SQLite (`node:sqlite`, Node ≥ 22.13):
las ejecuciones pausadas sobreviven a un reinicio. Hace I/O (una base en disco): por eso vive
fuera del core.

## Estructura

```
src/
├── SqliteExecutionRepository.ts  el repositorio: save / delivered / read / live / unread / nextId
├── SqliteExecutionStore.ts       ExecutionStore sobre ese repositorio (+ close)
├── sqliteStoreDriver.ts          el driver `sqlite` para engine.yaml (agent-pipeline-yaml)
├── migrations.ts                 el esquema por versión (PRAGMA user_version)
└── tests/                        el contrato del store + reinicios reales sobre un archivo
```

## Reglas que no son obvias

- **Síncrono a propósito** (`DatabaseSync`): el store ocupa una task en el mismo tick del
  `start`; una escritura asíncrona abriría una ventana en la que otra corrida la vería libre.
- **Un proceso por base.** La exclusión por task y el tope viven en memoria (el
  `ExecutionScheduler` del core). Varias réplicas sobre la misma base necesitarían leases.
- **Al arrancar**, el store recupera lo vivo: pausadas → vuelven a esperar; las que corrían →
  `failed` con `close_reason = 'interrupted'`, y lo que no leyeron sale una sola vez por
  `takeOrphaned()` (el `Engine` lo re-despacha).
- **Migraciones**: una nueva se AGREGA al final de `MIGRATIONS`; nunca se edita una que ya corrió.
- **Ids** de un contador en la base (`exec-N`): no se repiten entre reinicios.
- `node:sqlite` imprime un `ExperimentalWarning` al cargarse.

## Antes de commitear

```bash
pnpm --filter @ia-tools/agent-pipeline-sqlite typecheck
pnpm --filter @ia-tools/agent-pipeline-sqlite test
pnpm --filter @ia-tools/agent-pipeline-sqlite build
```
