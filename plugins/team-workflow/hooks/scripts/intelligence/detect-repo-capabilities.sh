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
#               (name + first 240 chars of description), then:
#        Stage A (regex, deterministic):
#          ^(qa|tester)(-.*)?           → qa candidate
#          ^(security|sec-review|sec)(-.*)?  → sec candidate
#          ^(architect|api)(-.*)?       → arch candidate
#        Stage B (Haiku via fast_claude) on whatever's left:
#          Ask which agent is the IMPLEMENTER for the detected stack,
#          and whether any of them are actually an ARCHITECT despite
#          not matching the name regex.
#
#   4. Final bucket assignment with fallback chain:
#        impl  → first repo-local impl candidate (from Haiku)
#                → impl-${wt_prefix} (plugin implementer fallback)
#        qa    → first repo-local qa candidate → ${IA_TW_TOPIC_WORKER_AGENT} → lead
#        sec   → first repo-local sec candidate → ${IA_TW_TOPIC_WORKER_AGENT} → lead
#        arch  → first repo-local arch candidate → Haiku arch → ${IA_TW_TOPIC_WORKER_AGENT} → implementer
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

# ── Helper: classify agents into qa/sec/arch via regex; remainder ──────────
classify_agents_regex() {
  local repo="$1"
  cand_qa=""; cand_sec=""; cand_arch=""; unclassified=""
  local agents_dir="${repo}/.claude/agents"
  [ -d "$agents_dir" ] || return 0

  local f name desc meta
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    meta=$(extract_agent_metadata "$f")
    [ -n "$meta" ] || continue
    name="${meta%%|*}"
    desc="${meta#*|}"
    [ -n "$name" ] || continue

    case "$name" in
      qa|tester|qa-*|tester-*) cand_qa="${cand_qa}${name}"$'\n' ;;
      security|sec-review|sec|security-*|sec-review-*|sec-*) cand_sec="${cand_sec}${name}"$'\n' ;;
      architect|api|architect-*|api-*) cand_arch="${cand_arch}${name}"$'\n' ;;
      *) unclassified="${unclassified}${name}|${desc}"$'\n' ;;
    esac
  done < <(find "$agents_dir" -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort)
}

# ── Helper: ask Haiku which unclassified agent is the impl/architect ─────────
ask_haiku_impl_arch() {
  local stack="$1" pairs="$2"
  haiku_impl=""; haiku_arch=""
  [ -n "$pairs" ] || return 0

  local agents_yaml
  agents_yaml=$(printf '%s' "$pairs" | while IFS='|' read -r n d; do
    [ -n "$n" ] || continue
    printf -- '- name: %s\n  description: %s\n' "$n" "$d"
  done)
  [ -n "$agents_yaml" ] || return 0

  local classifier_prompt="A repo with stack '${stack}' has these candidate agents. Pick the IMPLEMENTER (the one that writes feature code) and, if any, the ARCHITECT (designs structure / contracts, not implementation). Use the agent descriptions:

${agents_yaml}

If no agent fits a role, return null for it. Output ONLY one JSON line:
{\"impl\":\"<agent-name-or-null>\",\"arch\":\"<agent-name-or-null>\"}
No prose, no markdown, no code fence."

  . "$(dirname "$0")/_fast_claude.sh"
  local resp
  resp=$(printf '%s' "$classifier_prompt" \
    | fast_claude --model claude-haiku-4-5-20251001) || resp=""

  haiku_impl=$(printf '%s' "$resp" | grep -oE '"impl"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  haiku_arch=$(printf '%s' "$resp" | grep -oE '"arch"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  [ "$haiku_impl" = "null" ] && haiku_impl=""
  [ "$haiku_arch" = "null" ] && haiku_arch=""

  if [ -n "$haiku_impl" ] && ! printf '%s' "$pairs" | grep -qF "${haiku_impl}|"; then haiku_impl=""; fi
  if [ -n "$haiku_arch" ] && ! printf '%s' "$pairs" | grep -qF "${haiku_arch}|"; then haiku_arch=""; fi
}

# ── Helper: resolve buckets with full fallback chain ─────────────────────────
resolve_buckets() {
  local wt_prefix="$1"
  local twa="${IA_TW_TOPIC_WORKER_AGENT:-}"

  local first_qa first_sec first_arch
  first_qa=$(printf '%s' "$cand_qa" | head -1)
  first_sec=$(printf '%s' "$cand_sec" | head -1)
  first_arch=$(printf '%s' "$cand_arch" | head -1)

  if [ -n "$haiku_impl" ]; then
    bucket_impl="$haiku_impl"
  else
    bucket_impl="impl-${wt_prefix}"
  fi

  if [ -n "$first_qa" ];   then bucket_qa="$first_qa";
  elif [ -n "$twa" ];      then bucket_qa="$twa";
  else                          bucket_qa="lead"; fi

  if [ -n "$first_sec" ];  then bucket_sec="$first_sec";
  elif [ -n "$twa" ];      then bucket_sec="$twa";
  else                          bucket_sec="lead"; fi

  if [ -n "$first_arch" ]; then bucket_arch="$first_arch";
  elif [ -n "$haiku_arch" ]; then bucket_arch="$haiku_arch";
  elif [ -n "$twa" ];      then bucket_arch="$twa";
  else                          bucket_arch="implementer"; fi
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
events_file=$(mktemp 2>/dev/null) || { rm -rf "$discovery_dir" "$needs_file"; exit 0; }
ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

while IFS='|' read -r wt_prefix repo worktree; do
  [ -n "$wt_prefix" ] && [ -n "$repo" ] || continue

  local_root="$repo"
  [ -n "$worktree" ] && [ -d "${worktree}/.claude" ] && local_root="$worktree"

  stack=$(detect_stack "$local_root")
  eval "$(probe_capabilities "$local_root")"

  classify_agents_regex "$local_root"
  ask_haiku_impl_arch "$stack" "$unclassified"
  resolve_buckets "$wt_prefix"

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

  key_hash=$(printf '%s' "$repo" | cksum 2>/dev/null | awk '{print $1}')
  if ! grep -qF "repo_capabilities:${key_hash}" "$state_file" 2>/dev/null; then
    {
      printf '  - ts: %s\n'                  "$ts"
      printf '    kind: repo_capabilities\n'
      printf '    repo: %s\n'                "$repo"
      printf '    wt_prefix: %s\n'           "$wt_prefix"
      printf '    stack: %s\n'               "$stack"
      printf '    pre_push_hook: "%s"\n'     "$pre_push_hook"
      printf '    claude_agents_dir: %s\n'   "$agents_count"
      printf '    agent_memory_dir: %s\n'    "$agent_memory_dir"
      printf '    team_review_config: "%s"\n' "$team_review_config"
      printf '    conventional_commits_enforced: %s\n' "$conventional_commits"
      printf '    base_branch: %s\n'         "$base_branch"
      printf '    dedupe_key: repo_capabilities:%s\n' "$key_hash"
    } >> "$events_file"
  fi
done < "$needs_file"

tmp=$(mktemp 2>/dev/null) || { rm -rf "$discovery_dir" "$needs_file" "$events_file"; exit 0; }

awk -v dir="$discovery_dir" -v events_file="$events_file" '
  BEGIN { state = "pre"; has_events_header = 0 }
  state == "pre" && /^---$/ { state = "front"; print; next }
  state == "front" && /^---$/ {
    if (events_file != "") {
      gotone = 0
      while ((getline line < events_file) > 0) {
        if (!gotone && has_events_header == 0) { print "events:"; gotone = 1 }
        gotone = 1
        print line
      }
      close(events_file)
    }
    state = "body"
    print
    next
  }
  state == "front" && /^events:[[:space:]]*$/ { has_events_header = 1 }
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
rm -f "$needs_file" "$events_file" "$tmp" 2>/dev/null

exit 0
