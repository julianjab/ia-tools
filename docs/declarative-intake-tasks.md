# Intake declarativo — tareas

Objetivo: que el intake de webhooks de `ia-flow/apps/runner-v2` sea YAML. Las lecturas a GitHub
son pasos `http` sobre una conexión con nombre; lo que queda en código son funciones puras y
genéricas (formatear, elegir, armar el payload), nunca una clase por webhook.

Diseño en dos etapas:

1. `intake/<webhook>.yaml` — un webhook crudo (`github.*`) → QUÉ task es (`owner/repo#n`, PR,
   evento a emitir, campos propios) → `emit: task.resolve`.
2. `intake/resolve-task.yaml` — `task.resolve` → lee card, issue, blockers, comentarios, PR y CI
   → emite el evento final con scope `{projectId, repo, issue}`.

## Fase 1 — ia-tools (`agent-pipeline` + `agent-pipeline-yaml`)

- [ ] `Template`: `{{path}}` resuelto al correr contra payload + `steps` (+ `item` en un
      `forEach`). Un string que es SÓLO `{{x}}` conserva el tipo; embebido, se vuelve texto.
- [ ] `vars` del proyecto (`project.yaml` + `YamlCatalogs.projectVars`): `{{vars.x}}` se
      sustituye al CARGAR, en cualquier lugar del YAML (también en `when`). Una var que no
      existe rompe la carga.
- [ ] Carpeta `intake/` del proyecto: pipelines que ven el evento ANTES del `when` del proyecto
      (`PipelineSource.explainMismatch(event, pipeline)`).
- [ ] `HttpAction`: headers async y `fetch` inyectable.
- [ ] Paso `http`: `connection` (catálogo `connections`: base URL + headers + fetch), path/query/
      headers/body en plantilla, `graphql` + `variables`, `select` (dot path). Con conexión,
      el path no puede cambiar el host.
- [ ] Paso `function`: `with` en plantilla, como input de la función.
- [ ] Paso `emit`: tipo/payload/scope en plantilla y `forEach`.
- [ ] Tests de cada pieza.
- [ ] Limpiar lo que quede sin uso; CLAUDE.md de los paquetes.

## Fase 2 — runner-v2 (ia-flow)

- [ ] Catálogo: conexión `github` (token de la App / PAT), funciones puras (`linked_issue`,
      `board_item`, `open_pr`, `task_payload`) y `projectVars` (board, branchPrefix, repos).
- [ ] `.config/projects/lahaus-ai-flow/intake/*.yaml`: projects_v2_item, issue_comment,
      pull_request, pull_request_review, check_suite, workflow_run, unblock, resolve-task.
- [ ] Tests del intake contra la versión YAML (fetch mockeado): mismos payloads que hoy.
- [ ] Borrar `intake.ts`, `actions/intake/*`, `board-reader.ts` y la fuente de código de
      `boot.ts`; `buildPayload` comparte el armado con `task_payload`.
- [ ] README, CLAUDE.md, typecheck + lint + tests.
