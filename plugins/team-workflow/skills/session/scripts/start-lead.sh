#!/usr/bin/env bash
# Spawn an orchestrator sub-session in tmux (default) or iTerm2.
#
# Usage:
#   start-lead.sh <feature> <topic|""> <request> [--resume <session-id>]
#
# Exit codes:
#   0  spawned OK
#   1  argument / configuration error
#   2  requested terminal host unavailable / no usable host
#
# Exports the IA_TW_* env vars the orchestrator expects, plus SLACK_TOPICS
# for the slack-bridge MCP auto-subscribe (when topic is non-empty).
#
# Terminal selection — driven by IA_TW_TERMINAL:
#   tmux  (default fallback)  → detached tmux session named <feature>
#   iterm                     → new iTerm2 window driven by osascript
#   (unset / "auto")          → tmux if installed, else iTerm2, else fail
#
# Default behavior: tmux when present, because the rest of the system
# (notably /send-session-message) speaks tmux send-keys natively. iTerm2
# is a GUI alternative for operators who want a real window; the relay
# script auto-detects the host.
#
# Parametrization (env-var overridable — this is what makes team-workflow
# non-static; the spawner picks the persona and provisioning strategy):
#   IA_TW_AGENT              Agent to boot. Default: team-workflow:lead.
#                            e.g. team-workflow:repo-worker for single-repo,
#                            clone-work-PR sessions inside a long-lived pod.
#   IA_TW_TOPIC_WORKER_AGENT topic-worker persona the router spawns for
#                            answer/ask intents. Default: team-workflow:topic-worker.
#   IA_TW_PROVISION          worktree-local (default) | clone | none.
#   IA_TW_REPO_URL           Singular repo URL when IA_TW_PROVISION=clone.
#   IA_TW_REPO_URLS          CSV of repo URLs for multi-repo pods. Pre-clone
#                            iterates over this list when set.
#   IA_TW_TERMINAL           tmux | iterm | auto (default auto → tmux first).
#
# Configuration cascade: if .claude/team-workflow.yaml exists in $PWD or
# $HOME, load-tw-config.sh maps it into these env vars before we spawn.
# Env vars already set always win over the file.
set -euo pipefail

# Load .claude/team-workflow.yaml when present (env wins). Tolerate missing yq.
_loader="$(dirname "${BASH_SOURCE[0]}")/load-tw-config.sh"
if [ -f "$_loader" ]; then
  # shellcheck disable=SC1090
  . "$_loader" || echo "start-lead: load-tw-config.sh skipped (yq missing or error)" >&2
fi

feature="${1:?feature required}"
topic="${2:-}"
request="${3:?request required}"
shift 3 || true

# Optional flags after the three positional args.
resume_id=""
while [ $# -gt 0 ]; do
  case "$1" in
    --resume)
      resume_id="${2:?--resume requires a session-id}"
      shift 2
      ;;
    --resume=*)
      resume_id="${1#--resume=}"
      shift
      ;;
    *)
      echo "start-lead: unknown argument '$1'" >&2
      exit 1
      ;;
  esac
done

agent="${IA_TW_AGENT:-team-workflow:lead}"
topic_worker_agent="${IA_TW_TOPIC_WORKER_AGENT:-team-workflow:topic-worker}"
provision="${IA_TW_PROVISION:-worktree-local}"
repo_url="${IA_TW_REPO_URL:-}"
repo_urls="${IA_TW_REPO_URLS:-}"
terminal_pref="${IA_TW_TERMINAL:-auto}"

# Topic hash: $topic if set, else "local:$feature".
hash_key="${topic:-local:$feature}"
topic_hash=$(printf '%s' "$hash_key" | shasum | head -c 12)

state_dir="$HOME/.claude/team-workflow/state/$topic_hash"
mkdir -p "$state_dir"

# ─── Resolve parent-IPC socket (used by the util to populate the env) ─────
# Prefer the env value (direct spawn); fall back to the pointer file the
# router wrapper writes at boot (covers indirect spawns from skills that
# don't inherit env).
parent_sock="${IA_TW_PARENT_SOCK:-}"
if [ -z "$parent_sock" ] && [ -r "${HOME}/.claude/team-workflow/ipc/current.sock" ]; then
  parent_sock="$(cat "${HOME}/.claude/team-workflow/ipc/current.sock" 2>/dev/null || true)"
fi

# ─── Write $state_dir/.claude/settings.local.json (envs + MCP servers) ─────
# Replaces the previous "env VAR=… claude …" + "--mcp-config" combo. The
# helper writes a Claude Code-native settings.local.json with the per-
# session env block and MCP servers (figma, slack, slack-bridge); claude
# picks it up automatically because the session boots with cwd = state_dir.
# Tokens (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, SLACK_*_TOKEN) stay
# out of the file by design and are forwarded only via process env below.
gen_util="$(dirname "${BASH_SOURCE[0]}")/generate-session-settings.sh"
if [ -x "$gen_util" ]; then
  IA_TW_FEATURE="$feature" \
  IA_TW_TOPIC="${topic:-local}" \
  IA_TW_ROOT_DIR="$PWD" \
  IA_TW_STATE_DIR="$state_dir" \
  IA_TW_AGENT="$agent" \
  IA_TW_TOPIC_WORKER_AGENT="$topic_worker_agent" \
  IA_TW_PROVISION="$provision" \
  IA_TW_REPO_URL="${repo_url:-}" \
  IA_TW_REPO_URLS="${repo_urls:-}" \
  IA_TW_REPO_CACHE_DIR="${IA_TW_REPO_CACHE_DIR:-}" \
  IA_TW_PARENT_SOCK="$parent_sock" \
  ALLOWED_USERS_DM="${ALLOWED_USERS_DM:-}" \
  ALLOWED_USERS_MENTIONS="${ALLOWED_USERS_MENTIONS:-}" \
  DAEMON_URL="${DAEMON_URL:-}" \
    bash "$gen_util" "$state_dir" >/dev/null || \
      printf '⚠ generate-session-settings.sh exited non-zero — settings.local.json may be incomplete.\n' >&2
else
  printf '⚠ generate-session-settings.sh missing or non-executable: %s\n' "$gen_util" >&2
  printf '  Session will boot without a settings.local.json — envs come from the launching shell.\n' >&2
fi

# ─── Process-env passthrough — tokens ONLY ─────────────────────────────────
# Everything non-secret already lives in settings.local.json. Tokens stay
# in the launching process env (and the env_pairs array below) so they
# never touch disk. CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS / DISABLE_AGENT_VIEW
# also pass through here because Claude Code reads them before loading
# settings.json (they affect bootstrap).
env_pairs=(
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
  "CLAUDE_CODE_DISABLE_AGENT_VIEW=1"
)
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && env_pairs+=("CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
[ -n "${ANTHROPIC_API_KEY:-}" ]       && env_pairs+=("ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
[ -n "${SLACK_BOT_TOKEN:-}" ]         && env_pairs+=("SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN")
[ -n "${SLACK_APP_TOKEN:-}" ]         && env_pairs+=("SLACK_APP_TOKEN=$SLACK_APP_TOKEN")

# ─── Detect terminals ───────────────────────────────────────────────────────
have_tmux() { command -v tmux >/dev/null 2>&1; }

have_iterm() {
  command -v osascript >/dev/null 2>&1 || return 1
  # `osascript -e 'id of application "iTerm"'` returns the bundle id when
  # iTerm.app is installed; non-zero exit if missing.
  osascript -e 'id of application "iTerm"' >/dev/null 2>&1
}

install_hint() {
  cat >&2 <<EOF
✗ No usable terminal host for the lead sub-session.

start-lead.sh needs one of:
  • tmux    — install with: brew install tmux            (default)
  • iTerm2  — install from https://iterm2.com            (alternative)

Install one, then re-run /session. To force a specific host set
IA_TW_TERMINAL=tmux or IA_TW_TERMINAL=iterm.
EOF
}

case "$terminal_pref" in
  tmux)
    if ! have_tmux; then
      echo "✗ IA_TW_TERMINAL=tmux but tmux is not on PATH." >&2
      echo "  Install with: brew install tmux" >&2
      exit 2
    fi
    chosen="tmux"
    ;;
  iterm)
    if ! have_iterm; then
      echo "✗ IA_TW_TERMINAL=iterm but iTerm2 is not installed (osascript can't find 'iTerm')." >&2
      echo "  Install from https://iterm2.com or unset IA_TW_TERMINAL to fall back to tmux." >&2
      exit 2
    fi
    chosen="iterm"
    ;;
  auto|"")
    # Default: tmux first (keeps tmux-based relays working), iTerm2 fallback.
    if have_tmux; then
      chosen="tmux"
    elif have_iterm; then
      chosen="iterm"
    else
      install_hint
      exit 2
    fi
    ;;
  *)
    echo "✗ IA_TW_TERMINAL='$terminal_pref' invalid. Use 'tmux', 'iterm', or 'auto'." >&2
    exit 1
    ;;
esac

# ─── Session env manifest (for /worktree rehydrate discovery) ──────────────
# Write a sidecar YAML next to state.md so any operator session can list
# every running feature, see the env it was launched with, and pick which
# state_dir to rehydrate. Secrets (OAuth tokens) are deliberately excluded
# — state_dir lives under $HOME and is not git-tracked, but we still keep
# manifests free of bearer credentials so they can be pasted into bug
# reports or shared between machines safely.
{
  printf 'feature: %s\n'        "$feature"
  printf 'topic: %s\n'          "${topic:-local}"
  printf 'state_dir: %s\n'      "$state_dir"
  printf 'root_dir: %s\n'       "$PWD"
  printf 'agent: %s\n'          "$agent"
  printf 'provision: %s\n'      "$provision"
  printf 'terminal: %s\n'       "$chosen"
  printf 'started_at: %s\n'     "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'boot_host: %s\n'      "$(hostname -s 2>/dev/null || echo unknown)"
  printf 'boot_pid: %s\n'       "$$"
  [ -n "${topic_worker_agent:-}" ] && printf 'topic_worker_agent: %s\n' "$topic_worker_agent"
  [ -n "${repo_url:-}" ]           && printf 'repo_url: %s\n'           "$repo_url"
  [ -n "${repo_urls:-}" ]          && printf 'repo_urls: %s\n'          "$repo_urls"
  # Request can be multiline — store on a single line with literal '\n'.
  printf 'request: %s\n' "$(printf '%s' "$request" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
} > "$state_dir/session-env.yaml" 2>/dev/null || true

# ─── Spawn: tmux ───────────────────────────────────────────────────────────
if [ "$chosen" = "tmux" ]; then
  # MCP servers + per-session env now come from $state_dir/.claude/settings.local.json
  # (boot cwd = $state_dir → Claude Code picks it up automatically).
  claude_args=(--agent "$agent"
               --dangerously-load-development-channels plugin:slack-bridge@ia-tools
               --dangerously-skip-permissions)
  [ -n "$resume_id" ] && claude_args+=(--resume "$resume_id")
  claude_args+=("$request")

  # Boot cwd = $state_dir so the session anchors on the per-feature state
  # workspace (state.md, hook-audit.log, mcp-config.json, session-env.yaml)
  # instead of a consumer repo. /add-dir adds repos/worktrees explicitly
  # via /worktree init — keeping cwd stable.
  tmux new-session -d -s "$feature" -c "$state_dir" -- \
    env "${env_pairs[@]}" \
    claude "${claude_args[@]}"

  # Boot-prompt poller: dismisses the two one-time prompts (dev-channels
  # warning + trust-folder) by sending Enter when their patterns appear.
  # Runs at most 30s in background, then exits — does NOT touch later
  # prompts like ExitPlanMode.
  (
    for _ in $(seq 1 15); do
      sleep 2
      out=$(tmux capture-pane -p -t "$feature" 2>/dev/null | tail -15) || break
      case "$out" in
        *"local development"*|*"Trust the files"*|*"trust the files"*|*"Do you trust"*)
          tmux send-keys -t "$feature" Enter
          ;;
      esac
    done
  ) >/dev/null 2>&1 &

  echo "✓ $agent spawned (tmux: $feature, provision: $provision, state: $state_dir)"
  echo "  topic-worker: $topic_worker_agent"
  [ -n "$repo_url$repo_urls" ] && echo "  repo(s): ${repo_urls:-$repo_url}"
  echo "  attach: tmux attach -t $feature"
  exit 0
fi

# ─── Spawn: iTerm2 ─────────────────────────────────────────────────────────
# iTerm2 path: write a single-use launcher script to a temp file, then ask
# iTerm2 (via AppleScript) to open a new window running it. The launcher
# exports env vars and execs claude — this avoids the AppleScript quoting
# nightmare of inlining env_args + request into a single command string.
# The launcher self-deletes once claude exits.
launcher="$(mktemp -t ia-tw-lead-XXXXXX.sh)"
{
  echo '#!/usr/bin/env bash'
  echo 'set -e'
  for kv in "${env_pairs[@]}"; do
    # printf %q quotes safely for bash eval.
    printf 'export %q\n' "$kv"
  done
  # Anchor cwd on the per-feature state workspace (see tmux branch above).
  printf 'cd %q\n' "$state_dir"
  # MCP servers + per-session env come from $state_dir/.claude/settings.local.json.
  printf 'exec claude --agent %q \\\n' "$agent"
  printf '  --dangerously-load-development-channels plugin:slack-bridge@ia-tools \\\n'
  printf '  --dangerously-skip-permissions \\\n'
  [ -n "$resume_id" ] && printf '  --resume %q \\\n' "$resume_id"
  printf '  %q\n' "$request"
} > "$launcher"
chmod +x "$launcher"

# Wrap in a tiny shell that runs the launcher then removes it. Single-quote
# the path because mktemp output has no shell-special chars.
runner="bash -c '\"$launcher\"; rm -f \"$launcher\"; exec \$SHELL'"

# Tab/session name = feature, so /send-session-message can find it.
osascript >/dev/null <<APPLESCRIPT
tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    set name to "$feature"
    write text "$runner"
  end tell
end tell
APPLESCRIPT

# Boot-prompt poller (iTerm2 mirror of the tmux poller above): read the
# visible contents of the session by name, and if Claude's dev-channels
# warning or the trust-folder prompt is on screen, fire an Enter via
# `write text "" newline YES`. Runs at most 30s; harmless after boot.
(
  for _ in $(seq 1 15); do
    sleep 2
    out=$(osascript <<APPLESCRIPT 2>/dev/null
tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if name of s is "$feature" then return contents of s
      end repeat
    end repeat
  end repeat
  return ""
end tell
APPLESCRIPT
)
    case "$out" in
      *"local development"*|*"Trust the files"*|*"trust the files"*|*"Do you trust"*)
        osascript >/dev/null 2>&1 <<APPLESCRIPT
tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if name of s is "$feature" then
          tell s to write text "" newline YES
          return
        end if
      end repeat
    end repeat
  end repeat
end tell
APPLESCRIPT
        ;;
    esac
  done
) >/dev/null 2>&1 &

echo "✓ $agent spawned (iTerm2 window: $feature, provision: $provision, state: $state_dir)"
echo "  topic-worker: $topic_worker_agent"
[ -n "$repo_url$repo_urls" ] && echo "  repo(s): ${repo_urls:-$repo_url}"
echo "  relay: /send-session-message auto-detects iTerm2 sessions by name."
