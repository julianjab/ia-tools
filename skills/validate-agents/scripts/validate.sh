#!/usr/bin/env bash
# =============================================================================
# validate.sh — Level 1 static validator for the ia-tools plugin.
#
# Checks frontmatter integrity, tool whitelists, cross-references, stale
# pointers, and runtime env var consistency across agents/, skills/, and
# hooks/. Runs in ~1s, hermetic (no network, no API calls, no mutations).
#
# Usage:
#   bash skills/validate-agents/scripts/validate.sh [--verbose] [--json]
#
# Exit codes:
#   0  all rules passed
#   1  at least one rule failed
#   2  script errored (missing dependency, bad CWD, etc.)
#
# Rule categories (see skills/validate-agents/SKILL.md for the full table):
#   A — Frontmatter integrity
#   B — Tool whitelist guarantees
#   C — Cross-reference integrity
#   D — Stale references
#   E — Env var / runtime consistency
# =============================================================================

set -u

VERBOSE=0
JSON=0
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
    --json)       JSON=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown flag: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

# ── Resolve repo root ────────────────────────────────────────────────────────
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT/agents" ]; then
  printf '✗ ERROR: not inside the ia-tools repo (no agents/ directory found)\n' >&2
  exit 2
fi
cd "$REPO_ROOT"

# ── Dependencies ─────────────────────────────────────────────────────────────
for bin in awk grep sed; do
  command -v "$bin" >/dev/null 2>&1 || { printf '✗ ERROR: %s not found\n' "$bin" >&2; exit 2; }
done

# ── Colors (only when writing to a tty) ──────────────────────────────────────
if [ -t 1 ] && [ "$JSON" -eq 0 ]; then
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[1;33m'
  DIM=$'\033[2m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; DIM=''; BOLD=''; RESET=''
fi

# ── Result accumulator ───────────────────────────────────────────────────────
# Format per rule: RULES_STATUS[ID]=pass|fail
# Findings per rule: RULES_FINDINGS[ID]=newline-separated "file:line: message"
declare -A RULES_STATUS
declare -A RULES_FINDINGS
declare -A RULES_DESC

# Rules declared in order of execution
RULE_ORDER=()

register_rule() {
  local id="$1"
  local desc="$2"
  RULE_ORDER+=("$id")
  RULES_STATUS[$id]="pass"
  RULES_FINDINGS[$id]=""
  RULES_DESC[$id]="$desc"
}

fail_rule() {
  local id="$1"
  local finding="$2"
  RULES_STATUS[$id]="fail"
  if [ -z "${RULES_FINDINGS[$id]}" ]; then
    RULES_FINDINGS[$id]="$finding"
  else
    RULES_FINDINGS[$id]="${RULES_FINDINGS[$id]}"$'\n'"$finding"
  fi
}

# ── Frontmatter helpers ──────────────────────────────────────────────────────
# Extract YAML frontmatter (between the first two `---` lines) from a file.
extract_frontmatter() {
  awk 'BEGIN{in_fm=0; seen=0} /^---$/{if(seen==0){in_fm=1; seen=1; next} else {exit}} in_fm==1{print}' "$1"
}

# Read a single scalar field from the frontmatter. Handles simple `key: value`
# and `key: "quoted value"`. Does NOT handle nested YAML structures.
get_fm_field() {
  local file="$1"
  local field="$2"
  extract_frontmatter "$file" \
    | awk -v f="$field" '
        $0 ~ "^"f":" {
          sub("^"f":[[:space:]]*", "", $0)
          sub("^\"", "", $0)
          sub("\"$", "", $0)
          print
          exit
        }'
}

file_has_frontmatter() {
  local file="$1"
  # Must have a line 1 that is exactly `---` and a subsequent `---` line.
  [ "$(sed -n '1p' "$file")" = "---" ] || return 1
  sed -n '2,50p' "$file" | grep -q "^---$"
}

# Whitelist of markdown files where certain "stale" strings are legitimate.
# These are historical notes or the validator's own docs.
STALE_WHITELIST=(
  "AGENTS.md"
  "CLAUDE.md"
  "skills/validate-agents/SKILL.md"
  "skills/task/SKILL.md"
  "agents/backend.md"
  "agents/frontend.md"
  "agents/mobile.md"
  "src/mcp-servers/slack-bridge/docs/REQ-001-dm-thinking.md"
  "src/mcp-servers/slack-bridge/docs/api-contract.md"
  "README.md"
)

is_whitelisted() {
  local file="$1"
  local wl
  for wl in "${STALE_WHITELIST[@]}"; do
    [ "$file" = "$wl" ] && return 0
  done
  return 1
}

# =============================================================================
# Rule implementations
# =============================================================================

# ── A — Frontmatter integrity ────────────────────────────────────────────────
register_rule "A1" "Every agents/*.md has a well-formed YAML frontmatter"
register_rule "A2" "Every agent has name, description, model fields"
register_rule "A3" "Agent frontmatter name: matches filename"
register_rule "A4" "Every agent has an explicit tools: field"
register_rule "A5" "Every skills/*/SKILL.md has frontmatter with name matching parent dir"

check_frontmatter_rules() {
  # Agents
  local f
  for f in agents/*.md; do
    [ -f "$f" ] || continue

    if ! file_has_frontmatter "$f"; then
      fail_rule "A1" "$f: missing or malformed YAML frontmatter"
      continue
    fi

    local name desc model tools
    name=$(get_fm_field "$f" "name")
    desc=$(get_fm_field "$f" "description")
    model=$(get_fm_field "$f" "model")
    tools=$(get_fm_field "$f" "tools")

    [ -n "$name" ]  || fail_rule "A2" "$f: missing name:"
    [ -n "$desc" ]  || fail_rule "A2" "$f: missing description:"
    [ -n "$model" ] || fail_rule "A2" "$f: missing model:"

    local basename_no_ext
    basename_no_ext=$(basename "$f" .md)
    if [ -n "$name" ] && [ "$name" != "$basename_no_ext" ]; then
      fail_rule "A3" "$f: name='$name' does not match filename '$basename_no_ext'"
    fi

    if [ -z "$tools" ]; then
      fail_rule "A4" "$f: missing tools: field (explicit whitelist required)"
    fi
  done

  # Skills
  for f in skills/*/SKILL.md; do
    [ -f "$f" ] || continue

    if ! file_has_frontmatter "$f"; then
      fail_rule "A5" "$f: missing or malformed YAML frontmatter"
      continue
    fi

    local name parent
    name=$(get_fm_field "$f" "name")
    parent=$(basename "$(dirname "$f")")

    if [ -z "$name" ]; then
      fail_rule "A5" "$f: missing name:"
    elif [ "$name" != "$parent" ]; then
      fail_rule "A5" "$f: name='$name' does not match parent dir '$parent'"
    fi
  done
}

# ── B — Tool whitelist guarantees ────────────────────────────────────────────
register_rule "B1" "triage MUST NOT list Edit/Write/MultiEdit/NotebookEdit/Agent"
register_rule "B2" "triage MUST list SlashCommand"
register_rule "B3" "security MUST NOT list Edit/Write/MultiEdit/NotebookEdit"
register_rule "B4" "orchestrator MUST list Agent and SlashCommand"

tools_list_of() {
  # Returns the tools field as a comma-separated string, or empty.
  get_fm_field "$1" "tools"
}

tools_contains() {
  local tools="$1"
  local needle="$2"
  printf '%s' "$tools" | grep -qE "(^|[[:space:]]|,)${needle}([[:space:]]|,|$)"
}

check_tool_whitelists() {
  local triage="agents/triage.md"
  local security="agents/security.md"
  local orchestrator="agents/orchestrator.md"

  if [ -f "$triage" ]; then
    local t_tools
    t_tools=$(tools_list_of "$triage")
    local forbidden
    for forbidden in Edit Write MultiEdit NotebookEdit Agent; do
      if tools_contains "$t_tools" "$forbidden"; then
        fail_rule "B1" "$triage: tools: includes forbidden '$forbidden'"
      fi
    done
    if ! tools_contains "$t_tools" "SlashCommand"; then
      fail_rule "B2" "$triage: tools: does not include required 'SlashCommand'"
    fi
  else
    fail_rule "B1" "$triage: file not found"
    fail_rule "B2" "$triage: file not found"
  fi

  if [ -f "$security" ]; then
    local s_tools
    s_tools=$(tools_list_of "$security")
    for forbidden in Edit Write MultiEdit NotebookEdit; do
      if tools_contains "$s_tools" "$forbidden"; then
        fail_rule "B3" "$security: tools: includes forbidden '$forbidden'"
      fi
    done
  else
    fail_rule "B3" "$security: file not found"
  fi

  if [ -f "$orchestrator" ]; then
    local o_tools
    o_tools=$(tools_list_of "$orchestrator")
    for required in Agent SlashCommand; do
      if ! tools_contains "$o_tools" "$required"; then
        fail_rule "B4" "$orchestrator: tools: does not include required '$required'"
      fi
    done
  else
    fail_rule "B4" "$orchestrator: file not found"
  fi
}

# ── C — Cross-reference integrity ────────────────────────────────────────────
register_rule "C1" "Every Agent(subagent_type=...) reference resolves to agents/<name>.md"
register_rule "C2" "Every /<skill> reference resolves to skills/<skill>/SKILL.md"
register_rule "C3" "Every hook script referenced in hooks/hooks.json exists and is executable"

check_cross_references() {
  # ── C1: subagent_type references ──
  # Pattern: subagent_type="X" or subagent_type='X' or subagent_type: "X"
  local tmp
  tmp=$(mktemp)
  grep -rHnE 'subagent_type[[:space:]]*[=:][[:space:]]*["'"'"']([a-z][a-z0-9-]*)["'"'"']' \
    agents/ skills/ 2>/dev/null > "$tmp" || true

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local src agent_name
    src=$(printf '%s' "$line" | cut -d: -f1)
    agent_name=$(printf '%s' "$line" | sed -nE 's/.*subagent_type[[:space:]]*[=:][[:space:]]*["'"'"']([a-z][a-z0-9-]*)["'"'"'].*/\1/p')
    if [ -n "$agent_name" ] && [ ! -f "agents/${agent_name}.md" ]; then
      local lineno
      lineno=$(printf '%s' "$line" | cut -d: -f2)
      fail_rule "C1" "$src:$lineno: subagent_type=\"$agent_name\" but agents/$agent_name.md does not exist"
    fi
  done < "$tmp"
  rm -f "$tmp"

  # ── C2: /<skill> references ──
  # We collect all slash-word tokens in agents/ and skills/ markdown that look
  # like a skill invocation, then check each unique one against skills/<name>/.
  #
  # The regex intentionally matches only code-span skill references like
  # `/foo` or `/foo ...` inside backticks or at a word boundary, to avoid
  # false positives from URLs/paths.
  local skills_seen=""
  while IFS= read -r skill_name; do
    [ -z "$skill_name" ] && continue
    # Dedupe
    case " $skills_seen " in *" $skill_name "*) continue ;; esac
    skills_seen="$skills_seen $skill_name"

    if [ ! -f "skills/${skill_name}/SKILL.md" ]; then
      # Find the first file that mentions it
      local offender
      offender=$(grep -rlE "/${skill_name}([[:space:]\`]|$)" agents/ skills/ CLAUDE.md AGENTS.md 2>/dev/null | head -1)
      fail_rule "C2" "$offender: /${skill_name} referenced but skills/${skill_name}/SKILL.md does not exist"
    fi
  done < <(grep -rhoE '\`/[a-z][a-z0-9-]+' agents/ skills/ CLAUDE.md AGENTS.md 2>/dev/null \
            | sed 's|^\`/||' \
            | sort -u)

  # ── C3: hook scripts ──
  local hooks_json="hooks/hooks.json"
  if [ -f "$hooks_json" ]; then
    # Extract paths that follow ${CLAUDE_PLUGIN_ROOT}/ inside the JSON. The
    # hooks.json strings are shell commands like
    #   bash "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/foo.sh"
    # so we grep for the variable followed by a path component ending at the
    # backslash that escapes the closing quote.
    local script
    while IFS= read -r script; do
      [ -z "$script" ] && continue
      # Strip trailing backslashes that appear because the JSON escapes its
      # closing quote with \", and our regex terminator captures the \.
      script="${script%\\}"
      local local_path="${script/\$\{CLAUDE_PLUGIN_ROOT\}/$REPO_ROOT}"
      if [ ! -f "$local_path" ]; then
        fail_rule "C3" "$hooks_json: script $script not found at $local_path"
      elif [ ! -x "$local_path" ]; then
        fail_rule "C3" "$hooks_json: script $script exists but is not executable"
      fi
    done < <(grep -oE '\$\{CLAUDE_PLUGIN_ROOT\}/[^"\\]+' "$hooks_json" || true)
  else
    fail_rule "C3" "$hooks_json: file not found"
  fi
}

# ── D — Stale references ─────────────────────────────────────────────────────
register_rule "D1" "No mention of removed agents outside whitelisted historical notes"
register_rule "D2" "No mention of removed skills (/deliver, 'worktree spawn') outside whitelisted docs"

REMOVED_AGENTS_REGEX='issue-refiner|backend-lead|frontend-lead|mobile-lead|api-agent|domain-agent|ui-agent|mobile-agent|qa-agent|security-reviewer'

check_stale_references() {
  # D1: removed agent mentions
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local file lineno content
    file=$(printf '%s' "$line" | cut -d: -f1)
    lineno=$(printf '%s' "$line" | cut -d: -f2)
    content=$(printf '%s' "$line" | cut -d: -f3-)

    if is_whitelisted "$file"; then
      continue
    fi
    # The validator's own files reference the removed agent names as data
    # (whitelist, grep pattern, documentation). They are not stale references.
    case "$file" in skills/validate-agents/*) continue ;; esac

    fail_rule "D1" "$file:$lineno: stale agent reference: $(printf '%s' "$content" | sed 's/^[[:space:]]*//' | cut -c1-80)"
  done < <(grep -rHnE "$REMOVED_AGENTS_REGEX" \
             --include="*.md" --include="*.sh" --include="*.yaml" --include="*.yml" \
             agents/ skills/ hooks/ CLAUDE.md AGENTS.md README.md 2>/dev/null || true)

  # D2: removed skills
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local file lineno content
    file=$(printf '%s' "$line" | cut -d: -f1)
    lineno=$(printf '%s' "$line" | cut -d: -f2)
    content=$(printf '%s' "$line" | cut -d: -f3-)

    if is_whitelisted "$file"; then
      continue
    fi
    # The validator's own script quotes these strings as part of its rule
    # definition; it's not a stale reference.
    case "$file" in skills/validate-agents/*) continue ;; esac

    fail_rule "D2" "$file:$lineno: stale skill reference: $(printf '%s' "$content" | sed 's/^[[:space:]]*//' | cut -c1-80)"
  done < <(grep -rHnE '/deliver|worktree[[:space:]]+spawn' \
             --include="*.md" --include="*.sh" --include="*.yaml" --include="*.yml" \
             agents/ skills/ hooks/ CLAUDE.md AGENTS.md README.md 2>/dev/null || true)
}

# ── E — Env var / runtime consistency ────────────────────────────────────────
register_rule "E1" "SLACK_THREAD_TS and SLACK_CHANNELS spelled consistently"
register_rule "E2" "IA_TOOLS_ROLE spelled consistently"

check_env_var_consistency() {
  # All files that reference Slack env vars
  local files=(
    "skills/task/scripts/start-task.sh"
    "hooks/scripts/session-start.sh"
    "agents/orchestrator.md"
    "agents/triage.md"
    "CLAUDE.md"
    "AGENTS.md"
  )

  # E1: detect variants of the expected names
  local f
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    # Forbidden: SLACK_CHANNEL (singular) used AS an env var name (not a cli
    # flag, not a parameter name). We only flag when it appears with $ prefix
    # or inside an env assignment.
    if grep -nE '\$SLACK_CHANNEL([^S_]|$)|^[[:space:]]*SLACK_CHANNEL=' "$f" 2>/dev/null | grep -qv '_ID' ; then
      local line
      line=$(grep -nE '\$SLACK_CHANNEL([^S_]|$)' "$f" 2>/dev/null | head -1)
      fail_rule "E1" "$f: uses \$SLACK_CHANNEL (singular) — expected \$SLACK_CHANNELS"
    fi
    if grep -nqE 'SLACK_THREAD[^_]' "$f" 2>/dev/null; then
      fail_rule "E1" "$f: uses SLACK_THREAD without _TS suffix — expected SLACK_THREAD_TS"
    fi
  done

  # E2: IA_TOOLS_ROLE spelling
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    if grep -nqE 'IATOOLS_ROLE|IA_TOOL_ROLE|IA_TOOLS_ROL[^E]' "$f" 2>/dev/null; then
      local line
      line=$(grep -nE 'IATOOLS_ROLE|IA_TOOL_ROLE|IA_TOOLS_ROL[^E]' "$f" | head -1)
      fail_rule "E2" "$f: $line"
    fi
  done
}

# =============================================================================
# Execution
# =============================================================================

check_frontmatter_rules
check_tool_whitelists
check_cross_references
check_stale_references
check_env_var_consistency

# ── Report ───────────────────────────────────────────────────────────────────
TOTAL_RULES=${#RULE_ORDER[@]}
FAILED_RULES=0
TOTAL_FINDINGS=0

for id in "${RULE_ORDER[@]}"; do
  if [ "${RULES_STATUS[$id]}" = "fail" ]; then
    FAILED_RULES=$((FAILED_RULES + 1))
    # Count findings (newline-separated)
    local_count=$(printf '%s' "${RULES_FINDINGS[$id]}" | grep -c '^' || echo 0)
    TOTAL_FINDINGS=$((TOTAL_FINDINGS + local_count))
  fi
done

if [ "$JSON" -eq 1 ]; then
  # JSON output for CI consumption
  printf '{\n'
  printf '  "result": "%s",\n' "$([ $FAILED_RULES -eq 0 ] && echo pass || echo fail)"
  printf '  "total_rules": %d,\n' "$TOTAL_RULES"
  printf '  "failed_rules": %d,\n' "$FAILED_RULES"
  printf '  "total_findings": %d,\n' "$TOTAL_FINDINGS"
  printf '  "rules": [\n'
  first=1
  for id in "${RULE_ORDER[@]}"; do
    [ $first -eq 0 ] && printf ',\n'
    first=0
    printf '    {"id":"%s","status":"%s","description":"%s","findings":[' \
      "$id" "${RULES_STATUS[$id]}" "${RULES_DESC[$id]//\"/\\\"}"
    if [ -n "${RULES_FINDINGS[$id]}" ]; then
      local_findings="${RULES_FINDINGS[$id]}"
      f_first=1
      while IFS= read -r finding; do
        [ -z "$finding" ] && continue
        [ $f_first -eq 0 ] && printf ','
        f_first=0
        printf '"%s"' "${finding//\"/\\\"}"
      done <<< "$local_findings"
    fi
    printf ']}'
  done
  printf '\n  ]\n}\n'
else
  # Human-readable output
  printf '\n%svalidate-agents%s — Level 1 static validator\n' "$BOLD" "$RESET"
  printf '%s────────────────────────────────────────────%s\n' "$DIM" "$RESET"

  for id in "${RULE_ORDER[@]}"; do
    local_status="${RULES_STATUS[$id]}"
    local_desc="${RULES_DESC[$id]}"
    if [ "$local_status" = "pass" ]; then
      printf '%s✓%s %s %s\n' "$GREEN" "$RESET" "$id" "$local_desc"
    else
      printf '%s✗%s %s %s\n' "$RED" "$RESET" "$id" "$local_desc"
      while IFS= read -r finding; do
        [ -z "$finding" ] && continue
        printf '    %s→%s %s\n' "$DIM" "$RESET" "$finding"
      done <<< "${RULES_FINDINGS[$id]}"
    fi
  done

  printf '\n'
  if [ $FAILED_RULES -eq 0 ]; then
    printf '%s✓ Result: PASS%s (%d/%d rules)\n\n' "$GREEN" "$RESET" "$TOTAL_RULES" "$TOTAL_RULES"
  else
    printf '%s✗ Result: FAIL%s (%d rules failed, %d findings)\n\n' \
      "$RED" "$RESET" "$FAILED_RULES" "$TOTAL_FINDINGS"
  fi
fi

[ $FAILED_RULES -eq 0 ] && exit 0 || exit 1
