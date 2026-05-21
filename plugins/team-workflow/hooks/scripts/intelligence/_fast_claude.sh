#!/usr/bin/env bash
# _fast_claude.sh — shared helper for intelligence hooks that call Haiku.
#
# Bucket:      intelligence (helper, never registered in hooks.json)
# Listens to:  N/A — sourced by other intelligence scripts via `. _fast_claude.sh`
# Blocking:    no (helper only)
# Input:       function arguments
# Output:      function-specific (see each function header)
#
# Why this file exists: hook latency is dominated by `claude -p` startup
# (MCP server boot + project setting load + tool catalog injection). For
# classification calls that need none of those, the bare invocation is
# ~12 s; the tuned invocation is ~0.7 s on CI (with --bare) or ~3 s on a
# developer machine (without --bare).
#
# Two paths, auto-selected by environment:
#
#   1. `--bare` path (used when ANTHROPIC_API_KEY is set):
#        --bare         skip auto-discovery of hooks, skills, plugins, MCP,
#                       auto memory, CLAUDE.md — the docs explicitly recommend
#                       this for scripted / SDK calls.
#        --max-turns 1  single classification turn, no loops.
#      Baseline → bare:  ~12 s → ~0.7 s  (~17× faster).
#      Bare mode requires API-key auth; OAuth from /login is NOT picked up.
#
#   2. Tuned-flags path (used when ANTHROPIC_API_KEY is missing — typical
#      on a developer machine that authed via /login):
#        --max-turns 1
#        --strict-mcp-config --mcp-config <empty-json>   skip slack-bridge etc.
#        --setting-sources user                          skip project CLAUDE.md
#        --disallowedTools …                             drop tool defs
#        --permission-mode bypassPermissions
#      Baseline → tuned: ~12 s → ~3 s  (~4× faster). Keeps OAuth auth.
#
# See https://code.claude.com/docs/en/headless#start-faster-with-bare-mode
# and https://code.claude.com/docs/en/cli-reference for the per-flag docs.
#
# Usage from a sibling intelligence hook:
#
#   . "$(dirname "$0")/_fast_claude.sh"
#   result=$(printf '%s' "$prompt" | fast_claude --model claude-haiku-4-5-20251001)
#
# This file MUST be sourced, not executed.

# Guard against double-sourcing.
[ -n "${_FAST_CLAUDE_LOADED:-}" ] && return 0
_FAST_CLAUDE_LOADED=1

# ── Function: fast_claude ────────────────────────────────────────────────────
# Wrapper around `claude -p` with latency-optimized flags. Reads the prompt
# from stdin and writes the model's text response to stdout. Stderr is
# silenced. Returns the claude exit code (or 127 when claude is missing).
#
# Args are passed through to claude after the fixed flags. The caller MUST
# pass `--model <name>` explicitly — we do not default it.
fast_claude() {
  command -v claude >/dev/null 2>&1 || return 127

  # Path 1 — --bare (when API key auth is available).
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    claude --bare -p \
      --max-turns 1 \
      "$@" \
      2>/dev/null
    return $?
  fi

  # Path 2 — tuned flags (OAuth via /login is still consulted because
  # --bare is not requested; skip MCP/project-settings/tool-catalog to
  # cut most of the remaining startup cost).
  local cfg
  cfg=$(mktemp 2>/dev/null) || cfg=""
  if [ -n "$cfg" ]; then
    printf '{"mcpServers":{}}' > "$cfg" 2>/dev/null || cfg=""
  fi

  local rc
  if [ -n "$cfg" ]; then
    claude -p \
      --max-turns 1 \
      --strict-mcp-config --mcp-config "$cfg" \
      --setting-sources user \
      --permission-mode bypassPermissions \
      --disallowedTools Bash Read Edit Write MultiEdit WebFetch WebSearch \
                        SlashCommand TodoWrite NotebookEdit Task Glob Grep \
      "$@" \
      2>/dev/null
    rc=$?
    rm -f "$cfg" 2>/dev/null
  else
    claude -p \
      --max-turns 1 \
      --setting-sources user \
      --permission-mode bypassPermissions \
      --disallowedTools Bash Read Edit Write MultiEdit WebFetch WebSearch \
                        SlashCommand TodoWrite NotebookEdit Task Glob Grep \
      "$@" \
      2>/dev/null
    rc=$?
  fi
  return "$rc"
}
