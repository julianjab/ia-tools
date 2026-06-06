#!/usr/bin/env bash
# Shared helpers for the agent-routing hooks.
#
# Bucket:   intelligence (sourced library — not a hook entrypoint)
# Output:   defines bash functions; no side effects on source.
#
# Agnostic by design: zero references to IA_TW_*, state.md, worktrees, or any
# team-workflow concept. Walks up from $cwd looking for a .claude/ directory
# with agents/, skills/, or commands/ — exactly the same discovery Claude
# Code itself does.

set -u

# Walk up from $1 to find the nearest ancestor that contains a non-empty
# .claude/{agents,skills,commands}/ directory. Echoes the absolute path of
# that ancestor, or empty if none found.
agent_routing_find_root() {
  local start="${1:-$PWD}"
  local dir
  dir=$(cd "$start" 2>/dev/null && pwd) || return 0
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -d "$dir/.claude/agents" ] \
       || [ -d "$dir/.claude/skills" ] \
       || [ -d "$dir/.claude/commands" ]; then
      printf '%s' "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 0
}

# Print a compact roster of repo-local agents/skills/commands rooted at $1.
# Format: one entry per line, prefixed by kind.
#
#   agent  <name> — <one-line description>
#   skill  <name> — <one-line description>
#   command <name>
agent_routing_print_roster() {
  local root="$1"
  [ -n "$root" ] || return 0

  if [ -d "$root/.claude/agents" ]; then
    local f name desc
    for f in "$root"/.claude/agents/*.md; do
      [ -f "$f" ] || continue
      name=$(basename "$f" .md)
      desc=$(awk '
        /^---[[:space:]]*$/ { fm = !fm; next }
        fm && /^description:/ {
          sub(/^description:[[:space:]]*/, "")
          gsub(/^["\x27]/, ""); gsub(/["\x27][[:space:]]*$/, "")
          print; exit
        }
      ' "$f" 2>/dev/null)
      printf 'agent  %s — %s\n' "$name" "${desc:-<no description>}"
    done
  fi

  if [ -d "$root/.claude/skills" ]; then
    local d name desc skill_md
    for d in "$root"/.claude/skills/*/; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      skill_md="$d/SKILL.md"
      desc=""
      if [ -f "$skill_md" ]; then
        desc=$(awk '
          /^---[[:space:]]*$/ { fm = !fm; next }
          fm && /^description:/ {
            sub(/^description:[[:space:]]*/, "")
            gsub(/^["\x27]/, ""); gsub(/["\x27][[:space:]]*$/, "")
            print; exit
          }
        ' "$skill_md" 2>/dev/null)
      fi
      printf 'skill  %s — %s\n' "$name" "${desc:-<no description>}"
    done
  fi

  if [ -d "$root/.claude/commands" ]; then
    local f name
    for f in "$root"/.claude/commands/*.md; do
      [ -f "$f" ] || continue
      name=$(basename "$f" .md)
      printf 'command %s\n' "$name"
    done
  fi
}

# Classify a free-text prompt as one of:
#   exec      — verbs of execution (mutating intent)
#   search    — verbs of search / planning / explanation
#   ambiguous — neither pattern matched strongly, or both did
#
# Heuristic only: pattern-match common phrasings in Spanish + English.
# Designed to err on the side of `ambiguous` to avoid noisy nudges on
# borderline prompts.
agent_routing_classify_prompt() {
  local prompt
  prompt=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')

  local search_re='(^|[^a-z])(que|qué|cual|cuál|cuales|cuáles|donde|dónde|como|cómo|por que|por qué|explica|explícame|analiza|investiga|encuentra|busca|muestra|lista|revisa|lee|describe|what|where|how|why|explain|analyze|investigate|find|show|list|search|read|review|inspect|audit)([^a-z]|$)'
  local exec_re='(^|[^a-z])(agrega|añade|anade|implementa|crea|escribe|modifica|cambia|arregla|corrige|refactoriza|migra|actualiza|borra|elimina|renombra|haz|hazlo|monta|configura|conecta|integra|despliega|publica|commitea|pushea|mergea|add|implement|create|write|modify|change|fix|refactor|migrate|update|delete|remove|rename|build|wire|deploy|publish|merge|commit|push)([^a-z]|$)'

  local has_exec=0 has_search=0
  printf '%s' "$prompt" | grep -qE "$exec_re"   && has_exec=1
  printf '%s' "$prompt" | grep -qE "$search_re" && has_search=1

  if [ "$has_exec" -eq 1 ] && [ "$has_search" -eq 0 ]; then
    printf 'exec'
  elif [ "$has_search" -eq 1 ] && [ "$has_exec" -eq 0 ]; then
    printf 'search'
  else
    printf 'ambiguous'
  fi
}

# True (exit 0) when a Bash command string looks mutative — i.e. the kind
# of operation that should usually flow through a repo agent / skill rather
# than ad-hoc shell. Read-only commands (ls, grep, git status, …) return
# false (exit 1).
agent_routing_is_mutative_bash() {
  local cmd="${1:-}"
  [ -n "$cmd" ] || return 1

  local mut_re='(^|[^a-z])(git[[:space:]]+(commit|push|merge|rebase|cherry-pick|revert|tag)|npm[[:space:]]+(install|i|add|remove|uninstall|publish|update)|pnpm[[:space:]]+(install|i|add|remove|uninstall|publish|update)|yarn[[:space:]]+(install|add|remove|publish|upgrade)|pip[[:space:]]+install|poetry[[:space:]]+(add|remove|install|update|publish)|uv[[:space:]]+(add|remove|sync|publish|upload)|bundle[[:space:]]+install|gem[[:space:]]+install|cargo[[:space:]]+(add|remove|publish)|go[[:space:]]+(get|install)|brew[[:space:]]+(install|uninstall|upgrade)|apt[[:space:]]+(install|remove)|terraform[[:space:]]+(apply|destroy)|kubectl[[:space:]]+(apply|delete|patch|replace)|docker[[:space:]]+(push|build|compose[[:space:]]+up)|alembic[[:space:]]+(upgrade|downgrade|revision)|prisma[[:space:]]+migrate|rails[[:space:]]+(db|generate|destroy)|python[[:space:]]+manage\.py[[:space:]]+(migrate|makemigrations)|migrate|make[[:space:]]+(deploy|release|migrate))([^a-z]|$)'

  printf '%s' "$cmd" | grep -qE "$mut_re"
}

# JSON-encode a string. Uses python3 when available; falls back to sed+awk.
agent_routing_json_encode() {
  local s="$1"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$s" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))"
    return 0
  fi
  local esc
  esc=$(printf '%s' "$s" | sed 's/\\/\\\\/g; s/"/\\"/g')
  esc=$(printf '%s' "$esc" | awk 'BEGIN{ORS=""} NR>1{print "\\n"} {print}')
  printf '"%s"' "$esc"
}

# Emit an additionalContext JSON envelope. Args:
#   $1 = hook event name (UserPromptSubmit | SessionStart | PreToolUse)
#   $2 = context body (plain text)
agent_routing_emit_context() {
  local event="$1" body="$2" encoded
  encoded=$(agent_routing_json_encode "$body")
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":%s}}' \
    "$event" "$encoded"
  exit 0
}
