---
name: team
description: >
  Levanta un equipo de agentes Claude Code en tmux con roles especializados.
  Cada agente trabaja en su propio worktree para desarrollo paralelo real.
  Roles alineados con AGENTS.md: Orchestrator, Backend, Frontend, QA.
  El orchestrator coordina y los agentes usan /commit, /review, /pr.
  Úsalo cuando el usuario diga "team", "lanza el equipo", "abre los agentes",
  "inicia tmux", "quiero trabajar con múltiples agentes", o cuando una tarea
  sea suficientemente grande para paralelizarse.
  SIEMPRE usa este skill antes de intentar ejecutar tmux manualmente.
argument-hint: "[session-name] [--roles orchestrator,backend,qa] [--task \"description\"]"
disable-model-invocation: false
---

# Skill: /team — Multi-Agent Development Team

Lanza un equipo de agentes Claude Code en tmux, cada uno con un rol especializado y su propio worktree. Los agentes usan los skills del ecosistema (`/worktree`, `/commit`, `/review`, `/pr`) para coordinarse.

---

## Step 1 — Parse Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `session-name` | `dev-team` | Nombre de la sesión tmux |
| `--roles` | `orchestrator,backend,qa` | Roles a levantar (comma-separated) |
| `--task` | _(none)_ | Descripción de la tarea — el orchestrator la recibe al inicio |

### Available Roles

| Role | Pane Title | Domain | Skills Available |
|------|-----------|--------|-----------------|
| `orchestrator` | ORCHESTRATOR | Acceso total — coordina, NO escribe código | All skills, delegates tasks |
| `backend` | BACKEND | Backend code: APIs, services, adapters, domain | `/commit`, `/review` |
| `frontend` | FRONTEND | Frontend code: components, composables, stores | `/commit`, `/review` |
| `qa` | QA | Tests, lint, coverage, git ops, PRs (combines QA Tester + Code Reviewer from AGENTS.md) | `/commit`, `/review`, `/pr`, `/ship` |
| `architect` | ARCHITECT | Design, ADRs, no code | Read-only + write for docs |
| `researcher` | RESEARCHER | Investigation, docs, APIs | Read-only + web search |

Default team: `orchestrator,backend,qa` (3 panes). Max recommended: 4 panes.

**Note on roles**: AGENTS.md defines 7 specialized roles. For the tmux team, some are consolidated to keep pane count manageable: `qa` combines QA Tester + Code Reviewer (handles both tests and PRs). For larger tasks, add `architect` or `researcher` as a 4th pane.

---

## Step 2 — Detect Project Context

Before launching, gather project info:

```bash
# Detect stack
ls package.json pyproject.toml Cargo.toml go.mod Makefile 2>/dev/null

# Detect commands
cat Makefile 2>/dev/null | grep -E '^[a-z]+:' | head -10

# Check for CLAUDE.md
cat CLAUDE.md 2>/dev/null | head -20

# Check active worktrees
git worktree list

# Check current branch
git branch --show-current
```

If `CLAUDE.md` doesn't exist, **do not create one** — that's the project's responsibility. Warn the user instead.

---

## Step 3 — Create Worktrees for Each Agent

**Key insight**: Each coding agent (backend, frontend) gets its own worktree so they can work on different parts of the code simultaneously without conflicts.

For each coding role, create a worktree:

```bash
# Use /worktree init for each agent's branch
/worktree init feat/<task-scope>-backend    # → _worktrees/feat-<task-scope>-backend/
/worktree init feat/<task-scope>-frontend   # → _worktrees/feat-<task-scope>-frontend/
```

**Worktree assignment:**

| Role | Worktree | Why |
|------|----------|-----|
| `orchestrator` | Main repo (stays on `main`) | Coordinates, reads all code, doesn't write |
| `backend` | `_worktrees/feat-<scope>-backend/` | Isolated backend changes |
| `frontend` | `_worktrees/feat-<scope>-frontend/` | Isolated frontend changes |
| `qa` | Can switch between worktrees | Runs tests in each worktree, creates PRs |
| `architect` | Main repo | Reviews design, writes ADRs |
| `researcher` | Main repo | Read-only investigation |

If `--task` is provided, derive the scope from the task description. Otherwise, ask the user.

---

## Step 4 — Execute tmux Script

```bash
bash scripts/spawn-team.sh <session-name>
```

The script creates the tmux session with the appropriate layout and launches `claude` in each pane.

**Tmux layout (for 4 agents):**

```
┌─────────────────┬──────────────────┐
│  ORCHESTRATOR   │  BACKEND AGENT   │
│    (Pane 0)     │    (Pane 1)      │
├─────────────────┼──────────────────┤
│  QA AGENT       │  (available)     │
│    (Pane 2)     │    (Pane 3)      │
└─────────────────┴──────────────────┘
```

**For 3 agents** (default):
```
┌─────────────────────────────────────┐
│          ORCHESTRATOR (Pane 0)      │
├──────────────────┬──────────────────┤
│  BACKEND (Pane 1)│    QA (Pane 2)   │
└──────────────────┴──────────────────┘
```

---

## Step 5 — Send Initial Prompts to Each Agent

After tmux is running, send role-specific initial prompts:

### Orchestrator
```
You are the ORCHESTRATOR. Read CLAUDE.md and AGENTS.md.
Your job: coordinate the team, decompose tasks, delegate to backend/frontend/qa.
NEVER write code directly.

Available team:
- Backend Agent (Pane 1): working in _worktrees/feat-<scope>-backend/
- QA Agent (Pane 2): runs tests, creates PRs

Skills: /worktree status (see all worktrees), /deliver (full pipeline)

Task: <task description if provided>
```

### Backend Agent
```
You are the BACKEND ENGINEER. Read CLAUDE.md.
Your domain: backend code — APIs, services, adapters, domain models.
Working directory: _worktrees/feat-<scope>-backend/

Detect the project stack first (see shared/stack-detection.md).

Rules:
- Max 200 lines per new file
- Use /commit for checkpoints (conventional commits)
- Do NOT write tests (QA agent handles that)
- Do NOT make architecture decisions (ask orchestrator)
- Run /review before telling QA to test

Wait for tasks from the orchestrator.
```

### Frontend Agent
```
You are the FRONTEND ENGINEER. Read CLAUDE.md.
Your domain: frontend code — components, composables, stores, styles.
Working directory: _worktrees/feat-<scope>-frontend/

Detect the project stack first (see shared/stack-detection.md).

Rules:
- Follow the project's frontend conventions (from CLAUDE.md / rules/)
- Use /commit for checkpoints
- Do NOT write tests (QA agent handles that)
- Run /review before telling QA to test

Wait for tasks from the orchestrator.
```

### QA Agent
```
You are the QA ENGINEER. Read CLAUDE.md.
Your job: generate tests, run tests, verify coverage, create PRs.

Detect the project stack first (see shared/stack-detection.md) to know which
test framework and commands to use.

Workflow:
1. When backend/frontend finishes a phase → switch to their worktree
2. Run /review to validate quality (fmt + tests + coverage + rules)
3. If tests are missing, create them using the project's test framework
4. When ready → run /pr to push and create the PR
5. After PR → run /ship to notify the team

Skills: /review, /pr, /ship, /worktree switch, /commit

You can work across all worktrees. Use /worktree status to see what's active.
Wait for tasks from the orchestrator.
```

### Architect
```
You are the ARCHITECT. Read CLAUDE.md and AGENTS.md.
Your job: system design, ADRs, API design, component boundaries.
Do NOT write implementation code — only design documents and ADRs.
Wait for design questions from the orchestrator.
```

### Researcher
```
You are the RESEARCHER. Read CLAUDE.md.
Your job: investigate codebases, docs, APIs, external resources.
Report findings to the orchestrator.
Wait for investigation requests.
```

---

## Step 6 — Confirm to User

```
Team active in tmux (session: <session-name>)

  Pane 0 → Orchestrator  (main repo — coordinates)
  Pane 1 → Backend Agent  (_worktrees/feat-<scope>-backend/)
  Pane 2 → QA Agent       (cross-worktree — tests + PRs)

Worktrees created:
  _worktrees/feat-<scope>-backend/ → feat/<scope>-backend

Navigation:
  Ctrl+b → arrows    Switch between panes
  Ctrl+b → z         Zoom into a pane
  Ctrl+b → d         Detach (session keeps running)
  tmux attach -t <session-name>   Reconnect

Agent workflow:
  Orchestrator decomposes task → delegates to Backend/Frontend
  Backend/Frontend use /commit for checkpoints
  QA runs /review + /pr when phase is complete
  QA runs /ship to notify team after CI passes
```

---

## Coordination Protocol

### How Agents Communicate

Since tmux panes are independent Claude instances, coordination happens through:

1. **Shared git state**: Agents commit to their worktrees. Other agents can see commits via `git log`.
2. **File-based signals**: Orchestrator can write a `_worktrees/.tasks.md` file that agents check.
3. **Worktree status**: Any agent can run `/worktree status` to see what's happening.
4. **PR comments**: QA creates PRs, other agents can review via `gh pr view`.

### Task Flow

```
Orchestrator: "Backend, implement NotificationPort in your worktree"
  ↓
Backend: implements in _worktrees/feat-x-backend/ → /commit → /commit → "Done"
  ↓
Orchestrator: "QA, review and test backend's work"
  ↓
QA: /worktree switch feat-x-backend → /review → creates tests → /pr
  ↓
QA: /ship → Slack notification
  ↓
Orchestrator: "Backend worktree merged. /worktree cleanup feat-x-backend"
```

### Merge Strategy for Multiple Worktrees

When backend and frontend work in separate worktrees:
1. Each creates its own PR from its own branch
2. PRs are merged independently (smaller, focused PRs)
3. If they need to be combined, QA can create a final integration branch

---

## Error Handling

| Error | Action |
|-------|--------|
| tmux not installed | Auto-install via brew/apt/dnf |
| `claude` CLI not installed | STOP — tell user to install |
| Session already exists | Kill and recreate (with warning) |
| Worktree creation fails | Report error, continue with remaining agents |
| Agent crashes in a pane | User can restart with: `tmux send-keys -t <pane> 'claude' Enter` |

## Important Rules

- **Orchestrator NEVER writes code** — only coordinates
- **Each coding agent gets its own worktree** — no shared working directories
- **QA is the only agent that runs `/pr` and `/ship`** — other agents just `/commit`
- **All agents use project skills** (`/commit`, `/review`, `/pr`) — never raw git commands
- **Worktrees are cleaned up after merge** — use `/worktree cleanup --merged`
- **If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set**, orchestrator can use `/spawn` for direct delegation
