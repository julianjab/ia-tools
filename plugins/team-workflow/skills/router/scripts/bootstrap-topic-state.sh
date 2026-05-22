#!/usr/bin/env bash
# bootstrap-topic-state.sh — create the per-topic state dir + state.md + messages.md.
#
# Usage:   bootstrap-topic-state.sh <topic-string> [--root <state_root>]
# Stdout:  prints the absolute state_dir path on success.
# Exit codes:
#   0  state_dir ready (created or already-existed)
#   1  argument / configuration error
#
# Called by the `router` agent on the first inbound of every new topic.
# Idempotent: if state.md already exists, the script leaves it alone and
# only emits the path so the router can export $IA_TW_STATE_DIR and move
# on. messages.md is created empty when missing so the append-message
# hook (UserPromptSubmit / Stop / SubagentStop / PostToolUse:reply…)
# starts capturing turns immediately.
#
# Topic-id derivation:
#   session_id = sha1(<topic-string>)[:12]
#   state_dir  = <state_root>/<session_id>/
# <state_root> defaults to ${IA_TW_STATE_ROOT:-$HOME/.claude/team-workflow/state}.
#
# This helper does NOT create $IA_TW_WORKTREE_ROOT or $IA_TW_AGENT_LINK_DIR
# — those belong to start-lead.sh when /session fires. The router only
# needs state.md + messages.md to start logging the conversation.

set -euo pipefail

# ─── Args ─────────────────────────────────────────────────────────────────
topic="${1:-}"
if [ -z "$topic" ]; then
  printf 'bootstrap-topic-state: <topic-string> required\n' >&2
  printf 'usage: bootstrap-topic-state.sh <topic-string> [--root <state_root>]\n' >&2
  exit 1
fi
shift

state_root="${IA_TW_STATE_ROOT:-$HOME/.claude/team-workflow/state}"
while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      state_root="${2:?--root requires a path}"
      shift 2
      ;;
    --root=*)
      state_root="${1#--root=}"
      shift
      ;;
    *)
      printf 'bootstrap-topic-state: unknown argument %q\n' "$1" >&2
      exit 1
      ;;
  esac
done

# ─── Derive session_id + state_dir ────────────────────────────────────────
session_id=$(printf '%s' "$topic" | shasum | head -c 12)
state_dir="$state_root/$session_id"

# ─── Create state_dir + skeleton (idempotent) ─────────────────────────────
mkdir -p "$state_dir"

state_md="$state_dir/state.md"
if [ ! -f "$state_md" ]; then
  iso_now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  {
    printf -- '---\n'
    printf 'topic: %s\n'            "$topic"
    printf 'session_id: %s\n'       "$session_id"
    printf 'phase: chatting\n'
    printf 'created_at: %s\n'       "$iso_now"
    printf 'last_event_at: %s\n'    "$iso_now"
    printf 'default_repo: ""\n'
    printf 'pending_ask: ""\n'
    printf 'worktrees: []\n'
    printf 'events: []\n'
    printf -- '---\n\n'
    printf '## Plan aprobado\n\n_(filled by `lead` after the approval gate.)_\n\n'
    printf '## Audit log\n\n_(append-only summary of phase transitions; structured events live in `events:` above and per-turn entries in `messages.md`.)_\n\n'
    # Documentation marker — the trailer reminds any reader (human or
    # agent) that the rolling conversation history lives in messages.md
    # in this same directory. NOT a Claude Code @-import.
    printf '<!-- conversation history: read `messages.md` in this directory -->\n'
  } > "$state_md"
fi

messages_md="$state_dir/messages.md"
[ -f "$messages_md" ] || : > "$messages_md"

# ─── Sentinel for hooks running in the parent Claude Code process ─────────
# The router cannot export $IA_TW_STATE_DIR up to the parent process; any
# in-session `export` dies with the Bash subprocess. So we write the
# active state_dir to a fixed sentinel path. append-message.sh (and any
# other hook that needs the topic's state dir) reads this when its
# inherited $IA_TW_STATE_DIR is empty. Single-router-per-machine
# invariant makes the single-sentinel layout safe.
sentinel="$state_root/.current"
printf '%s\n' "$state_dir" > "$sentinel" 2>/dev/null || true

# ─── Emit the path for the caller (`router`) ──────────────────────────────
printf '%s\n' "$state_dir"
exit 0
