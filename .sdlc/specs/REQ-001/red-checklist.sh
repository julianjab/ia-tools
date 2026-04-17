#!/usr/bin/env bash
# =============================================================================
# red-checklist.sh — BDD / AC dry-run checklist for REQ-001 (multi-repo orchestration)
#
# RED = at least one assertion fails (exit code 1).
# Each assertion maps 1:1 to an AC in requirement.md or a contract surface in
# api-contract.md. When an assertion fails it prints:
#   [RED] AC<N>[.<sub>]: <reason>
# to stdout and increments the RED counter.
#
# Usage: bash .sdlc/specs/REQ-001/red-checklist.sh
#        (run from the repo root, or any directory — paths resolve from script location)
#
# Dependencies: bash, grep (POSIX extended regex -E, -c, -q flags).
# No external deps beyond what macOS ships.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# repo root = three levels up from .sdlc/specs/REQ-001/
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

RED_COUNT=0
GREEN_COUNT=0

pass() {
  GREEN_COUNT=$((GREEN_COUNT + 1))
  printf "[GREEN] %s\n" "$1"
}

fail() {
  RED_COUNT=$((RED_COUNT + 1))
  printf "[RED]   %s\n" "$1"
}

check() {
  local label="$1"  # e.g. "AC1.1"
  local reason="$2" # e.g. "scope-check intent entry found in session-manager.md"
  local result="$3" # "pass" or "fail"
  if [ "$result" = "pass" ]; then
    pass "${label}: ${reason}"
  else
    fail "${label}: ${reason}"
  fi
}

# Helper: run a grep and return "pass" if it matches, "fail" otherwise
grep_check() {
  local pattern="$1"
  local file="$2"
  local flags="${3:--qE}"
  if grep $flags "$pattern" "$file" >/dev/null 2>&1; then
    echo "pass"
  else
    echo "fail"
  fi
}

# Helper: return "pass" if pattern does NOT match (negative assertion)
grep_check_absent() {
  local pattern="$1"
  local file="$2"
  local flags="${3:--qE}"
  if grep $flags "$pattern" "$file" >/dev/null 2>&1; then
    echo "fail"
  else
    echo "pass"
  fi
}

printf "\n============================================================\n"
printf " REQ-001 RED checklist — multi-repo orchestration\n"
printf " Repo: %s\n" "$REPO_ROOT"
printf "============================================================\n\n"

# ─────────────────────────────────────────────────────────────────────────────
# AC1 — session-manager has a scope-check intent with routing table entry
#        and at least 2 explicit examples of messages that route to it.
# ─────────────────────────────────────────────────────────────────────────────
SM="${REPO_ROOT}/agents/session-manager.md"

check "AC1.1" "scope-check intent entry present in session-manager.md" \
  "$(grep_check 'scope-check' "$SM")"

check "AC1.2" "scope-check routing table entry present in session-manager.md" \
  "$(grep_check 'scope.check' "$SM" "-qE")"

# The classifier decision tree must list scope-check as a branch
check "AC1.3" "scope-check appears in the classifier decision tree" \
  "$(grep_check 'scope.check' "$SM" "-qE")"

# ─────────────────────────────────────────────────────────────────────────────
# AC2 — session-manager documents the confirmation gate (never calls /session
#        without prior confirmation UNLESS explicit session-open phrase).
#        Contract: authorised_session field (api-contract.md §2.2)
# ─────────────────────────────────────────────────────────────────────────────
check "AC2.1" "session-manager documents confirmation gate before /session" \
  "$(grep_check 'confirmation|confirm' "$SM" "-qiE")"

check "AC2.2" "session-manager documents explicit session-open phrases (abre sesión / new task / nueva tarea)" \
  "$(grep_check 'abre sesi|new task|nueva tarea' "$SM" "-qiE")"

check "AC2.3" "session-manager references authorised_session (verdict schema field per api-contract §2.2)" \
  "$(grep_check 'authorised_session' "$SM")"

# ─────────────────────────────────────────────────────────────────────────────
# AC3 — THREAD_TS = ts of the authorising message; authorising_ts field in
#        the verdict schema (api-contract.md §2.1)
# ─────────────────────────────────────────────────────────────────────────────
check "AC3.1" "session-manager documents authorising_ts rule for THREAD_TS authoring" \
  "$(grep_check 'authorising_ts' "$SM")"

# ─────────────────────────────────────────────────────────────────────────────
# AC4 — orchestrator.md documents two operating contexts:
#        scope-check context (inline one-shot) and full pipeline context (tmux)
#        v3: IA_TOOLS_ORCHESTRATOR_MODE env var removed — mode implied by boot prompt
# ─────────────────────────────────────────────────────────────────────────────
ORCH="${REPO_ROOT}/agents/orchestrator.md"

check "AC4.1" "orchestrator.md documents 'scope-check context' (inline one-shot)" \
  "$(grep_check 'scope.check context' "$ORCH" "-qiE")"

check "AC4.2" "orchestrator.md documents 'full pipeline context' (tmux sub-session)" \
  "$(grep_check 'full pipeline context|full pipeline' "$ORCH" "-qiE")"

check "AC4.3" "orchestrator.md does NOT reference IA_TOOLS_ORCHESTRATOR_MODE (removed in v3)" \
  "$(grep_check_absent 'IA_TOOLS_ORCHESTRATOR_MODE' "$ORCH")"

# ─────────────────────────────────────────────────────────────────────────────
# AC5 — orchestrator boot with --resume-from reads plan-draft.md; CWD is
#        consumer repo root; shared directory is .sessions/<label>/
# ─────────────────────────────────────────────────────────────────────────────
check "AC5.1" "orchestrator.md documents resume-from path (reads plan-draft.md)" \
  "$(grep_check 'resume.from|plan.draft' "$ORCH" "-qE")"

check "AC5.2" "orchestrator.md documents CWD as consumer repo root or resume-from mode" \
  "$(grep_check 'consumer repo root|resume.from mode|resume.from.*mode' "$ORCH" "-qiE")"

check "AC5.3" "orchestrator.md references IA_TOOLS_SESSION_DIR env var (api-contract §5.2)" \
  "$(grep_check 'IA_TOOLS_SESSION_DIR' "$ORCH")"

# ─────────────────────────────────────────────────────────────────────────────
# AC6 — orchestrator.md documents the multi-repo worktree fan-out:
#        /worktree init ... --repo <path> per target repo, then passes
#        worktree path to stack teammate as prose.
#        v3: stack agents (backend/frontend/mobile) no longer own worktree creation.
# ─────────────────────────────────────────────────────────────────────────────
check "AC6.1" "orchestrator.md documents /worktree init ... --repo for multi-repo fan-out" \
  "$(grep_check '\-\-repo' "$ORCH")"

check "AC6.2" "orchestrator.md documents passing worktree path as prose to stack teammates" \
  "$(grep_check 'worktree_path|worktree at' "$ORCH" "-qiE")"

check "AC6.3" "orchestrator.md documents that stack agents do NOT create their own worktrees" \
  "$(grep_check 'do not create their own worktrees|not create.*worktree' "$ORCH" "-qiE")"

# Negative: stack agents must NOT document their own worktree creation protocol
for agent in backend frontend mobile; do
  AGENT_FILE="${REPO_ROOT}/agents/${agent}.md"

  check "AC6.4-${agent}" "${agent}.md does NOT document target_repo parameter (orchestrator's job in v3)" \
    "$(grep_check_absent 'target_repo' "$AGENT_FILE")"

  check "AC6.5-${agent}" "${agent}.md does NOT document --repo flag (orchestrator's job in v3)" \
    "$(grep_check_absent '\-\-repo' "$AGENT_FILE")"
done

# ─────────────────────────────────────────────────────────────────────────────
# AC7 — stack agents (backend/frontend/mobile) and architect do NOT have a
#        Parameters: block or teams_dir/sessions_dir parameter.
#        v3: orchestrator passes worktree path as prose; no formal grammar block.
# ─────────────────────────────────────────────────────────────────────────────
for agent in backend frontend mobile architect; do
  AGENT_FILE="${REPO_ROOT}/agents/${agent}.md"

  check "AC7.1-${agent}" "${agent}.md does NOT contain Parameters: block (removed in v3)" \
    "$(grep_check_absent '^Parameters:$' "$AGENT_FILE" "-qm1")"

  check "AC7.2-${agent}" "${agent}.md does NOT reference teams_dir parameter (removed in v3)" \
    "$(grep_check_absent 'teams_dir' "$AGENT_FILE")"

  check "AC7.3-${agent}" "${agent}.md does NOT reference sessions_dir parameter (orchestrator-only in v3)" \
    "$(grep_check_absent 'sessions_dir' "$AGENT_FILE")"
done

# ─────────────────────────────────────────────────────────────────────────────
# AC8 — security.md documents prose invocation: orchestrator passes worktree
#        path in delegation prompt. No formal Parameters: block.
# ─────────────────────────────────────────────────────────────────────────────
SEC="${REPO_ROOT}/agents/security.md"

check "AC8.1" "security.md documents worktree path invocation (prose, not Parameters: block)" \
  "$(grep_check 'worktree_path|worktree.*path|explicit worktree' "$SEC" "-qiE")"

check "AC8.2" "security.md does NOT have a Parameters: block (removed in v3)" \
  "$(grep_check_absent '^Parameters:$' "$SEC" "-qm1")"

check "AC8.3" "security.md documents explicit worktree path invocation form (api-contract §3.5)" \
  "$(grep_check 'Explicit worktree path|explicit.*worktree' "$SEC" "-qiE")"

# ─────────────────────────────────────────────────────────────────────────────
# AC9 — skills/task/SKILL.md (name: session) and start-session.sh document
#        --base and --resume-from; IA_TOOLS_SESSION_DIR written to settings.
#        v3: IA_TOOLS_ORCHESTRATOR_MODE removed; IA_TOOLS_TEAMS_DIR → IA_TOOLS_SESSION_DIR
# ─────────────────────────────────────────────────────────────────────────────
SESSION_SKILL="${REPO_ROOT}/skills/task/SKILL.md"
START_SH="${REPO_ROOT}/skills/task/scripts/start-session.sh"

check "AC9.1" "skills/task/SKILL.md (name: session) documents --base flag" \
  "$(grep_check '\-\-base' "$SESSION_SKILL")"

check "AC9.2" "skills/task/SKILL.md documents --resume-from flag" \
  "$(grep_check '\-\-resume-from' "$SESSION_SKILL")"

check "AC9.3" "start-session.sh handles --base flag" \
  "$(grep_check '\-\-base' "$START_SH")"

check "AC9.4" "start-session.sh handles --resume-from flag" \
  "$(grep_check '\-\-resume-from' "$START_SH")"

check "AC9.5" "start-session.sh has resume-from mode (skips worktree init when --resume-from)" \
  "$(grep_check 'RESUME_FROM|resume.from' "$START_SH" "-qE")"

check "AC9.6" "start-session.sh does NOT write IA_TOOLS_ORCHESTRATOR_MODE (removed in v3)" \
  "$(grep_check_absent 'IA_TOOLS_ORCHESTRATOR_MODE' "$START_SH")"

check "AC9.7" "start-session.sh writes IA_TOOLS_SESSION_DIR into settings.local.json (api-contract §5.2)" \
  "$(grep_check 'IA_TOOLS_SESSION_DIR' "$START_SH")"

# ─────────────────────────────────────────────────────────────────────────────
# AC10 — skills/worktree/SKILL.md documents --repo flag
# ─────────────────────────────────────────────────────────────────────────────
WT_SKILL="${REPO_ROOT}/skills/worktree/SKILL.md"

check "AC10.1" "skills/worktree/SKILL.md documents --repo flag for init sub-command" \
  "$(grep_check '\-\-repo' "$WT_SKILL")"

check "AC10.2" "skills/worktree/SKILL.md specifies --repo runs as if CWD were <path>" \
  "$(grep_check '\-\-repo.*path|path.*\-\-repo|target repo root' "$WT_SKILL" "-qiE")"

# Worktree scripts (may be empty today — if no scripts dir, assert no --repo handling)
WT_SCRIPTS_DIR="${REPO_ROOT}/skills/worktree/scripts"
if [ -d "$WT_SCRIPTS_DIR" ]; then
  WT_SCRIPTS_COUNT="$(ls "$WT_SCRIPTS_DIR" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$WT_SCRIPTS_COUNT" -gt 0 ]; then
    if grep -qrE '\-\-repo' "$WT_SCRIPTS_DIR" 2>/dev/null; then
      check "AC10.3" "skills/worktree/scripts/* handle --repo flag" "pass"
    else
      check "AC10.3" "skills/worktree/scripts/* handle --repo flag" "fail"
    fi
  else
    check "AC10.3" "skills/worktree/scripts/* present and handle --repo (no scripts found — assert exists)" "fail"
  fi
else
  check "AC10.3" "skills/worktree/scripts/ directory exists with --repo handling" "fail"
fi

# ─────────────────────────────────────────────────────────────────────────────
# AC11 — skills/scope-check/SKILL.md exists
# ─────────────────────────────────────────────────────────────────────────────
SCOPE_CHECK_SKILL="${REPO_ROOT}/skills/scope-check/SKILL.md"

if [ -f "$SCOPE_CHECK_SKILL" ]; then
  check "AC11.1" "skills/scope-check/SKILL.md exists" "pass"

  check "AC11.2" "skills/scope-check/SKILL.md documents --description flag (api-contract §6.1)" \
    "$(grep_check '\-\-description' "$SCOPE_CHECK_SKILL")"

  check "AC11.3" "skills/scope-check/SKILL.md documents --task-label flag (api-contract §6.1)" \
    "$(grep_check '\-\-task-label' "$SCOPE_CHECK_SKILL")"

  check "AC11.4" "skills/scope-check/SKILL.md documents verdict.json output" \
    "$(grep_check 'verdict\.json|verdict.json' "$SCOPE_CHECK_SKILL" "-qE")"
else
  check "AC11.1" "skills/scope-check/SKILL.md exists" "fail"
  # If the file doesn't exist the sub-assertions auto-fail
  fail "AC11.2: skills/scope-check/SKILL.md absent — cannot check --description flag"
  RED_COUNT=$((RED_COUNT + 1))
  fail "AC11.3: skills/scope-check/SKILL.md absent — cannot check --task-label flag"
  RED_COUNT=$((RED_COUNT + 1))
  fail "AC11.4: skills/scope-check/SKILL.md absent — cannot check verdict.json output"
  RED_COUNT=$((RED_COUNT + 1))
fi

# ─────────────────────────────────────────────────────────────────────────────
# AC12 — AGENTS.md contains a lahaus end-to-end example with backend + mobile,
#         two PRs, and two security passes
# ─────────────────────────────────────────────────────────────────────────────
AGENTS_MD="${REPO_ROOT}/AGENTS.md"

check "AC12.1" "AGENTS.md contains lahaus end-to-end example" \
  "$(grep_check 'lahaus' "$AGENTS_MD" "-qi")"

check "AC12.2" "AGENTS.md example mentions both backend and mobile" \
  "$(grep_check 'backend.*mobile|mobile.*backend' "$AGENTS_MD" "-qiE")"

check "AC12.3" "AGENTS.md example mentions two PRs (multi-PR pattern)" \
  "$(grep_check 'two PRs|2 PRs|two.*PR|N PRs' "$AGENTS_MD" "-qiE")"

check "AC12.4" "AGENTS.md example mentions two security passes" \
  "$(grep_check 'two security|security.*twice|security.*per PR|per.*PR.*security' "$AGENTS_MD" "-qiE")"

# ─────────────────────────────────────────────────────────────────────────────
# AC13 — "single PR per task" wording REMOVED; "N PRs per task" (or equivalent)
#          + per-PR security wording ADDED in AGENTS.md and CLAUDE.md.
# ─────────────────────────────────────────────────────────────────────────────
CLAUDE_MD="${REPO_ROOT}/CLAUDE.md"

# AC13: Must NOT contain the old "single PR per task" invariant wording
if grep -qiE 'single PR per task|one PR per task' "$AGENTS_MD" 2>/dev/null; then
  fail "AC13.1: AGENTS.md still contains old 'single PR per task' wording — must be removed"
  RED_COUNT=$((RED_COUNT + 1))
else
  pass "AC13.1: AGENTS.md does not contain deprecated 'single PR per task' wording"
fi

if grep -qiE 'single PR per task|one PR per task' "$CLAUDE_MD" 2>/dev/null; then
  fail "AC13.2: CLAUDE.md still contains old 'single PR per task' wording — must be removed"
  RED_COUNT=$((RED_COUNT + 1))
else
  pass "AC13.2: CLAUDE.md does not contain deprecated 'single PR per task' wording"
fi

# Must contain the new "N PRs per task" invariant (or equivalent)
check "AC13.3" "AGENTS.md contains 'N PRs per task' or equivalent language" \
  "$(grep_check 'N PRs|N prs|per touched.*repo|once per.*PR|per PR' "$AGENTS_MD" "-qiE")"

check "AC13.4" "CLAUDE.md contains 'N PRs per task' or equivalent language" \
  "$(grep_check 'N PRs|N prs|per touched.*repo|once per.*PR|per PR' "$CLAUDE_MD" "-qiE")"

check "AC13.5" "AGENTS.md documents per-PR security requirement" \
  "$(grep_check 'security.*per PR|per.PR.*security|APPROVED.*per PR' "$AGENTS_MD" "-qiE")"

# ─────────────────────────────────────────────────────────────────────────────
# AC14 — REGRESSION GUARD: session-manager.md still contains the four original
#          intents: read-only, trivial-config, small-change, change.
#          scope-check is ADDITIVE, not a replacement.
# ─────────────────────────────────────────────────────────────────────────────
for intent in 'read-only' 'trivial-config' 'small-change' 'change'; do
  check "AC14-${intent}" "session-manager.md still contains original '${intent}' intent (regression guard)" \
    "$(grep_check "${intent}" "$SM")"
done

# ─────────────────────────────────────────────────────────────────────────────
# AC15 — CLAUDE.md and AGENTS.md mention .sessions/ in gitignore guidance
#          (renamed from .claude/teams/ in v3)
# ─────────────────────────────────────────────────────────────────────────────
check "AC15.1" "AGENTS.md mentions .sessions/ in gitignore guidance" \
  "$(grep_check '\.sessions/' "$AGENTS_MD")"

check "AC15.2" "CLAUDE.md mentions .sessions/ in gitignore guidance" \
  "$(grep_check '\.sessions/' "$CLAUDE_MD")"

check "AC15.3" "AGENTS.md does NOT mention .claude/teams/ (renamed to .sessions/ in v3)" \
  "$(grep_check_absent '\.claude/teams/' "$AGENTS_MD")"

check "AC15.4" "CLAUDE.md does NOT mention .claude/teams/ (renamed to .sessions/ in v3)" \
  "$(grep_check_absent '\.claude/teams/' "$CLAUDE_MD")"

# ─────────────────────────────────────────────────────────────────────────────
# NO-PARAMS assertions — v3 removes the formal Parameters: grammar block from
# all stack agents, architect, and security. Orchestrator passes context as prose.
# ─────────────────────────────────────────────────────────────────────────────
printf "\n== No-Parameters assertions (v3 — prose delegation, no formal block) ==\n\n"

for agent in backend frontend mobile architect security; do
  AGENT_FILE="${REPO_ROOT}/agents/${agent}.md"

  check "NO-PARAMS-${agent}" \
    "${agent}.md does NOT contain a 'Parameters:' block (prose delegation in v3)" \
    "$(grep_check_absent '^Parameters:$' "$AGENT_FILE" "-qm1")"
done

# ─────────────────────────────────────────────────────────────────────────────
# SESSIONS-DIR assertions — orchestrator.md references .sessions/ as the
# shared directory (renamed from .claude/teams/ in v3)
# ─────────────────────────────────────────────────────────────────────────────
printf "\n== Sessions-dir schema assertions (api-contract §1) ==\n\n"

check "SESSIONS-DIR-1" "orchestrator.md references .sessions/ shared directory" \
  "$(grep_check '\.sessions/' "$ORCH")"

check "SESSIONS-DIR-2" "orchestrator.md documents scope.md file in sessions dir" \
  "$(grep_check 'scope\.md' "$ORCH")"

check "SESSIONS-DIR-3" "orchestrator.md documents plan-draft.md file in sessions dir" \
  "$(grep_check 'plan-draft\.md' "$ORCH")"

check "SESSIONS-DIR-4" "orchestrator.md documents prs.md file in sessions dir (api-contract §4)" \
  "$(grep_check 'prs\.md' "$ORCH")"

check "SESSIONS-DIR-5" "orchestrator.md does NOT reference .claude/teams/ (renamed to .sessions/ in v3)" \
  "$(grep_check_absent '\.claude/teams/' "$ORCH")"

# ─────────────────────────────────────────────────────────────────────────────
# PRS.MD ownership assertions (api-contract.md §4)
# v3: orchestrator writes prs.md. Stack agents report PR URL to orchestrator
# and do NOT write prs.md themselves.
# ─────────────────────────────────────────────────────────────────────────────
printf "\n== prs.md ownership assertions (api-contract §4 — orchestrator writes) ==\n\n"

check "PRS-MD-orchestrator" \
  "orchestrator.md documents prs.md PR URL registration (api-contract §4)" \
  "$(grep_check 'prs\.md' "$ORCH")"

for agent in backend frontend mobile; do
  AGENT_FILE="${REPO_ROOT}/agents/${agent}.md"

  check "PRS-MD-no-${agent}" \
    "${agent}.md does NOT document prs.md (orchestrator owns it in v3)" \
    "$(grep_check_absent 'prs\.md' "$AGENT_FILE")"
done

# ─────────────────────────────────────────────────────────────────────────────
# VERDICT SCHEMA assertions (api-contract.md §2.1)
# session-manager.md must document verdicts "read-only", "inline", "new-session"
# ─────────────────────────────────────────────────────────────────────────────
printf "\n== Verdict schema assertions (api-contract §2.1) ==\n\n"

for verdict in 'read-only' 'inline' 'new-session'; do
  check "VERDICT-${verdict}" \
    "session-manager.md documents verdict='${verdict}' routing (api-contract §2.1)" \
    "$(grep_check "verdict.*${verdict}|${verdict}.*verdict" "$SM" "-qiE")"
done

# ─────────────────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────────────────
TOTAL=$((RED_COUNT + GREEN_COUNT))
printf "\n============================================================\n"
printf " SUMMARY: RED=%-3d GREEN=%-3d TOTAL=%d\n" "$RED_COUNT" "$GREEN_COUNT" "$TOTAL"
printf "============================================================\n\n"

if [ "$RED_COUNT" -gt 0 ]; then
  printf "Status: RED — %d assertion(s) failed. Implementation needed.\n\n" "$RED_COUNT"
  exit 1
else
  printf "Status: GREEN — all assertions passed.\n\n"
  exit 0
fi
