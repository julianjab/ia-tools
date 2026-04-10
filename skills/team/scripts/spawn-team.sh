#!/usr/bin/env bash
# =============================================================================
# spawn-team.sh — Lanza un equipo de agentes Claude Code en tmux
# Cada agente trabaja en su propio worktree para desarrollo paralelo.
# Uso: bash scripts/spawn-team.sh [session-name] [scope]
# Ej:  bash scripts/spawn-team.sh dev-team notification
# =============================================================================

set -e

SESSION="${1:-dev-team}"
SCOPE="${2:-feature}"
REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# ── Colores ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}▶${RESET} $1"; }
ok()   { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}⚠${RESET} $1"; }
die()  { echo -e "${RED}✗ ERROR:${RESET} $1"; exit 1; }

echo -e "\n${BOLD}Claude Code — Spawn Agent Team${RESET}"
echo "────────────────────────────────────"

# ── 1. Verificar dependencias ─────────────────────────────────────────────────
log "Verificando dependencias..."

if ! command -v tmux &>/dev/null; then
  warn "tmux no instalado. Instalando..."
  if command -v brew &>/dev/null; then
    brew install tmux
  elif command -v apt-get &>/dev/null; then
    sudo apt-get install -y tmux
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y tmux
  else
    die "No se pudo instalar tmux. Instálalo manualmente."
  fi
fi
ok "tmux $(tmux -V | cut -d' ' -f2)"

if ! command -v claude &>/dev/null; then
  die "Claude Code no instalado. Corre: npm install -g @anthropic-ai/claude-code"
fi
ok "claude instalado"

# ── 2. Feature flags ─────────────────────────────────────────────────────────
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
log "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"

# ── 3. Matar sesión previa si existe ─────────────────────────────────────────
if tmux has-session -t "$SESSION" 2>/dev/null; then
  warn "Sesión '$SESSION' ya existe. Eliminando..."
  tmux kill-session -t "$SESSION"
fi

# ── 4. Crear worktrees para los agentes ───────────────────────────────────────
cd "$REPO"
log "Creando worktrees en: $REPO"

WORKTREE_DIR="_worktrees"
mkdir -p "$WORKTREE_DIR"

# Asegurar que _worktrees/ está en .gitignore
grep -qxF '_worktrees/' .gitignore 2>/dev/null || echo '_worktrees/' >> .gitignore

BACKEND_BRANCH="feat/${SCOPE}-backend"
BACKEND_DIR="${WORKTREE_DIR}/feat-${SCOPE}-backend"

# Fetch latest
git fetch origin 2>/dev/null || true

# Determinar base branch
BASE="main"
if ! git rev-parse --verify "origin/$BASE" &>/dev/null; then
  BASE="master"
fi

# Crear worktree para backend (si no existe)
if [ ! -d "$BACKEND_DIR" ]; then
  git worktree add -b "$BACKEND_BRANCH" "$BACKEND_DIR" "origin/$BASE" 2>/dev/null || \
    git worktree add "$BACKEND_DIR" "$BACKEND_BRANCH" 2>/dev/null || \
    warn "No se pudo crear worktree backend (rama puede existir)"
  ok "Worktree backend: $BACKEND_DIR ($BACKEND_BRANCH)"
else
  ok "Worktree backend ya existe: $BACKEND_DIR"
fi

# ── 5. Crear sesión tmux ──────────────────────────────────────────────────────
log "Creando sesión tmux '$SESSION'..."

# Layout para 3 agentes (default):
# ┌─────────────────────────────────────┐
# │          ORCHESTRATOR (Pane 0)      │
# ├──────────────────┬──────────────────┤
# │  BACKEND (Pane 1)│    QA (Pane 2)   │
# └──────────────────┴──────────────────┘

tmux new-session -d -s "$SESSION" -c "$REPO" -x 220 -y 50

# Dividir: horizontal abajo, luego vertical en la parte inferior
tmux split-window -v -t "$SESSION:0"        # Pane 0 (arriba) | Pane 1 (abajo)
tmux split-window -h -t "$SESSION:0.1"      # Pane 1 (abajo izq) | Pane 2 (abajo der)

ok "Layout 1+2 creado"

# ── 6. Nombrar los panes ─────────────────────────────────────────────────────
tmux set-option -t "$SESSION" pane-border-status top
tmux set-option -t "$SESSION" pane-border-format "#{pane_title}"

tmux select-pane -t "$SESSION:0.0" -T "ORCHESTRATOR"
tmux select-pane -t "$SESSION:0.1" -T "BACKEND"
tmux select-pane -t "$SESSION:0.2" -T "QA"

# ── 7. Lanzar claude en cada pane ─────────────────────────────────────────────
log "Iniciando agentes..."

# Pane 0: Orchestrator — en el repo principal (main), acceso total
tmux send-keys -t "$SESSION:0.0" \
  "cd $REPO && claude" Enter
sleep 1

# Pane 1: Backend — en su worktree
if [ -d "$REPO/$BACKEND_DIR" ]; then
  tmux send-keys -t "$SESSION:0.1" \
    "cd $REPO/$BACKEND_DIR && claude" Enter
else
  tmux send-keys -t "$SESSION:0.1" \
    "cd $REPO && claude" Enter
fi
sleep 1

# Pane 2: QA — en el repo principal (puede moverse entre worktrees)
tmux send-keys -t "$SESSION:0.2" \
  "cd $REPO && claude" Enter

ok "3 agentes iniciados"

# ── 8. Resumen ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════${RESET}"
echo -e "${GREEN}Team active in tmux (session: $SESSION)${RESET}"
echo ""
echo -e "  ${CYAN}Pane 0${RESET} → ORCHESTRATOR  (main repo — coordinates)"
echo -e "  ${CYAN}Pane 1${RESET} → BACKEND        ($BACKEND_DIR)"
echo -e "  ${CYAN}Pane 2${RESET} → QA             (cross-worktree — tests + PRs)"
echo ""
echo -e "${BOLD}Worktrees:${RESET}"
git worktree list 2>/dev/null | while read line; do echo "  $line"; done
echo ""
echo -e "${BOLD}Skills disponibles en cada agente:${RESET}"
echo "  /worktree — gestión de worktrees"
echo "  /commit   — commits convencionales"
echo "  /review   — validación de calidad"
echo "  /pr       — push + crear PR"
echo "  /ship     — notificar en Slack"
echo ""
echo -e "${BOLD}Atajos tmux:${RESET}"
echo "  Ctrl+b → flechas   Navegar entre panes"
echo "  Ctrl+b → z         Zoom a un pane"
echo "  Ctrl+b → d         Detach (sesión sigue corriendo)"
echo "  tmux attach -t $SESSION   Reconectar"
echo "  tmux kill-session -t $SESSION   Cerrar todo"
echo -e "${BOLD}════════════════════════════════════════${RESET}"
echo ""

# ── 9. Adjuntar ──────────────────────────────────────────────────────────────
log "Adjuntando sesión..."
sleep 1

if [[ "$TERM_PROGRAM" == "iTerm.app" ]]; then
  tmux -CC attach-session -t "$SESSION"
else
  tmux attach-session -t "$SESSION"
fi
