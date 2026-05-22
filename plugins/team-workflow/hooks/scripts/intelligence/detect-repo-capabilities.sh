#!/usr/bin/env bash
# detect-repo-capabilities.sh — full repo discovery: capabilities + agents + stack.
#
# Bucket:      intelligence
# Listens to:  PostToolUse  (matcher: Edit|Write|MultiEdit)
# Blocking:    no (always exit 0)
# Input  (stdin JSON): { "tool_input": { "file_path": "<abs>" }, ... }
# Output: exit 0 always; updates state.md by SPLICING `stack:` / `agents:` /
#         `capabilities:` blocks into each worktree entry that lacks them,
#         AND appends a `kind: repo_capabilities` event for the SessionEnd
#         feedback aggregator.
#
# This script is the canonical discovery surface — the lead no longer globs
# .claude/agents/, classifies by regex, or infers stack. It writes a minimal
# worktree entry (repo / worktree / branch / wt_prefix); the hook fills in
# the rest. See lead.md "Provision worktrees" for the contract.
#
# Discovery pipeline per repo:
#
#   1. Stack — derived from manifests:
#        pubspec.yaml         → mobile
#        package.json+UI dep  → frontend
#        pyproject.toml|*.py  → backend
#        Cargo.toml|go.mod    → backend
#        *.tf|terraform/      → infra
#        Otherwise            → "unknown" (lead can override)
#
#   2. Capabilities — pre_push_hook / agent_memory_dir / team_review_config /
#                     conventional_commits / base_branch.
#
#   3. Agents — glob <repo>/.claude/agents/*.md, read frontmatter
#               (name + first 240 chars of description), then call Haiku
#               via _fast_claude.sh with the full agent list and the
#               detected stack. One call returns all four bucket picks
#               from the descriptions; the LLM handles naming variants
#               (python-unittest-expert → qa, flutter-reviewer → sec,
#               *-test-writer → qa, etc.) that no regex enumeration
#               could cover cleanly.
#
#   4. Final bucket assignment with fallback chain:
#        impl  → Haiku pick → impl-${wt_prefix} (plugin implementer fallback)
#        qa    → Haiku pick → lead (inline)
#        sec   → Haiku pick → lead (inline)
#        arch  → Haiku pick → implementer
#
# Triggered by PostToolUse Edit/Write because worktree entries can only
# enter state.md via Edit/Write. Idempotent via per-entry `agents:` presence
# check — a worktree entry that already declares `agents:` is skipped.

set -u

payload=$(cat)

[ -n "${IA_TW_STATE_DIR:-}" ] || exit 0

file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file_path" ] || exit 0

case "$file_path" in
  */team-workflow/state/*/state.md) ;;
  *) exit 0 ;;
esac

state_file="$file_path"
[ -f "$state_file" ] || exit 0

# ── Helper: detect stack from repo manifests ─────────────────────────────────
detect_stack() {
  local repo="$1"
  [ -d "$repo" ] || { printf 'unknown'; return; }

  if compgen -G "${repo}/*.tf" >/dev/null 2>&1 \
     || [ -d "${repo}/terraform" ]; then
    printf 'infra'; return
  fi
  if [ -f "${repo}/pubspec.yaml" ]; then
    printf 'mobile'; return
  fi
  if [ -f "${repo}/pyproject.toml" ] || [ -f "${repo}/setup.py" ] \
     || compgen -G "${repo}/**/pyproject.toml" >/dev/null 2>&1; then
    printf 'backend'; return
  fi
  if [ -f "${repo}/Cargo.toml" ] || [ -f "${repo}/go.mod" ]; then
    printf 'backend'; return
  fi
  if [ -f "${repo}/package.json" ]; then
    if grep -qE '"(react|vue|nuxt|svelte|next|astro|@angular/core)"' "${repo}/package.json" 2>/dev/null; then
      printf 'frontend'; return
    fi
    printf 'backend'; return
  fi
  printf 'unknown'
}

# ── Helper: probe operational capabilities of a repo ─────────────────────────
probe_capabilities() {
  local repo="$1"
  local pre_push="absent" agents_count=0 agent_memory="absent" \
        team_review="absent" cc="no" base=""

  if [ -x "${repo}/.git/hooks/pre-push" ] \
     && ! grep -q '^# Sample' "${repo}/.git/hooks/pre-push" 2>/dev/null; then
    pre_push="present"
  elif [ -f "${repo}/.husky/pre-push" ]; then
    pre_push="present (husky)"
  else
    local hp; hp=$(git -C "$repo" config --get core.hooksPath 2>/dev/null)
    [ -n "$hp" ] && [ -x "${repo}/${hp}/pre-push" ] && pre_push="present (core.hooksPath)"
  fi

  [ -d "${repo}/.claude/agents" ] \
    && agents_count=$(find "${repo}/.claude/agents" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')
  [ -d "${repo}/.claude/agent-memory" ] && agent_memory="present"

  if [ -f "${repo}/CLAUDE.md" ] \
     && grep -q 'TEAM_REVIEW_CHANNEL\|TEAM_REVIEW_MENTIONS' "${repo}/CLAUDE.md" 2>/dev/null; then
    team_review="present"
  elif [ -f "${repo}/.claude/settings.local.json" ] \
       && grep -q 'TEAM_REVIEW_CHANNEL\|TEAM_REVIEW_MENTIONS' "${repo}/.claude/settings.local.json" 2>/dev/null; then
    team_review="present (local)"
  elif [ -f "${repo}/.claude/settings.json" ] \
       && grep -q 'TEAM_REVIEW_CHANNEL\|TEAM_REVIEW_MENTIONS' "${repo}/.claude/settings.json" 2>/dev/null; then
    team_review="present"
  fi

  if [ -f "${repo}/commitlint.config.js" ] || [ -f "${repo}/commitlint.config.mjs" ] \
     || [ -f "${repo}/commitlint.config.cjs" ] || [ -f "${repo}/.commitlintrc" ] \
     || [ -f "${repo}/.commitlintrc.json" ] || [ -f "${repo}/.commitlintrc.yml" ] \
     || [ -f "${repo}/.husky/commit-msg" ] || [ -x "${repo}/.git/hooks/commit-msg" ]; then
    cc="yes"
  fi

  base=$(git -C "$repo" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')
  [ -n "$base" ] || base=$(git -C "$repo" branch --show-current 2>/dev/null)
  [ -n "$base" ] || base="unknown"

  printf 'pre_push_hook=%s\nagents_count=%s\nagent_memory_dir=%s\nteam_review_config=%s\nconventional_commits=%s\nbase_branch=%s\n' \
    "$pre_push" "$agents_count" "$agent_memory" "$team_review" "$cc" "$base"
}

# ── Helper: extract YAML frontmatter `name` + 240-char `description` ─────────
extract_agent_metadata() {
  local f="$1"
  [ -f "$f" ] || return 0
  awk '
    /^---$/ { count++; if (count == 2) exit; next }
    count == 1 && /^name:[[:space:]]/ {
      sub(/^name:[[:space:]]*/, "")
      sub(/^["\x27]/, ""); sub(/["\x27]$/, "")
      name = $0
    }
    count == 1 && /^description:[[:space:]]*>?/ {
      in_desc = 1
      sub(/^description:[[:space:]]*>?[[:space:]]*/, "")
      sub(/^["\x27]/, ""); sub(/["\x27]$/, "")
      desc = $0
      next
    }
    in_desc && /^[a-zA-Z_-]+:/ { in_desc = 0 }
    in_desc { desc = desc " " $0 }
    END {
      gsub(/[[:space:]]+/, " ", desc)
      sub(/^[[:space:]]+/, "", desc)
      printf "%s|%.240s", name, desc
    }
  ' "$f"
}

# ── Helper: collect all agents as a (name, description) list ────────────────
# Sets global `all_agents` to a newline-separated "name|description" set so
# every classification step works against the same input.
collect_agents() {
  local repo="$1"
  all_agents=""
  local agents_dir="${repo}/.claude/agents"
  [ -d "$agents_dir" ] || return 0

  local f meta
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    meta=$(extract_agent_metadata "$f")
    [ -n "$meta" ] || continue
    [ -n "${meta%%|*}" ] || continue
    all_agents="${all_agents}${meta}"$'\n'
  done < <(find "$agents_dir" -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort)
}

# ── Helper: ask Haiku to assign all four buckets in one call ────────────────
# Primary classifier — works on the full agent list with the description text,
# so name conventions like `python-unittest-expert` (qa) and `flutter-reviewer`
# (sec) are picked up by semantic match, not just by name regex.
#
# Sets globals: haiku_impl, haiku_qa, haiku_sec, haiku_arch (empty when the
# call fails or the model returns null / an unknown name).
ask_haiku_buckets() {
  local stack="$1" pairs="$2"
  haiku_impl=""; haiku_qa=""; haiku_sec=""; haiku_arch=""
  [ -n "$pairs" ] || return 0

  local agents_yaml
  agents_yaml=$(printf '%s' "$pairs" | while IFS='|' read -r n d; do
    [ -n "$n" ] || continue
    printf -- '- name: %s\n  description: %s\n' "$n" "$d"
  done)
  [ -n "$agents_yaml" ] || return 0

  local classifier_prompt="A repo with stack '${stack}' has these agents. Assign one agent to each role using their names AND descriptions (descriptions matter — names follow many conventions: 'python-unittest-expert' is a QA agent, 'flutter-reviewer' is a SEC agent, etc.):

  impl: writes feature code in this stack
  qa:   writes or reviews tests
  sec:  reviews security / threat model / code-review-for-vulnerabilities
  arch: designs structure / API contracts / system layout (not implementation)

Agents:
${agents_yaml}

For each role, return the best-fit agent NAME from the list above, or null if no agent fits. Each role takes at most one agent, but the same agent MAY appear in multiple roles when its description clearly covers more than one. Output ONLY one JSON line:
{\"impl\":\"<name-or-null>\",\"qa\":\"<name-or-null>\",\"sec\":\"<name-or-null>\",\"arch\":\"<name-or-null>\"}
No prose, no markdown, no code fence."

  . "$(dirname "$0")/_fast_claude.sh"
  local resp
  resp=$(printf '%s' "$classifier_prompt" \
    | fast_claude --model claude-haiku-4-5-20251001) || resp=""

  local role
  for role in impl qa sec arch; do
    local val
    val=$(printf '%s' "$resp" | grep -oE "\"${role}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    [ "$val" = "null" ] && val=""
    # Sanity: only accept names that exist in the input set.
    if [ -n "$val" ] && ! printf '%s' "$pairs" | grep -qF "${val}|"; then val=""; fi
    case "$role" in
      impl) haiku_impl="$val" ;;
      qa)   haiku_qa="$val"   ;;
      sec)  haiku_sec="$val"  ;;
      arch) haiku_arch="$val" ;;
    esac
  done
}

# ── Helper: resolve buckets with full fallback chain ─────────────────────────
# Precedence per bucket:
#   Haiku pick  >  plugin default
#
# Discovery is Haiku-only by design — the model reads agent descriptions
# and decides bucket fit based on intent, which generalises across naming
# conventions that regex cannot enumerate. When `claude` is unavailable,
# Haiku returns no picks and every bucket falls back to lead / implementer.
#
# Naming contract: Haiku picks are REPO-LOCAL names (e.g. "python-developer").
# `sync-agents.sh` materializes them into the session as
# `<repo-basename>-<agent-name>.md`, so the lead must spawn the prefixed
# form. We apply that prefix here so the `agents:` map written into
# state.md is already session-ready.
#
# Plugin-level fallbacks (lead, implementer, impl-<wt_prefix>) are
# never prefixed — they don't go through sync-agents.
resolve_buckets() {
  local wt_prefix="$1"
  local repo_slug="$2"

  if   [ -n "$haiku_impl" ];   then bucket_impl="${repo_slug}-${haiku_impl}"
  else                              bucket_impl="impl-${wt_prefix}"
  fi

  if   [ -n "$haiku_qa" ];     then bucket_qa="${repo_slug}-${haiku_qa}"
  else                              bucket_qa="lead"
  fi

  if   [ -n "$haiku_sec" ];    then bucket_sec="${repo_slug}-${haiku_sec}"
  else                              bucket_sec="lead"
  fi

  if   [ -n "$haiku_arch" ];   then bucket_arch="${repo_slug}-${haiku_arch}"
  else                              bucket_arch="implementer"
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────
needs_file=$(mktemp 2>/dev/null) || exit 0

awk '
  BEGIN { state = "pre"; in_wt = 0; cur_repo = ""; cur_wt = ""; cur_prefix = ""; has_agents = 0 }
  /^---$/ { if (state == "pre") { state = "front"; next } else if (state == "front") { state = "body" } }
  state != "front" { next }

  /^  - repo:[[:space:]]/ {
    if (cur_prefix != "" && has_agents == 0 && cur_repo != "") {
      printf "%s|%s|%s\n", cur_prefix, cur_repo, cur_wt
    }
    in_wt = 1; cur_repo = $0; sub(/^  - repo:[[:space:]]*/, "", cur_repo)
    cur_wt = ""; cur_prefix = ""; has_agents = 0
    next
  }
  in_wt && /^[[:space:]]+worktree:[[:space:]]/ {
    cur_wt = $0; sub(/^[[:space:]]+worktree:[[:space:]]*/, "", cur_wt)
  }
  in_wt && /^[[:space:]]+wt_prefix:[[:space:]]/ {
    cur_prefix = $0; sub(/^[[:space:]]+wt_prefix:[[:space:]]*/, "", cur_prefix)
  }
  in_wt && /^[[:space:]]+agents:[[:space:]]*$/ { has_agents = 1 }

  END {
    if (cur_prefix != "" && has_agents == 0 && cur_repo != "") {
      printf "%s|%s|%s\n", cur_prefix, cur_repo, cur_wt
    }
  }
' "$state_file" > "$needs_file" 2>/dev/null

if [ ! -s "$needs_file" ]; then
  rm -f "$needs_file"
  exit 0
fi

discovery_dir=$(mktemp -d 2>/dev/null) || { rm -f "$needs_file"; exit 0; }
ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
writer="$(dirname "$0")/../lib/write-event.sh"

while IFS='|' read -r wt_prefix repo worktree; do
  [ -n "$wt_prefix" ] && [ -n "$repo" ] || continue

  local_root="$repo"
  [ -n "$worktree" ] && [ -d "${worktree}/.claude" ] && local_root="$worktree"

  stack=$(detect_stack "$local_root")
  eval "$(probe_capabilities "$local_root")"

  collect_agents "$local_root"
  ask_haiku_buckets "$stack" "$all_agents"
  resolve_buckets "$wt_prefix" "$(basename "$repo")"

  splice_file="${discovery_dir}/${wt_prefix}.splice"
  {
    printf '    stack: %s\n' "$stack"
    printf '    agents:\n'
    printf '      impl: %s\n' "$bucket_impl"
    printf '      qa: %s\n'   "$bucket_qa"
    printf '      sec: %s\n'  "$bucket_sec"
    printf '      arch: %s\n' "$bucket_arch"
    printf '    capabilities:\n'
    printf '      pre_push_hook: "%s"\n'  "$pre_push_hook"
    printf '      agents_count: %s\n'    "$agents_count"
    printf '      agent_memory_dir: %s\n' "$agent_memory_dir"
    printf '      team_review_config: "%s"\n' "$team_review_config"
    printf '      conventional_commits_enforced: %s\n' "$conventional_commits"
    printf '      base_branch: %s\n'      "$base_branch"
  } > "$splice_file"

  # Per-repo event, delegated to the shared YAML helper. Idempotency by
  # repo path hash — second runs (re-discovery) are no-ops.
  key_hash=$(printf '%s' "$repo" | cksum 2>/dev/null | awk '{print $1}')
  if ! grep -qF "repo_capabilities:${key_hash}" "$state_file" 2>/dev/null; then
    jq -n \
      --arg ts                         "$ts" \
      --arg repo                       "$repo" \
      --arg wt_prefix                  "$wt_prefix" \
      --arg stack                      "$stack" \
      --arg pre_push_hook              "$pre_push_hook" \
      --arg claude_agents_dir          "$agents_count" \
      --arg agent_memory_dir           "$agent_memory_dir" \
      --arg team_review_config         "$team_review_config" \
      --arg conventional_commits       "$conventional_commits" \
      --arg base_branch                "$base_branch" \
      --arg key_hash                   "$key_hash" '{
        ts:                            $ts,
        kind:                          "repo_capabilities",
        repo:                          $repo,
        wt_prefix:                     $wt_prefix,
        stack:                         $stack,
        pre_push_hook:                 $pre_push_hook,
        claude_agents_dir:             $claude_agents_dir,
        agent_memory_dir:              $agent_memory_dir,
        team_review_config:            $team_review_config,
        conventional_commits_enforced: $conventional_commits,
        base_branch:                   $base_branch,
        dedupe_key:                    ("repo_capabilities:" + $key_hash)
      }' | IA_TW_STATE_DIR="$state_dir" bash "$writer" || true
  fi
done < "$needs_file"

# Single awk pass for the splice (events were already inserted above by
# the helper, so this pass no longer touches the events: block).
tmp=$(mktemp 2>/dev/null) || { rm -rf "$discovery_dir" "$needs_file"; exit 0; }

awk -v dir="$discovery_dir" '
  BEGIN { state = "pre" }
  state == "pre" && /^---$/ { state = "front"; print; next }
  state == "front" && /^---$/ { state = "body"; print; next }
  state == "front" && /^[[:space:]]+wt_prefix:[[:space:]]/ {
    print
    prefix = $0
    sub(/^[[:space:]]+wt_prefix:[[:space:]]*/, "", prefix)
    splice_file = dir "/" prefix ".splice"
    if ((getline t < splice_file) > 0) {
      print t
      while ((getline t < splice_file) > 0) print t
      close(splice_file)
    }
    next
  }
  { print }
' "$state_file" > "$tmp" 2>/dev/null

if [ -s "$tmp" ]; then
  cat "$tmp" > "$state_file" 2>/dev/null || true
fi

rm -rf "$discovery_dir" 2>/dev/null
rm -f "$needs_file" "$tmp" 2>/dev/null

# ── Trigger sync-agents so the freshly-classified repo-local agents land
#    as <basename>-<name>.md symlinks/copies before the lead dispatches.
#    Best-effort: failure here does not regress the splice above.
sync_hook="$(dirname "$0")/../bookkeeping/sync-agents.sh"
[ -x "$sync_hook" ] && bash "$sync_hook" >/dev/null 2>&1 || true

exit 0
