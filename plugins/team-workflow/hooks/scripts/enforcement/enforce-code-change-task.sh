#!/usr/bin/env bash
# enforce-code-change-task.sh — block code edits in a worktree without a plan.
#
# Bucket:      enforcement
# Listens to:  PreToolUse  (matcher: Edit|Write|MultiEdit|Bash)
# Blocking:    yes (emits permissionDecision=deny in hookSpecificOutput),
#              configurable to warn-only via IA_TW_ENFORCE_CHAIN=warn.
# Input  (stdin JSON): { "tool_name", "tool_input", "cwd", … }
# Output: empty `{}` on allow, or PreToolUse-shaped deny JSON on block.
#
# Why this hook exists
# --------------------
# The four invariants in AGENTS.md treat every code change as a managed
# event. Drift happens when the lead edits files (or commits) WITHOUT
# first registering its intent — review nits, refactor follow-ups, and
# "let me also" cleanups land on the branch without leaving a trace of
# "why this change, who scoped it, where in the iteration counter".
#
# This hook implements the minimum gate: every code edit in a managed
# worktree must be preceded by a plan event in state.md whose freshness
# is consistent with the worktree's current PR phase.
#
# Plan events
# -----------
# Two kinds are accepted equivalently (the lead picks based on scope):
#
#   plan_recorded  — written autonomously by the lead, no user gate.
#                    For small / obvious scope (review nits, lint fixes,
#                    follow-up ports inside an existing approved feature).
#   plan_approved  — written after `/ask-user` returned `aprobar`.
#                    For large or sensitive scope (API changes, refactors,
#                    security-sensitive code, new features).
#
# The hook does NOT judge whether the plan is well-scoped. It only checks
# existence and freshness:
#
#   1. There MUST be at least one plan_* event covering the worktree
#      being edited (per-worktree `wt_prefix` match, or `scope: global`).
#   2. If a `pr_opened` event exists for the same worktree, the latest
#      plan event for that worktree must be NEWER than the latest
#      `pr_opened`. Otherwise the existing plan is considered "closed"
#      for that scope and a fresh plan event is required for follow-up.
#
# Decision tree
# -------------
#
#   tool_name ∉ {Edit, Write, MultiEdit, Bash(git commit*)} → allow
#   path not under any managed worktree in state.md         → allow
#   path inside $IA_TW_STATE_DIR (lead workspace)           → allow
#   no plan_* event for the worktree                        → DENY
#   pr_opened exists AND pr_ts > plan_ts                    → DENY
#   otherwise                                               → allow
#
# Bypass and modes
# ----------------
#
#   IA_TW_ENFORCE_CHAIN=warn  → log to hook-audit.log, do not block.
#                               For rolling the hook out before flipping
#                               to deny.
#   IA_TW_ENFORCE_CHAIN=deny  → default — blocks via permissionDecision.
#   IA_TW_BYPASS_CHAIN=1      → one-shot bypass + forensic log line.
#                               Reserved for operator overrides; the lead
#                               must NOT export this.
#
# Bucket discipline: never calls `claude -p`, never edits state.md, never
# runs longer than ~50ms (single awk pass over state.md, no subshells).

set -u

payload=$(cat)
tool_name=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)

# ── 1. Resolve the target path (or pass-through) ──────────────────────────
target=""
sub_tool="$tool_name"

case "$tool_name" in
  Edit|Write|MultiEdit)
    target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
    ;;
  Bash)
    cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
    case "$cmd" in
      *"git commit"*|*"git "*" commit"*)
        target=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)
        sub_tool="Bash(git-commit)"
        ;;
      *)
        printf '{}'
        exit 0
        ;;
    esac
    ;;
  *)
    printf '{}'
    exit 0
    ;;
esac

[ -n "$target" ] || { printf '{}'; exit 0; }

# ── 2. State.md reachable? ────────────────────────────────────────────────
state_md="${IA_TW_STATE_DIR:-}/state.md"
if [ -z "${IA_TW_STATE_DIR:-}" ] || [ ! -f "$state_md" ]; then
  printf '{}'
  exit 0
fi

# ── 3. Lead-workspace pass-through ────────────────────────────────────────
# Edits to $IA_TW_STATE_DIR (state.md, contracts, audit) are the lead's
# own workspace — no plan event required, the workspace is the planning
# surface itself.
case "$target" in
  "$IA_TW_STATE_DIR"*) printf '{}'; exit 0 ;;
esac

# ── 4. Worktree match ─────────────────────────────────────────────────────
# Walk worktrees: in state.md frontmatter and find one whose `worktree:`
# absolute path is a prefix of the edit target.
matched_wt_prefix=""
matched_wt_path=""

while IFS=$'\t' read -r wt_path wt_prefix; do
  [ -n "$wt_path" ] && [ -n "$wt_prefix" ] || continue
  case "$target" in
    "$wt_path"*)
      matched_wt_prefix="$wt_prefix"
      matched_wt_path="$wt_path"
      break
      ;;
  esac
done < <(awk '
  /^worktrees:/                    { in_wt = 1; wt = ""; pfx = ""; next }
  in_wt && /^[a-z_]+:[[:space:]]/  { in_wt = 0 }
  in_wt && /worktree:[[:space:]]/  {
    sub(/^[[:space:]]*worktree:[[:space:]]*/, "")
    wt = $0
  }
  in_wt && /wt_prefix:[[:space:]]/ {
    sub(/^[[:space:]]*wt_prefix:[[:space:]]*/, "")
    pfx = $0
    if (wt != "" && pfx != "") {
      printf "%s\t%s\n", wt, pfx
      wt = ""; pfx = ""
    }
  }
' "$state_md")

# Edit is outside any managed worktree (e.g. system files, gitignored
# artifacts, repos not under team-workflow control). Pass through.
[ -n "$matched_wt_prefix" ] || { printf '{}'; exit 0; }

# ── 5. Scan events for plan_* and pr_opened ───────────────────────────────
# Single awk pass: capture the latest plan_recorded / plan_approved that
# covers this worktree (per-wt match OR scope == global), and the latest
# pr_opened for this worktree.
read -r last_plan_ts last_pr_ts < <(awk -v wt="$matched_wt_prefix" '
  /^events:/                       { in_ev = 1; next }
  in_ev && /^[a-z_]+:[[:space:]]/  { in_ev = 0 }
  !in_ev                           { next }

  /^[[:space:]]+- ts:[[:space:]]/  {
    sub(/^[[:space:]]+- ts:[[:space:]]*/, "")
    cur_ts    = $0
    cur_kind  = ""
    cur_wt    = ""
    cur_scope = ""
    next
  }

  /^[[:space:]]+kind:[[:space:]]/  {
    sub(/^[[:space:]]+kind:[[:space:]]*/, "")
    cur_kind = $0

    # Evaluate at every kind line so events without a wt_prefix /
    # scope field still register (they default to per-wt = mismatched,
    # global = empty, plan_* below treats missing scope as per-wt-only).
    eval_event()
  }

  /^[[:space:]]+wt_prefix:[[:space:]]/ {
    sub(/^[[:space:]]+wt_prefix:[[:space:]]*/, "")
    cur_wt = $0
    eval_event()
  }

  /^[[:space:]]+scope:[[:space:]]/ {
    sub(/^[[:space:]]+scope:[[:space:]]*/, "")
    cur_scope = $0
    eval_event()
  }

  function eval_event(   covers) {
    if (cur_ts == "" || cur_kind == "") return

    covers = (cur_wt == wt) || (cur_scope == "global")

    if ((cur_kind == "plan_recorded" || cur_kind == "plan_approved") && covers) {
      if (cur_ts > last_plan) last_plan = cur_ts
    }
    if (cur_kind == "pr_opened" && cur_wt == wt) {
      if (cur_ts > last_pr) last_pr = cur_ts
    }
  }

  END { printf "%s\t%s\n", last_plan, last_pr }
' "$state_md")

# ── 6. Decision ───────────────────────────────────────────────────────────
mode="${IA_TW_ENFORCE_CHAIN:-deny}"
log_path="${IA_TW_STATE_DIR}/hook-audit.log"
ts_now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# 6a. Forensic bypass — always allow but always log.
if [ "${IA_TW_BYPASS_CHAIN:-}" = "1" ]; then
  printf '%s BYPASS code-change wt=%s target=%q tool=%s\n' \
    "$ts_now" "$matched_wt_prefix" "$target" "$sub_tool" \
    >> "$log_path" 2>/dev/null || true
  printf '{}'
  exit 0
fi

# Helper: emit a permissionDecision=deny response with an escaped reason.
emit_deny() {
  local reason="$1"
  local escaped
  escaped=$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' \
    "$escaped"
  exit 0
}

# Helper: warn-mode log + allow.
emit_warn() {
  local reason="$1"
  printf '%s WARN code-change wt=%s target=%q tool=%s reason=%q\n' \
    "$ts_now" "$matched_wt_prefix" "$target" "$sub_tool" "$reason" \
    >> "$log_path" 2>/dev/null || true
  printf '{}'
  exit 0
}

violate() {
  local reason="$1"
  case "$mode" in
    warn) emit_warn "$reason" ;;
    *)    emit_deny "$reason" ;;
  esac
}

# 6b. No plan event covers this worktree.
if [ -z "$last_plan_ts" ]; then
  violate "Code change on '${matched_wt_prefix}' rejected: no plan_recorded / plan_approved event in state.md covers this worktree. Write a plan event first (autonomous 'plan_recorded' for small scope, '/ask-user' + 'plan_approved' for large scope)."
fi

# 6c. PR open but plan event is stale relative to it.
if [ -n "$last_pr_ts" ] && [ "$last_pr_ts" \> "$last_plan_ts" ]; then
  violate "Code change on '${matched_wt_prefix}' rejected: PR was opened at ${last_pr_ts} after the latest plan event (${last_plan_ts}). Record a NEW plan event (plan_recorded or plan_approved) covering this follow-up scope before editing."
fi

# 6d. Plan is fresh — allow.
printf '{}'
exit 0
