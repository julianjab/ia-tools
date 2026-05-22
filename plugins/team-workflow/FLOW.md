# team-workflow — Mapa de flujo del sistema

> Snapshot: 2026-05-22  
> Branch activo: `feat/centralize-events-write` (PRs #113, #114 pendientes)

---

## 1. Arquitectura: 2 roles

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SLACK / TERMINAL                                                           │
│  Mensaje entrante (DM, canal, o /session local)                             │
└────────────────────────────┬────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  MAIN SESSION — router  (claude --agent team-workflow:router)               │
│                                                                             │
│  1. Resolve topic → session_id = sha1(topic)[:12]                          │
│  2. Primer inbound del topic:                                               │
│       bootstrap-topic-state.sh  ──►  $IA_TW_STATE_DIR/{state.md,           │
│                                       messages.md, .current sentinel}       │
│  3. Lee state.md + messages.md (recupera pending_ask, phase, default_repo) │
│  4. Clasifica el mensaje INLINE:                                            │
│                                                                             │
│   ┌──────────┐  pregunta técnica/repo   ┌────────────────────────────────┐ │
│   │ ANSWER   │ ─────────────────────── ► │ Agent(Explore) o              │ │
│   │          │                           │ Agent(general-purpose)+gh     │ │
│   └──────────┘                           └────────────────────────────────┘ │
│                                                                             │
│   ┌──────────┐  necesita confirmación   ┌────────────────────────────────┐ │
│   │ ASK      │ ─────────────────────── ► │ /ask-user + pending_ask       │ │
│   │          │                           │ en state.md frontmatter       │ │
│   └──────────┘                           └────────────────────────────────┘ │
│                                                                             │
│   ┌──────────┐  cambio de código        ┌────────────────────────────────┐ │
│   │ DISPATCH │ ─────────────────────── ► │ /session skill + Bash call    │ │
│   │          │                           │ explícito a start-lead.sh     │ │
│   └──────────┘                           └───────────────┬────────────────┘ │
│                                                          │                  │
│  NUNCA edita archivos fuente.                            │                  │
└──────────────────────────────────────────────────────────┼──────────────────┘
                                                           │ IA_TW_STATE_DIR heredado
                                                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  SUB-SESSION — lead  (claude --agent team-workflow:lead)                    │
│                                                                             │
│  Boot:  Lee $IA_TW_STATE_DIR/state.md + messages.md (NUNCA arranca ciego)  │
│         list_subscriptions → boot guard Slack                               │
│         state.md phase: chatting → planning                                 │
│                                                                             │
│  Plan → aprobación (aprobar/cancelar) → provision → task list → dispatch   │
│                                                                             │
│  Spawns:  impl  (teammate persistente, por repo)                            │
│           qa    (teammate persistente o lead inline)                        │
│           sec   (one-shot por tarea)                                        │
│           arch  (one-shot por tarea)                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Ciclo de vida de un mensaje (happy path)

```
Slack DM: "agrega endpoint GET /demo"
│
├─ [hook] UserPromptSubmit
│     → append-message.sh          escribe en messages.md
│     → detect-user-correction.sh  clasifica con Haiku (¿corrección?)
│
├─ router: primer inbound del topic
│     → bootstrap-topic-state.sh   crea $IA_TW_STATE_DIR/
│          state.md  (phase: chatting)
│          messages.md
│          .current  (sentinel)
│     → /session + start-lead.sh
│
├─ lead boot
│     lee state.md + messages.md
│     pre-análisis via Agent(general-purpose)
│     publica plan en thread
│
├─ usuario: "aprobar"
│     → state.md phase: implementing
│
├─ /worktree init → detect-repo-capabilities.sh
│     Haiku: detecta stack, clasifica agentes impl/qa/sec/arch
│     escribe agents: map en state.md
│
├─ lead crea task list (5 tareas por worktree):
│     P:qa:red → P:impl:green → P:security → P:pr → P:team-review
│
├─ Dispatch loop (paralelo entre worktrees independientes):
│
│   [P:qa:red]
│     qa teammate escribe tests RED
│     TaskUpdate(completed) + marker "✅ RED confirmed for P"
│     [hook] TaskCompleted → enforce-task-invariants.sh verifica marker
│     [hook] TaskCompleted → record-state-event.sh → local_phase: red-confirmed
│
│   [P:impl:green]  (desbloqueado cuando red-confirmed)
│     impl teammate implementa código (N commits TDD)
│     TaskUpdate(completed) + marker "green for P (N commits)"
│     [hook] TaskCompleted → local_phase: green
│
│   [P:security]  (desbloqueado cuando green)
│     one-shot: audit git diff base..HEAD
│     marker "security: APPROVED for P"
│     [hook] TaskCompleted → local_phase: security-approved
│
│   [P:pr]  (desbloqueado cuando security-approved)
│     impl: git push + gh pr create
│     [hook] TaskCompleted → local_phase: pr-open, pr_url: <url>
│
│   [P:team-review]  (desbloqueado cuando pr-open)
│     lead: /team-review skill
│
├─ Todos los worktrees en pr-open → state.md phase: prs-open
│
└─ Merge + cleanup:
      state.md phase: merged
      [hook] SessionEnd → session-end.sh → auto-memory por repo
      [hook] SessionEnd → extract-memory-signal.sh → feedback memory
      [hook] archive-on-merge.sh → copia a $IA_TW_ARCHIVE_DIR
```

---

## 3. Estado compartido: state.md como fuente de verdad

```
$IA_TW_STATE_ROOT/<topic_hash>/
│
├── state.md          ← YAML frontmatter + cuerpo markdown
│   │  topic, session_id, phase, feature, root_dir
│   │  pending_ask, default_repo, last_event_at
│   │  worktrees[]:
│   │    - repo, worktree, branch, wt_prefix
│   │      stack, agents: {impl, qa, sec, arch}
│   │      local_phase, markers[], pr_url
│   │  events[]:
│   │    - ts, kind, subject, wt_prefix, ...
│   │
│   └── Escrito por:
│       • router: bootstrap (phase: chatting)
│       • lead: transitions de phase, worktrees, markers
│       • hooks: local_phase (record-state-event), events (write-event.sh)
│
├── messages.md       ← Log rolling append-only, un bloque por turno
│   │  Formato: ## <iso8601> · <actor>\n\n<texto>\n\n---
│   │
│   └── Escrito SOLO por:
│       • append-message.sh hook (UserPromptSubmit/Stop/SubagentStop/PostToolUse:reply)
│
├── hook-audit.log    ← TaskCreated/TaskCompleted log (append-only)
├── session-env.yaml  ← Snapshot Capa A/B env (sin tokens)
├── .claude/
│   ├── settings.local.json   (envs + additionalDirectories + MCPs)
│   └── agents/               ← $IA_TW_AGENT_LINK_DIR
│       └── <basename>-<agent>.md  (materializados por sync-agents.sh)
└── worktrees/                ← $IA_TW_WORKTREE_ROOT
    └── <basename(repo)>/     git worktree en feature branch
```

---

## 4. Hooks: quién escucha qué

```
┌────────────────────┬──────────────────────────────┬──────────┬──────────────────────────────────────┐
│ Evento Claude Code │ Script                        │ Bloquea  │ Qué hace                             │
├────────────────────┼──────────────────────────────┼──────────┼──────────────────────────────────────┤
│ UserPromptSubmit   │ append-message.sh             │ no       │ Escribe turno user en messages.md    │
│ UserPromptSubmit   │ detect-user-correction.sh     │ no       │ Haiku: ¿pushback/cancel/retract?     │
│                    │                               │          │ → events: user_correction            │
│ Stop               │ append-message.sh             │ no       │ Escribe respuesta del agente         │
│ SubagentStop       │ append-message.sh             │ no       │ Escribe respuesta del sub-agente     │
│ SubagentStop       │ subagent-stop.sh              │ no       │ → events: subagent_run               │
│ PostToolUse:reply  │ append-message.sh             │ no       │ Escribe reply de Slack               │
│ PostToolUse:Edit   │ detect-retract.sh             │ no       │ ¿Marcador RETRACTED en state.md?     │
│                    │                               │          │ → events: marker_retracted           │
│ PostToolUse:Edit   │ detect-plan-edited.sh         │ no       │ ¿state.md editado en plan_approved?  │
│                    │                               │          │ → events: plan_edited                │
│ PostToolUse:Edit   │ detect-repo-capabilities.sh   │ no       │ ¿worktree nuevo en state.md?         │
│                    │                               │          │ Haiku: stack + agents + capabilities │
│                    │                               │          │ → escribe agents: map en state.md    │
│ TaskCreated        │ task-created.sh               │ no       │ Audit log + warn si falta blockedBy  │
│ TaskCreated        │ detect-task-replaced.sh       │ no       │ ¿metadata.replaces?                  │
│                    │                               │          │ → events: task_replaced              │
│ TaskCompleted      │ enforce-task-invariants.sh    │ SÍ (2)   │ Bloquea *:pr sin security APPROVED   │
│                    │                               │          │ Bloquea *:green sin RED confirmed    │
│ TaskCompleted      │ record-state-event.sh         │ no       │ local_phase transition + events:     │
│ TeammateIdle       │ teammate-idle.sh              │ SÍ (2)   │ Bloquea qa sin RED en transcript     │
│                    │                               │          │ Bloquea sec sin verdict              │
│ PreToolUse:Edit    │ enforce-worktree.sh           │ SÍ (2)   │ Bloquea edits en main/master         │
│ SessionStart       │ session-start.sh              │ no       │ Log de arranque                      │
│ SessionEnd         │ session-end.sh                │ no       │ Haiku: sintetiza memory por repo     │
│ SessionEnd         │ extract-memory-signal.sh      │ no       │ events: → feedback_*.md por repo     │
│ SessionEnd         │ archive-on-merge.sh           │ no       │ Copia state dir a $IA_TW_ARCHIVE_DIR │
│ InstructionsLoaded │ instructions-loaded.sh        │ no       │ Log de carga de agente               │
│ PreCompact         │ pre-compact.sh                │ no       │ Snapshot de contexto antes de compact│
├────────────────────┼──────────────────────────────┼──────────┼──────────────────────────────────────┤
│ detect-coverage-   │ (PostToolUse:Edit/Write)      │ no       │ ¿Cobertura por debajo del umbral?    │
│ gate.sh            │                               │          │ → events: coverage_gate_iteration    │
└────────────────────┴──────────────────────────────┴──────────┴──────────────────────────────────────┘

Todos los hooks de events: delegan a lib/write-event.sh (centralizado).
```

---

## 5. Auto-aprendizaje: qué aprende y cómo

```
Durante la sesión (inteligencia continua)
─────────────────────────────────────────
detect-user-correction.sh       Haiku clasifica cada UserPromptSubmit
  → signal: cancel/pushback/    como corrección. Registra en events:
    redirection/rebuttal/...    para uso posterior en SessionEnd.

detect-repo-capabilities.sh     Haiku lee agent descriptions + detecta
  → stack + agents map          stack por manifests (pubspec, pyproject,
                                package.json+UI dep, go.mod, *.tf, etc.)
                                Runs ONCE per worktree (idempotente).

detect-coverage-gate.sh         Detecta iteraciones de cobertura para
  → coverage_gate_iteration     identificar qué repos fallan con frecuencia.

detect-task-replaced.sh         Registra cuándo el lead reemplaza tareas
  → task_replaced               (regresiones del plan, scope creep).

detect-retract.sh               Detecta retractaciones de marcadores
  → marker_retracted            (green que se revocó, security que cambió).


Al cierre de sesión (extracción de memoria)
────────────────────────────────────────────
session-end.sh (SessionEnd, phase=merged)
  Haiku lee:
    • state.md events: block (fuente primaria)
    • Extracto de transcript (head 6KB + tail 4KB, si events < 3)
  Sintetiza 3 tipos de aprendizaje:
    • Aprendido:   insight no-obvio validado en esta feature
    • Fricción:    qué ralentizó el proceso
    • Próxima vez: cambio conductual concreto
  Escribe:
    <repo>/.claude/agent-memory/<agent>/MEMORY.md  (por cada worktree)
    Abre PR chore/memory-<feature> en cada repo consumer.

extract-memory-signal.sh (SessionEnd, phase=merged|prs-open)
  Lee events: del state.md, filtra:
    user_correction, marker_retracted, task_replaced, coverage_gate_iteration
  Agrupa por repo (via wt_prefix → repo lookup)
  Escribe:
    ~/.claude/projects/<encoded-repo>/memory/feedback_<feature>.md
    ~/.claude/projects/<encoded-root-dir>/memory/feedback_<feature>.md
  Formato: frontmatter (type: feedback) + Rule / Why / How to apply

Los archivos de memoria se cargan automáticamente en sesiones futuras
via "memory: project" en los agent .md files.
```

---

## 6. Qué está roto (bugs conocidos)

### B1 — state.md stale entre features del mismo DM topic ⚠️

**Problema:** El `topic_hash` = `sha1(IA_TW_TOPIC)[:12]` es el mismo para toda la vida del canal DM. Si el lead termina una feature con `phase: merged` y el usuario pide una feature nueva en el mismo DM, el router ve `phase: merged` en el state.md anterior. El nuevo lead puede confundirse al arrancar.

**Efecto:** Lead puede saltar el flow de plan/approval asumiendo que ya hay worktrees.

**Fix pendiente:** Reset de state.md al arrancar nueva feature (fase `chatting` con `worktrees: []` limpio) cuando phase = merged/closed/stopped. O sub-directorios por feature dentro del topic hash.

---

### B2 — UserPromptSubmit no dispara para notificaciones Slack vía MCP ⚠️

**Problema:** Los mensajes Slack entran por `notifications/claude/channel` (notificación MCP), no por `UserPromptSubmit`. El hook `append-message.sh` en modo `user-prompt` puede no capturar el inbound Slack original en messages.md.

**Observación empírica:** En una prueba en vivo el mensaje SÍ apareció en messages.md, pero no se verificó si fue por `UserPromptSubmit` genuino o por otro hook path.

**Efecto:** messages.md puede tener gaps en el historial de mensajes Slack entrantes.

**Fix pendiente:** Verificar con `CLAUDE_CODE_DEBUG=1` si UserPromptSubmit se dispara para notificaciones MCP. Si no, agregar una ruta de captura en el `claim_message` PostToolUse hook.

---

### B3 — Posible doble-escritura en messages.md para respuestas del router ⚠️

**Problema:** La respuesta del agente puede llegar tanto por `Stop` (agente principal) como por `PostToolUse:reply` (si el agente usó la tool `reply` de slack-bridge). Ambos eventos ejecutan `append-message.sh`. Si una respuesta llega por ambos caminos en el mismo turno, se escribe dos veces.

**Efecto:** messages.md con entradas duplicadas para el mismo turno del router.

**Fix pendiente:** Deduplicación en append-message.sh: guardar hash(turno) y saltar si ya existe.

---

### B4 — Plugin cache: Claude Code lee v1.5.0, no el código en desarrollo 🔧

**Problema:** Claude Code lee agentes/hooks de `~/.claude/plugins/cache/ia-tools/team-workflow/<version>/`. El código en `ia-tools/` no se usa hasta que se publica una nueva versión y se re-instala el plugin.

**Workaround actual:** `rsync` manual del directorio al cache + editar `installed_plugins.json` para apuntar a la versión nueva.

**Fix pendiente:** Hacer que el cache apunte al directorio de desarrollo vía symlink o variable de entorno `CLAUDE_PLUGIN_DEV_PATH`.

---

### B5 — Sentinel `.current` acoplado a un solo topic activo

**Problema:** `bootstrap-topic-state.sh` escribe `$IA_TW_STATE_ROOT/.current` con la ruta del state dir actual. Si hay dos topics activos simultáneamente (dos DMs distintos, o DM + canal), el último en bootstrapearse sobreescribe el sentinel, y los hooks del primer topic leen el state dir equivocado.

**Efecto:** messages.md del topic A recibe mensajes del topic B si ambos están activos al mismo tiempo.

**Fix pendiente:** El sentinel debería ser por-proceso (usar `$PPID` o session ID de Claude Code) en lugar de global.

---

## 7. Qué no está claro (ambigüedades)

### A1 — Quién hace cleanup del team cuando lead resumes

Lead.md dice "clean up the team" al final. Pero si el lead se reinicia (resume), los teammates previos no existen. El resume path en lead.md dice "re-spawn the team from scratch", pero no hay lógica clara para saber si el team ya fue limpiado en la sesión anterior o no. Si phase=merged, ¿se limpió? ¿O el crash ocurrió antes del cleanup?

---

### A2 — messages.md ownership vs state.md events:

`messages.md` = log human-readable de conversación (quién dijo qué, en orden).  
`state.md events:` = log estructurado YAML de eventos del sistema (task_completed, user_correction, etc.).

La separación es correcta, pero no está documentada explícitamente en ningún lugar. Los agentes que leen ambos archivos podrían confundir uno con otro. El lead.md boot procedure dice "read state.md + messages.md" sin explicar para qué sirve cada uno.

---

### A3 — `detect-repo-capabilities.sh` y timing de `sync-agents.sh`

La secuencia es:
1. Lead escribe worktree entry en state.md (Edit)
2. `detect-repo-capabilities.sh` dispara (PostToolUse:Edit) y escribe `agents:` map
3. Lead lee el entry de vuelta para consumir `agents:`

Pero `sync-agents.sh` (que materializa los archivos .md en `$IA_TW_AGENT_LINK_DIR`) se ejecuta en un path separado. No está claro si sync-agents corre **antes** de que lead intente hacer `Agent(subagent_type="<basename>-<agent>", ...)`. Si no corrió, el spawn falla con "Agent type not found".

---

### A4 — `qa: skipped` marker para infra vs omitir P:qa:red

Lead.md dice que cuando `stack == infra`, se omite la tarea `P:qa:red` **y** se escribe el literal `qa: skipped for <P>` en markers. Pero enforce-task-invariants.sh busca `✅ RED confirmed for <P>` O `qa: skipped for <P>`. Si el lead olvida el marker de skip, la tarea `P:impl:green` se bloquea aunque no haya tarea qa.

La documentación de lead.md dice "Do NOT leave the marker out" pero no hay hook que lo recuerde/fuerce al momento de crear las tareas.

---

### A5 — ¿Qué pasa si lead no tiene CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS?

Lead.md tiene una tabla de error handling: si la variable no está seteada, "fall back to one-shot Agent() for every owner; warn the user". Pero el fallback a one-shot para `impl` significa perder los `TeammateIdle` callbacks, y la lógica de dispatch del lead asume persistencia. El comportamiento degradado no está probado.

---

## 8. PRs pendientes en este branch

| PR | Branch | Qué hace | Estado |
|----|--------|----------|--------|
| #113 | `fix/strip-channel-envelope` | append-message.sh: strip `<channel>` envelope + usa `.agent_name` en lugar de `subagent` | Abierto, pendiente merge |
| #114 | `feat/centralize-events-write` | lib/write-event.sh + 8 hooks refactorizados (detect-task-replaced, detect-user-correction, detect-plan-edited, detect-coverage-gate, detect-retract, detect-repo-capabilities, subagent-stop, record-state-event) | Abierto, pendiente merge |

---

## 9. Flujo resumido de un evento `events:` (post-PR #114)

```
Cualquier hook que quiere escribir en events:
       │
       ├── construye JSON: { kind, subject, wt_prefix, ...extras }
       │
       └── pipe → lib/write-event.sh
                    │
                    ├── valida JSON + extrae .kind
                    ├── auto-fill .ts si ausente
                    ├── resuelve $IA_TW_STATE_DIR (o sentinel .current)
                    ├── renderiza bloque YAML via jq (conservative quoting)
                    └── awk inserta en state.md frontmatter events:
                          Casos:
                          (a) events: con entradas previas → append al final
                          (b) events: vacío (multi-line) → append directo
                          (c) events: [] (inline) → rewrite + append
                          (d) events: ausente → insert antes del --- de cierre
```

---

## 10. Diagrama de transiciones de fase

```
                 bootstrap
                    │
                    ▼
 router           chatting
                    │
                    │  /session → lead boot
                    ▼
                 planning ─────── cancelar ──────► stopped
                    │
                    │  aprobar
                    ▼
              implementing
                    │
                    │  todos los worktrees local_phase=pr-open
                    ▼
               prs-open
                    │
                    │  todos los PRs merged
                    ▼
                 merged
                    │
                    │  (algún PR closed sin merge)
                    ├────────────────────────────► closed
                    │
                    ▼
              [SessionEnd hooks disparan]
              session-end.sh → memory por repo
              extract-memory-signal.sh → feedback memory
              archive-on-merge.sh → archive dir
```

---

*Para ver el código de cada componente:*

| Componente | Path |
|------------|------|
| Router | `agents/router.md` |
| Lead | `agents/lead.md` |
| Implementer (fallback) | `agents/implementer.md` |
| bootstrap-topic-state.sh | `skills/router/scripts/bootstrap-topic-state.sh` |
| start-lead.sh | `skills/session/scripts/start-lead.sh` |
| append-message.sh | `hooks/scripts/bookkeeping/append-message.sh` |
| write-event.sh | `hooks/scripts/lib/write-event.sh` |
| detect-repo-capabilities.sh | `hooks/scripts/intelligence/detect-repo-capabilities.sh` |
| session-end.sh | `hooks/scripts/intelligence/session-end.sh` |
| extract-memory-signal.sh | `hooks/scripts/intelligence/extract-memory-signal.sh` |
| enforce-task-invariants.sh | `hooks/scripts/enforcement/enforce-task-invariants.sh` |
| hooks.json | `hooks/hooks.json` |
