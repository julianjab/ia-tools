#!/usr/bin/env bash
# load-tw-config.sh — read .claude/team-workflow.yaml and export the env vars
# the team-workflow stack consumes (IA_TW_*, SLACK_TOPICS, ALLOWED_USERS_*).
#
# This script is meant to be SOURCED, not executed, so the exports land in the
# caller's environment:
#
#   . "${CLAUDE_PLUGIN_ROOT}/skills/session/scripts/load-tw-config.sh"
#
# Resolution cascade (lower wins are overridden by higher):
#   1. defaults baked in this script (none — we only emit vars the yaml declares)
#   2. ~/.claude/team-workflow.yaml         (user-level, optional)
#   3. <repo>/.claude/team-workflow.yaml    (project-level, optional)
#   4. $IA_TW_CONFIG (explicit path)        (operator override, optional)
#   5. env vars that were already set BEFORE this script ran        ← always win
#
# `${VAR}` references inside string values are interpolated against the
# current process environment. Unset references become empty strings.
#
# Hard requirement: `yq` (mikefarah/yq, v4+) MUST be installed. We don't
# carry a fallback parser — yq is in the pod image and trivially installable
# on dev workstations (`brew install yq`, `apt install yq`).

set -euo pipefail

if ! command -v yq >/dev/null 2>&1; then
  echo "load-tw-config: yq not found in PATH. Install it:" >&2
  echo "  macOS:  brew install yq" >&2
  echo "  Linux:  apt install yq   # or download from github.com/mikefarah/yq" >&2
  echo "  Docker pod: the Dockerfile installs yq automatically." >&2
  return 1 2>/dev/null || exit 1
fi

# --- 1. Locate the highest-priority config file ------------------------------
tw_config_path=""
for candidate in \
  "${IA_TW_CONFIG:-}" \
  "${PWD}/.claude/team-workflow.yaml" \
  "${HOME}/.claude/team-workflow.yaml"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    tw_config_path="$candidate"
    break
  fi
done

if [ -z "$tw_config_path" ]; then
  # No config — nothing to load. Caller falls back to env-only mode.
  return 0 2>/dev/null || exit 0
fi

echo "load-tw-config: reading $tw_config_path" >&2

# --- 2. Interpolate ${VAR} refs against the current env ----------------------
# yq sees the file post-substitution so values are plain strings.
substituted=$(envsubst < "$tw_config_path")

# Helper: read a scalar field; emit only when non-empty AND env doesn't override.
_emit_if_unset() {
  local var_name="$1" yaml_path="$2"
  if [ -n "${!var_name:-}" ]; then
    return 0                                             # env wins, keep it
  fi
  local value
  value=$(printf '%s\n' "$substituted" | yq -r "$yaml_path // \"\"")
  if [ -n "$value" ] && [ "$value" != "null" ]; then
    export "$var_name=$value"
  fi
}

# --- 3. Map yaml fields → env vars -------------------------------------------

_emit_if_unset IA_TW_DISPATCH_AGENT     '.router.dispatch.agent'
_emit_if_unset IA_TW_DISPATCH_PROVISION '.router.dispatch.provision'
_emit_if_unset IA_TW_REPO_URL           '.router.dispatch.repo_url'
_emit_if_unset IA_TW_STATE_ROOT         '.state.root'
_emit_if_unset GIT_AUTHOR_NAME          '.git.author_name'
_emit_if_unset GIT_AUTHOR_EMAIL         '.git.author_email'

# --- 4. Lists (repos, slack topics) ------------------------------------------

# repos: list of strings OR list of {url, name}. We accept either shape.
if [ -z "${IA_TW_REPO_URLS:-}" ]; then
  repo_urls=$(printf '%s\n' "$substituted" \
    | yq -r '[.repos[]? | (if type == "!!map" then .url else . end)] | join(",")' 2>/dev/null || echo "")
  if [ -n "$repo_urls" ] && [ "$repo_urls" != "null" ]; then
    export IA_TW_REPO_URLS="$repo_urls"
  fi
fi

# slack.topics: list of strings. Materialize as SLACK_TOPICS CSV.
if [ -z "${SLACK_TOPICS:-}" ]; then
  topics=$(printf '%s\n' "$substituted" \
    | yq -r '[.slack.topics[]?] | join(",")' 2>/dev/null || echo "")
  if [ -n "$topics" ] && [ "$topics" != "null" ]; then
    export SLACK_TOPICS="$topics"
  fi
fi

# --- 5. Access control → bridge env vars -------------------------------------
# Three shapes per axis (dm / mentions):
#   true     → "*"   (any user, slack-bridge wildcard)
#   false    → ""    (deny all, slack-bridge default)
#   [U1,U2]  → CSV   (explicit allowlist)
#   absent   → don't emit (respect any existing env)

_emit_access_var() {
  local env_var="$1" yaml_path="$2"
  if [ -n "${!env_var:-}" ]; then
    return 0
  fi
  local kind value
  kind=$(printf '%s\n' "$substituted" | yq -r "$yaml_path | tag")
  case "$kind" in
    '!!bool')
      value=$(printf '%s\n' "$substituted" | yq -r "$yaml_path")
      if [ "$value" = "true" ]; then
        export "$env_var=*"
      else
        export "$env_var="
      fi
      ;;
    '!!seq')
      value=$(printf '%s\n' "$substituted" | yq -r "[$yaml_path[]] | join(\",\")")
      export "$env_var=$value"
      ;;
    *) ;;                                                # null / scalar / absent → no-op
  esac
}

_emit_access_var ALLOWED_USERS_DM       '.access.dm'
_emit_access_var ALLOWED_USERS_MENTIONS '.access.mentions'

unset _emit_if_unset _emit_access_var substituted tw_config_path
