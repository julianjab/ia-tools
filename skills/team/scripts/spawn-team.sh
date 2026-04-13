#!/usr/bin/env zsh
# =============================================================================
# spawn-team.sh — Equipo de agentes Claude Code
# El orquestador es la sesión principal de Claude Code (no un pane separado).
# Los agentes reportan escribiendo al inbox → el orquestador recibe notificación.
# Uso: zsh scripts/spawn-team.sh [session] [scope] [task-description]
# Ej:  zsh scripts/spawn-team.sh dev-team feedback "implement message feedback API"
# =============================================================================
set -e

SESSION="${1:-dev-team}"
SCOPE="${2:-feature}"
TASK_DESC="${3:-No task description provided}"
REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { echo -e "${CYAN}▶${RESET} $1"; }
ok()   { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET} $1"; }
die()  { echo -e "${RED}✗ ERROR:${RESET} $1"; exit 1; }

ROLE_BACKEND="${ROLE_BACKEND_NAME:-⚙️  BACKEND · ${SCOPE}}"
ROLE_QA="${ROLE_QA_NAME:-🧪 QA · ${SCOPE}}"
ROLE_RESEARCHER="${ROLE_RESEARCHER_NAME:-🔍 RESEARCHER · ${SCOPE}}"
ROLE_FOLLOWER="📊 FOLLOWER"

echo -e "\n${BOLD}Claude Code — Agent Team${RESET}"
echo "────────────────────────────────────────────────"
echo -e "  Task:    ${CYAN}${TASK_DESC}${RESET}"
echo -e "  Session: ${CYAN}${SESSION}${RESET}"
echo -e "  Orquestador: sesión principal de Claude Code\n"

# ── 1. Dependencias ──────────────────────────────────────────────────────────
log "Verificando dependencias..."
command -v tmux &>/dev/null || die "tmux no instalado"
# Buscar claude en paths conocidos si no está en PATH
if ! command -v claude &>/dev/null; then
  for p in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" "/usr/local/bin/claude"; do
    [ -x "$p" ] && { export PATH="$(dirname $p):$PATH"; break; }
  done
fi
command -v claude &>/dev/null || die "claude CLI no instalado (buscado en PATH y ~/.claude/local/)"
ok "tmux + claude OK"

# ── 2. Token + comando claude ─────────────────────────────────────────────────
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
AGENT_TOKEN="${CLAUDE_TEAM_OAUTH_TOKEN:-$CLAUDE_CODE_OAUTH_TOKEN}"
if [ -n "$AGENT_TOKEN" ]; then
  CLAUDE_CMD="CLAUDE_CODE_OAUTH_TOKEN=$AGENT_TOKEN claude --dangerously-skip-permissions"
  ok "Token OAuth separado + bypass permissions ON"
else
  CLAUDE_CMD="claude --dangerously-skip-permissions"
  warn "Sin CLAUDE_TEAM_OAUTH_TOKEN — usando cuenta principal (riesgo de rate limit)"
fi

# ── 3. Matar sesión previa ────────────────────────────────────────────────────
tmux has-session -t "$SESSION" 2>/dev/null && {
  warn "Sesión '$SESSION' existe. Eliminando..."
  tmux kill-session -t "$SESSION"
}

# ── 4. Worktree para backend ──────────────────────────────────────────────────
cd "$REPO"
WORKTREE_DIR=".worktrees"
mkdir -p "$WORKTREE_DIR"
grep -qxF '.worktrees/' .gitignore 2>/dev/null || printf '\n# Git worktrees (created by /team skill)\n.worktrees/\n' >> .gitignore

BACKEND_BRANCH="feat/${SCOPE}-backend"
BACKEND_DIR="$REPO/${WORKTREE_DIR}/feat-${SCOPE}-backend"

git fetch origin 2>/dev/null || true
BASE="main"
git rev-parse --verify "origin/$BASE" &>/dev/null || BASE="master"

if [ ! -d "$BACKEND_DIR" ]; then
  git worktree add -b "$BACKEND_BRANCH" "$BACKEND_DIR" "origin/$BASE" 2>/dev/null || \
    git worktree add "$BACKEND_DIR" "$BACKEND_BRANCH" 2>/dev/null || \
    warn "Worktree ya existe"
  ok "Worktree: $BACKEND_DIR"
else
  ok "Worktree ya existe: $BACKEND_DIR"
fi

# ── 5. Directorio de coordinación ────────────────────────────────────────────
TEAM_DIR="$REPO/.worktrees/.team"
mkdir -p "$TEAM_DIR/tasks" "$TEAM_DIR/status" "$TEAM_DIR/contracts" "$TEAM_DIR/scripts"

# Inbox — stream de eventos que el orquestador (Claude principal) monitorea
INBOX="$TEAM_DIR/inbox"
> "$INBOX"           # reset al inicio
rm -f "$TEAM_DIR/done"  # limpiar señal de run anterior

cat > "$TEAM_DIR/plan.md" << PLAN
# Team Plan
**Task:** ${TASK_DESC}
**Scope:** ${SCOPE}
**Repo:** ${REPO}
**Backend worktree:** ${BACKEND_DIR}
**Session:** ${SESSION}
**Started:** $(date '+%Y-%m-%d %H:%M:%S')

## Arquitectura de coordinación
- ORQUESTADOR: sesión principal de Claude Code (NO es un pane del tmux)
  Asigna tareas escribiendo en tasks/{rol}.task
  Monitorea el inbox: ${INBOX}

- AGENTES (panes tmux): backend, qa, researcher
  Reciben tareas leyendo tasks/{rol}.task
  Reportan escribiendo al inbox cuando terminan o se bloquean

## Roles
- BACKEND (pane 0): implementa código. NUNCA corre tests ni hace PR.
- QA (pane 1): corre tests y reporta. NUNCA modifica código de producción.
- RESEARCHER (pane 2): investiga y reporta. NUNCA escribe código.
PLAN

ok "Plan escrito: $TEAM_DIR/plan.md"

# ── 6. Contratos de rol ───────────────────────────────────────────────────────
log "Escribiendo contratos..."

cat > "$TEAM_DIR/contracts/backend.md" << CONTRACT
# BACKEND CONTRACT

## Tu identidad
Eres el BACKEND ENGINEER. Implementas código. NUNCA corres tests ni haces PR.

## Reglas absolutas
- NUNCA corras tests
- NUNCA hagas git push ni crees PR
- SIEMPRE usa /commit después de cada capa implementada

## Cómo recibir tu tarea
Espera hasta que exista y tengas contenido en:
  ${TEAM_DIR}/tasks/backend.task

## Cuando termines — OBLIGATORIO
1. make fmt
2. /commit con mensaje convencional
3. Escribe estado en status file:
   echo "DONE: [resumen de lo que implementaste]" > ${TEAM_DIR}/status/backend.status
4. Notifica al orquestador via inbox:
   echo "BACKEND DONE: [resumen de una línea]" >> ${TEAM_DIR}/inbox
5. rm ${TEAM_DIR}/tasks/backend.task
6. Espera la siguiente tarea

## Si estás bloqueado
1. echo "BLOCKED: [problema]" > ${TEAM_DIR}/status/backend.status
2. echo "BACKEND BLOCKED: [problema en una línea]" >> ${TEAM_DIR}/inbox
CONTRACT

cat > "$TEAM_DIR/contracts/qa.md" << CONTRACT
# QA CONTRACT

## Tu identidad
Eres el QA ENGINEER. Corres tests y reportas. NUNCA modificas código de producción.

## Reglas absolutas
- NUNCA modifiques archivos fuera de tests/
- NUNCA corrijas un test cambiando código de producción
- Si hay fallos → reporta y espera que BACKEND corrija

## Cómo recibir tu tarea
Espera hasta que exista:
  ${TEAM_DIR}/tasks/qa.task

## Cuando termines — OBLIGATORIO
1. make test — todos deben pasar
2. make test-cover — verifica coverage
3. Si todo verde: /commit + push + actualiza PR existente
4. echo "DONE: [N tests, coverage X%, PR #NNN actualizado]" > ${TEAM_DIR}/status/qa.status
5. echo "QA DONE: [N tests, coverage X%, PR #NNN actualizado]" >> ${TEAM_DIR}/inbox
6. rm ${TEAM_DIR}/tasks/qa.task

## Si hay fallos de tests
1. echo "FAILED: [output exacto de los fallos]" > ${TEAM_DIR}/status/qa.status
2. echo "QA FAILED: [descripción breve]" >> ${TEAM_DIR}/inbox
3. NO toques código de producción — espera instrucción del orquestador

## Si estás bloqueado
1. echo "BLOCKED: [problema]" > ${TEAM_DIR}/status/qa.status
2. echo "QA BLOCKED: [problema]" >> ${TEAM_DIR}/inbox
CONTRACT

cat > "$TEAM_DIR/contracts/researcher.md" << CONTRACT
# RESEARCHER CONTRACT

## Tu identidad
Eres el RESEARCHER. Investigas y reportas. NUNCA escribes código de producción.

## Reglas absolutas
- NUNCA modifiques archivos del proyecto
- SOLO lee, analiza y reporta con precisión (nombres exactos, tipos, estructuras)

## Cómo recibir tu tarea
Espera hasta que exista:
  ${TEAM_DIR}/tasks/researcher.task

## Cuando termines — OBLIGATORIO
1. echo "DONE: [hallazgos detallados]" > ${TEAM_DIR}/status/researcher.status
2. echo "RESEARCHER DONE: [resumen de una línea]" >> ${TEAM_DIR}/inbox

## Si estás bloqueado
1. echo "BLOCKED: [problema]" > ${TEAM_DIR}/status/researcher.status
2. echo "RESEARCHER BLOCKED: [problema]" >> ${TEAM_DIR}/inbox
CONTRACT

# Inicializar status files
echo "IDLE" > "$TEAM_DIR/status/backend.status"
echo "IDLE" > "$TEAM_DIR/status/qa.status"
echo "IDLE" > "$TEAM_DIR/status/researcher.status"

ok "Contratos escritos — agentes reportan via inbox"

# ── 7. Crear sesión tmux ──────────────────────────────────────────────────────
log "Creando sesión tmux '$SESSION'..."

# 3 panes de agentes + follower abajo
tmux new-session -d -s "$SESSION" -c "$REPO" -x 220 -y 60
tmux split-window -h -t "$SESSION:0.0"
tmux split-window -h -t "$SESSION:0.1"
tmux select-layout -t "$SESSION" even-horizontal
tmux split-window -v -t "$SESSION:0" -l 12

tmux set-option -t "$SESSION" pane-border-status top
tmux set-option -t "$SESSION" pane-border-format " #{pane_title} "
tmux set-option -t "$SESSION" allow-rename off
tmux set-option -t "$SESSION" automatic-rename off

tmux select-pane -t "$SESSION:0.0" -T "$ROLE_BACKEND"
tmux select-pane -t "$SESSION:0.1" -T "$ROLE_QA"
tmux select-pane -t "$SESSION:0.2" -T "$ROLE_RESEARCHER"
tmux select-pane -t "$SESSION:0.3" -T "$ROLE_FOLLOWER"

ok "Layout: 3 agentes + follower"

# ── 8. Lanzar agentes ────────────────────────────────────────────────────────
log "Iniciando agentes (boot prompt = 1 línea)..."

# Backend — su worktree
tmux send-keys -t "$SESSION:0.0" "cd $BACKEND_DIR && $CLAUDE_CMD" Enter
sleep 3
tmux send-keys -t "$SESSION:0.0" "Read $TEAM_DIR/contracts/backend.md and $TEAM_DIR/plan.md then wait for your task in $TEAM_DIR/tasks/backend.task" Enter

# QA — worktree
tmux send-keys -t "$SESSION:0.1" "cd $BACKEND_DIR && $CLAUDE_CMD" Enter
sleep 3
tmux send-keys -t "$SESSION:0.1" "Read $TEAM_DIR/contracts/qa.md and $TEAM_DIR/plan.md then wait for your task in $TEAM_DIR/tasks/qa.task" Enter

# Researcher — repo principal
tmux send-keys -t "$SESSION:0.2" "cd $REPO && $CLAUDE_CMD" Enter
sleep 3
tmux send-keys -t "$SESSION:0.2" "Read $TEAM_DIR/contracts/researcher.md and $TEAM_DIR/plan.md then wait for your task in $TEAM_DIR/tasks/researcher.task" Enter

ok "3 agentes iniciados"

# ── 9. Follower — bash puro, dashboard cada 15s ───────────────────────────────
log "Iniciando FOLLOWER (bash puro)..."

cat > "$TEAM_DIR/scripts/follower.sh" << FOLLOWER
#!/usr/bin/env zsh
TEAM_DIR="${TEAM_DIR}"
WORKTREE="${BACKEND_DIR}"

while true; do
  clear
  echo "╔══════════════════════════════════════════════════════╗"
  printf "║  📊 TEAM · %-8s · %s                   ║\n" "${SCOPE}" "\$(date '+%H:%M:%S')"
  echo "╠══════════════════════════════════════════════════════╣"
  for role in backend qa researcher; do
    STATUS=\$(cat "\$TEAM_DIR/status/\${role}.status" 2>/dev/null | head -1)
    HAS_TASK=\$([ -f "\$TEAM_DIR/tasks/\${role}.task" ] && echo "▶ TASK" || echo "  —  ")
    case \$role in
      backend)    EMOJI="⚙️ "; LABEL="BACKEND " ;;
      qa)         EMOJI="🧪"; LABEL="QA      " ;;
      researcher) EMOJI="🔍"; LABEL="RESEARCH" ;;
    esac
    printf "║ %s %s │ %-6s │ %-28s ║\n" "\$EMOJI" "\$LABEL" "\$HAS_TASK" "\${STATUS:0:28}"
  done
  echo "╠══════════════════════════════════════════════════════╣"
  echo "║  📬 INBOX (últimos mensajes):                        ║"
  tail -3 "\$TEAM_DIR/inbox" 2>/dev/null | while read line; do
    printf "║    %-49s ║\n" "\${line:0:49}"
  done
  echo "╠══════════════════════════════════════════════════════╣"
  git -C "\$WORKTREE" log --oneline -3 2>/dev/null | while read line; do
    printf "║  📝 %-48s ║\n" "\${line:0:48}"
  done
  if [ -f "\$TEAM_DIR/done" ]; then
    echo "╠══════════════════════════════════════════════════════╣"
    echo "║  ✅  TEAM DONE — listo para revisión                 ║"
    echo "╚══════════════════════════════════════════════════════╝"
    exit 0
  fi
  echo "╚══════════════════════════════════════════════════════╝"
  sleep 15
done
FOLLOWER
chmod +x "$TEAM_DIR/scripts/follower.sh"
tmux send-keys -t "$SESSION:0.3" "zsh $TEAM_DIR/scripts/follower.sh" Enter
ok "FOLLOWER iniciado"

# ── 10. Watcher — notifica al orquestador (Claude principal) ─────────────────
log "Escribiendo watcher de inbox..."

cat > "$TEAM_DIR/scripts/inbox-watcher.sh" << WATCHER
#!/usr/bin/env zsh
# Monitorea el inbox continuamente — imprime cada mensaje nuevo y sigue vivo
# Sale solo cuando aparece el archivo done (señal de equipo completo)
INBOX="${INBOX}"
DONE_FILE="${TEAM_DIR}/done"
LAST_LINE=0

while true; do
  CURRENT_LINES=\$(wc -l < "\$INBOX" 2>/dev/null | tr -d ' ' || echo 0)
  if [ "\$CURRENT_LINES" -gt "\$LAST_LINE" ]; then
    tail -n +\$((\$LAST_LINE + 1)) "\$INBOX"
    LAST_LINE=\$CURRENT_LINES
  fi
  [ -f "\$DONE_FILE" ] && { echo "TEAM_DONE"; exit 0; }
  sleep 8
done
WATCHER
chmod +x "$TEAM_DIR/scripts/inbox-watcher.sh"
ok "Watcher escrito: $TEAM_DIR/scripts/inbox-watcher.sh"

# ── 11. Resumen ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══════════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}✓ Team listo — session: ${SESSION}${RESET}"
echo ""
echo -e "  ${BOLD}Orquestador:${RESET} tú (Claude Code principal)"
echo -e "  ${BOLD}Agentes:${RESET}"
echo -e "    Pane 0 → ${CYAN}${ROLE_BACKEND}${RESET}    ($BACKEND_DIR)"
echo -e "    Pane 1 → ${CYAN}${ROLE_QA}${RESET}"
echo -e "    Pane 2 → ${CYAN}${ROLE_RESEARCHER}${RESET}"
echo -e "    Pane 3 → ${CYAN}${ROLE_FOLLOWER}${RESET}  (bash, cada 15s)"
echo ""
echo -e "  ${BOLD}Asignar tarea a backend:${RESET}"
echo "    echo 'descripción' > ${TEAM_DIR}/tasks/backend.task"
echo ""
echo -e "  ${BOLD}Monitorear inbox (en Claude principal):${RESET}"
echo "    zsh ${TEAM_DIR}/scripts/inbox-watcher.sh"
echo ""
echo -e "  ${BOLD}Navegar:${RESET}"
echo "    tmux switch-client -t ${SESSION}   (desde sesión tmux activa)"
echo "    Ctrl+b flechas   navegar · Ctrl+b z   zoom · Ctrl+b d   detach"
echo -e "${BOLD}══════════════════════════════════════════════════════${RESET}"
echo ""

# ── 12. Adjuntar ─────────────────────────────────────────────────────────────
sleep 1
if [ -n "$TMUX" ]; then
  tmux switch-client -t "$SESSION"
else
  [[ "$TERM_PROGRAM" == "iTerm.app" ]] && tmux -CC attach-session -t "$SESSION" || tmux attach-session -t "$SESSION"
fi
