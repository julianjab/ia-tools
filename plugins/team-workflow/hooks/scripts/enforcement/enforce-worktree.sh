#!/usr/bin/env bash
# enforce-worktree.sh — gitignore-aware worktree enforcement.
#
# Bucket:      enforcement
# Listens to:  PreToolUse  (matcher: Edit|Write|MultiEdit)
# Blocking:    yes (emits permissionDecision=deny in hookSpecificOutput)
# Input  (stdin JSON): { "tool_input": { "file_path": "<abs path>" }, ... }
# Output: empty `{}` on allow, or PreToolUse-shaped deny JSON on block.
#
# Rules applied per file edit (Edit/Write/MultiEdit):
#
#   1. File outside any git repo                 → ALLOW (no protection model)
#   2. File explicitly gitignored                → ALLOW (ephemeral / local)
#   3. Excepción explícita (state, agent-memory) → ALLOW
#   4. team-lead session (IA_TW_FEATURE set) AND
#      file is NOT inside `.worktrees/*`          → DENY
#   5. Branch is `main` or `master` AND
#      file is tracked-or-trackable              → DENY
#   6. Else                                       → ALLOW
#
# Determinism: la decisión depende solo del payload + `git check-ignore`
# (que mira `.gitignore` del repo target) + el env del proceso. No usa
# listas hardcoded de paths.
set -u

payload=$(cat)
file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[ -z "$file_path" ] && { printf '{}'; exit 0; }

# Excepciones globales (no dependen de git):
case "$file_path" in
  "$HOME/.claude/team-workflow/"*|*"/.claude/agent-memory/"*)
    printf '{}'; exit 0 ;;
esac

dir=$(dirname "$file_path")

# 1. ¿Está dentro de un git repo?
if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '{}'; exit 0
fi

# 2. ¿Está gitignored?
if git -C "$dir" check-ignore -q "$file_path" 2>/dev/null; then
  printf '{}'; exit 0
fi

# Archivo tracked-or-trackable a partir de acá.

in_worktree=0
case "$file_path" in
  *"/.worktrees/"*) in_worktree=1 ;;
esac

deny() {
  # JSON-escape: solo escapamos quotes y backslashes que aparezcan en file_path
  local reason="$1"
  local fp=${file_path//\\/\\\\}
  fp=${fp//\"/\\\"}
  local esc=${reason//\\/\\\\}
  esc=${esc//\"/\\\"}
  esc=${esc//$'\n'/\\n}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$esc"
  exit 0
}

# 4. team-lead session debe trabajar siempre dentro de .worktrees/*
if [ -n "${IA_TW_FEATURE:-}" ] && [ "$in_worktree" -eq 0 ]; then
  deny "team-lead enforcement: edits a archivos tracked deben ocurrir dentro de .worktrees/*. Ejecuta /worktree init $IA_TW_FEATURE (con --repo si aplica) y trabaja dentro de ese path. Archivo bloqueado: $file_path"
fi

# 5. Cualquier sesión en main/master: bloquear edits a tracked
branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  deny "Branch protegida: estás en $branch y $file_path es tracked. Crea una branch o un worktree antes de editar (e.g. /worktree init feat/<nombre>)."
fi

printf '{}'
exit 0
