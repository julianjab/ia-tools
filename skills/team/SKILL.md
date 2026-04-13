---
name: team
description: >
  Levanta un equipo de agentes Claude Code en tmux con roles especializados.
  Claude Code (sesión principal) actúa como orquestador — descompone tareas,
  las asigna a los agentes via archivos, y monitorea el inbox para reaccionar
  cuando terminan o se bloquean.
  Roles: Backend, QA, Researcher (+ Follower bash).
  Úsalo cuando el usuario diga "team", "lanza el equipo", "abre los agentes",
  "inicia tmux", "quiero trabajar con múltiples agentes", o cuando una tarea
  sea suficientemente grande para paralelizarse.
  SIEMPRE usa este skill antes de intentar ejecutar tmux manualmente.
argument-hint: "[session-name] [scope] [--task \"description\"]"
disable-model-invocation: false
---

# Skill: /team — Multi-Agent Development Team

Claude Code (sesión principal) es el orquestador. Lanza agentes en tmux, les
asigna tareas via archivos, y monitorea el inbox para reaccionar inmediatamente
cuando reportan.

---

## Arquitectura

```
Claude Code (orquestador)
    │  asigna tareas via archivo    monitorea inbox en background
    │  tasks/{rol}.task      ←→     .worktrees/.team/inbox
    │
    ├── Pane 0: ⚙️  BACKEND     implementa, reporta al inbox
    ├── Pane 1: 🧪 QA           corre tests, reporta al inbox
    ├── Pane 2: 🔍 RESEARCHER   investiga, reporta al inbox
    └── Pane 3: 📊 FOLLOWER     dashboard bash cada 15s
```

**Regla principal:** Siempre debe haber alguien trabajando. El orquestador
(Claude principal) decide quién trabaja, en qué orden, y en paralelo si es posible.

---

## Step 1 — Parse Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `session-name` | `dev-team` | Nombre de la sesión tmux |
| `scope` | `feature` | Scope corto para nombres de branch y worktree |
| `--task` | _(none)_ | Descripción de la tarea |

---

## Step 2 — Detect Project Context

```bash
ls package.json pyproject.toml Cargo.toml go.mod Makefile 2>/dev/null
cat CLAUDE.md 2>/dev/null | head -20
git worktree list
git branch --show-current
```

---

## Step 3 — Execute Script

```bash
cd <repo-root>
bash /Users/julianbuitrago/.claude/skills/team/scripts/spawn-team.sh <session> <scope> "<task>"
```

El script:
1. Crea worktree para backend en `.worktrees/feat-<scope>-backend/`
2. Escribe contratos de rol en `.worktrees/.team/contracts/`
3. Escribe el plan en `.worktrees/.team/plan.md`
4. Crea sesión tmux con 3 agentes + follower
5. Lanza `claude --dangerously-skip-permissions` en cada pane
6. Envía boot prompt de 1 línea a cada agente (evita "pasted text")
7. Escribe el watcher script en `/tmp/team-inbox-watcher-<session>.sh`

---

## Step 4 — Orquestador: asignar primera tarea

Después de que el script termine, YO (Claude Code) soy el orquestador:

1. **Analizo la tarea** del usuario
2. **Decido quién trabaja primero** — ¿investigación? ¿directo a backend? ¿paralelo?
3. **Asigno la tarea** escribiendo en el task file:
   ```bash
   echo "descripción concreta de la tarea" > .worktrees/.team/tasks/backend.task
   # o researcher primero si necesito investigación
   echo "investiga X en el repo" > .worktrees/.team/tasks/researcher.task
   ```
4. **Inicio el watcher en background** para recibir notificaciones:
   ```bash
   zsh /tmp/team-inbox-watcher-<session>.sh
   ```

---

## Step 5 — Reaccionar a reportes del inbox

Cuando un agente termina o se bloquea, escribe en `.worktrees/.team/inbox`.
El watcher me notifica y yo reacciono:

| Mensaje en inbox | Acción del orquestador |
|-----------------|------------------------|
| `BACKEND DONE: ...` | Leer status/backend.status → asignar QA si corresponde |
| `QA DONE: ...` | Verificar coverage y PR → marcar done o pedir más trabajo |
| `QA FAILED: ...` | Leer fallos → asignar corrección a BACKEND |
| `BACKEND BLOCKED: ...` | Investigar bloqueante → resolver y re-asignar |
| `RESEARCHER DONE: ...` | Usar hallazgos → asignar tarea a BACKEND |

Para asignar siguiente tarea:
```bash
echo "descripción" > .worktrees/.team/tasks/qa.task
```

Para marcar todo como terminado:
```bash
touch .worktrees/.team/done
```

---

## Step 6 — Iniciar watcher en background (SIEMPRE)

```bash
zsh /tmp/team-inbox-watcher-<session>.sh
# run_in_background: true — me notifica cuando hay mensajes
```

---

## Contratos de agentes (resumen)

### Backend
- Implementa código en su worktree
- Usa `/commit` por capa
- Al terminar: escribe status + `echo "BACKEND DONE: ..." >> inbox`
- Si bloqueado: `echo "BACKEND BLOCKED: ..." >> inbox`

### QA
- Corre `make test` y `make test-cover`
- Si verde: `/commit` + push + actualiza PR
- Al terminar: escribe status + `echo "QA DONE: ..." >> inbox`
- Si fallos: `echo "QA FAILED: ..." >> inbox` — NO toca código

### Researcher
- Solo lee y reporta
- Al terminar: escribe status + `echo "RESEARCHER DONE: ..." >> inbox`

### Follower (bash, no Claude)
- Dashboard cada 15s mostrando status files + inbox + commits

---

## Coordinación entre agentes que trabajan en paralelo

Si backend y researcher trabajan al mismo tiempo:
- Cada uno escribe en su propio `tasks/` y `status/`
- Ambos reportan al mismo `inbox`
- El orquestador (yo) gestiona la secuencia según los reportes

---

## Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `CLAUDE_TEAM_OAUTH_TOKEN` | Token OAuth separado para agentes (evita rate limit compartido) |
| `ROLE_BACKEND_NAME` | Nombre custom para el pane backend |
| `ROLE_QA_NAME` | Nombre custom para el pane QA |
| `ROLE_RESEARCHER_NAME` | Nombre custom para el pane researcher |

---

## Error Handling

| Error | Acción |
|-------|--------|
| tmux not installed | Auto-install via brew |
| claude CLI not installed | STOP — decirle al usuario que instale |
| Session ya existe | Kill y recrear |
| Agente no responde en 10 min | Leer status file, re-enviar tarea |
| "Pasted text" en pane | Boot prompt ya es 1 línea — no debería ocurrir |
| Sesión anidada al adjuntar | Usar `tmux switch-client -t <session>` en lugar de attach |
