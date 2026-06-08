#!/usr/bin/env bash
# lib/config.sh — resolve effective config values for the agent-harness.
#
# Source this file from a stage script:
#   source "$PLUGIN_ROOT/lib/config.sh"
#   config_init                       # ensures $HOME/.agent-harness/config.yaml exists
#   model=$(config_get default_model) # env > repo > user > default
#   IFS=':' read -ra roots <<<"$(config_get repo_roots)"
#
# Resolution order for every key:
#   1. AGENT_HARNESS_<KEY_UPPER>           (env)
#   2. <repo>/.agent-harness/config.yaml   (per-repo overlay)
#   3. <home>/config.yaml                  (user)
#   4. hardcoded default below
#
# Per-repo overlay: starts at $PWD (or $AGENT_HARNESS_REPO_PWD if set
# by the caller) and walks up until it finds .agent-harness/config.yaml
# or hits $HOME / `/`. Stages that touch a worktree set
# $AGENT_HARNESS_REPO_PWD to that worktree path before sourcing this
# file so the overlay attaches to the right repo, not the operator's
# shell cwd.
#
# Per-stage model override:
#   AGENT_HARNESS_MODEL_<STAGE_UPPER>  (env only)
#   config_models.<stage>              (in either repo or user yaml)

set -euo pipefail

_ah_home() {
  echo "${AGENT_HARNESS_HOME:-$HOME/.agent-harness}"
}

_ah_config_file() {
  echo "$(_ah_home)/config.yaml"
}

# Walk up from $AGENT_HARNESS_REPO_PWD (fallback $PWD) looking for
# `.agent-harness/config.yaml`. Stop at $HOME or `/`. Prints the
# absolute path of the first hit, or nothing.
_ah_repo_config_file() {
  local start="${AGENT_HARNESS_REPO_PWD:-$PWD}"
  local dir="$start"
  local stop="$HOME"
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    if [[ -f "$dir/.agent-harness/config.yaml" ]]; then
      echo "$dir/.agent-harness/config.yaml"
      return
    fi
    [[ "$dir" == "$stop" ]] && break
    dir="$(dirname "$dir")"
  done
}

# Hardcoded defaults — keep in sync with docs/config.md.
_ah_default() {
  case "$1" in
    home)          _ah_home ;;
    session_root)  echo "$(_ah_home)/sessions" ;;
    repo_roots)    echo "$HOME/development" ;;
    default_model) echo "haiku" ;;
    max_repos)     echo "8" ;;
    language)      echo "auto" ;;
    *) return 1 ;;
  esac
}

config_init() {
  local home cfg
  home="$(_ah_home)"
  cfg="$(_ah_config_file)"
  mkdir -p "$home/sessions"
  if [[ ! -f "$cfg" ]]; then
    cat >"$cfg" <<YAML
# agent-harness user config — edit freely.
# Unknown keys are ignored. Env vars (AGENT_HARNESS_*) override these.
session_root: $(_ah_default session_root)
repo_roots:
  - $HOME/development
default_model: $(_ah_default default_model)
stage_models: {}
max_repos: $(_ah_default max_repos)
language: $(_ah_default language)
YAML
  fi
}

# _ah_read_from_yaml <yaml-file> <key> — extract the value of <key>.
# For list-valued keys (currently only repo_roots) the result is
# colon-separated, mirroring PATH conventions.
_ah_read_from_yaml() {
  local cfg="$1" key="$2" val
  case "$key" in
    repo_roots)
      val="$(yq -r '.repo_roots // [] | join(":")' "$cfg" 2>/dev/null || true)"
      ;;
    *)
      val="$(yq -r ".${key} // \"\"" "$cfg" 2>/dev/null || true)"
      ;;
  esac
  [[ -n "$val" && "$val" != "null" ]] && echo "$val"
}

# config_get <key> — resolve one config value, env > repo > user > default.
config_get() {
  local key="$1" envk val repo_cfg user_cfg
  envk="AGENT_HARNESS_$(echo "$key" | tr '[:lower:]' '[:upper:]')"
  val="${!envk:-}"
  if [[ -n "$val" ]]; then echo "$val"; return; fi

  repo_cfg="$(_ah_repo_config_file)"
  if [[ -n "$repo_cfg" && -f "$repo_cfg" ]]; then
    val="$(_ah_read_from_yaml "$repo_cfg" "$key")"
    if [[ -n "$val" ]]; then echo "$val"; return; fi
  fi

  user_cfg="$(_ah_config_file)"
  if [[ -f "$user_cfg" ]]; then
    val="$(_ah_read_from_yaml "$user_cfg" "$key")"
    if [[ -n "$val" ]]; then echo "$val"; return; fi
  fi

  _ah_default "$key"
}

# config_model <stage> — model for this stage, with override hierarchy.
config_model() {
  local stage="$1" envk val repo_cfg user_cfg
  envk="AGENT_HARNESS_MODEL_$(echo "$stage" | tr '[:lower:]-' '[:upper:]_')"
  val="${!envk:-}"
  if [[ -n "$val" ]]; then echo "$val"; return; fi

  repo_cfg="$(_ah_repo_config_file)"
  if [[ -n "$repo_cfg" && -f "$repo_cfg" ]]; then
    val="$(yq -r ".stage_models.\"${stage}\" // \"\"" "$repo_cfg" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "null" ]]; then echo "$val"; return; fi
  fi

  user_cfg="$(_ah_config_file)"
  if [[ -f "$user_cfg" ]]; then
    val="$(yq -r ".stage_models.\"${stage}\" // \"\"" "$user_cfg" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "null" ]]; then echo "$val"; return; fi
  fi

  config_get default_model
}
