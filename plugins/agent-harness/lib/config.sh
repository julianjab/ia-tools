#!/usr/bin/env bash
# lib/config.sh — resolve effective config values for the agent-harness.
#
# Source this file from a stage script:
#   source "$PLUGIN_ROOT/lib/config.sh"
#   config_init                       # ensures $HOME/.agent-harness/config.yaml exists
#   model=$(config_get default_model) # env > file > default
#   IFS=':' read -ra roots <<<"$(config_get repo_roots)"
#
# Resolution order for every key:
#   1. AGENT_HARNESS_<KEY_UPPER>  (env)
#   2. value from <home>/config.yaml
#   3. hardcoded default below
#
# Per-stage model override:
#   AGENT_HARNESS_MODEL_<STAGE_UPPER>  (env only; no config-file equivalent yet)

set -euo pipefail

_ah_home() {
  echo "${AGENT_HARNESS_HOME:-$HOME/.agent-harness}"
}

_ah_config_file() {
  echo "$(_ah_home)/config.yaml"
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

# config_get <key> — resolve one config value.
#
# For list-valued keys (currently only repo_roots) the result is
# colon-separated, mirroring PATH conventions.
config_get() {
  local key="$1" envk val cfg
  envk="AGENT_HARNESS_$(echo "$key" | tr '[:lower:]' '[:upper:]')"
  val="${!envk:-}"
  if [[ -n "$val" ]]; then
    echo "$val"
    return
  fi
  cfg="$(_ah_config_file)"
  if [[ -f "$cfg" ]]; then
    case "$key" in
      repo_roots)
        val="$(yq -r '.repo_roots // [] | join(":")' "$cfg" 2>/dev/null || true)"
        ;;
      *)
        val="$(yq -r ".${key} // \"\"" "$cfg" 2>/dev/null || true)"
        ;;
    esac
    if [[ -n "$val" && "$val" != "null" ]]; then
      echo "$val"
      return
    fi
  fi
  _ah_default "$key"
}

# config_model <stage> — model for this stage, with override hierarchy.
config_model() {
  local stage="$1" envk val cfg
  envk="AGENT_HARNESS_MODEL_$(echo "$stage" | tr '[:lower:]-' '[:upper:]_')"
  val="${!envk:-}"
  if [[ -n "$val" ]]; then
    echo "$val"
    return
  fi
  cfg="$(_ah_config_file)"
  if [[ -f "$cfg" ]]; then
    val="$(yq -r ".stage_models.\"${stage}\" // \"\"" "$cfg" 2>/dev/null || true)"
    if [[ -n "$val" && "$val" != "null" ]]; then
      echo "$val"
      return
    fi
  fi
  config_get default_model
}
