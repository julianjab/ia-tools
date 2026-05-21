# Structured bash — style rules for hooks, repo scripts, and skill bash blocks

These rules turn ad-hoc shell scripts into a predictable, auditable surface.
They are the single source of truth for the `script-author` agent and the
`/audit-script` / `/edit-script` / `/new-script` skills.

Three contexts apply:

- **hooks** — files under `plugins/<plugin>/hooks/scripts/`, registered in
  `plugins/<plugin>/hooks/hooks.json`. Receive a JSON payload on stdin from
  Claude Code, may write a JSON response, exit code semantics matter
  (`PreToolUse` / `TaskCompleted` / `TeammateIdle` accept `2` to block).
- **scripts** — files under `scripts/` (repo root) or `plugins/<plugin>/scripts/`.
  Invoked by humans or CI. argv-driven, plain exit codes.
- **skill bash blocks** — fenced ``` ```bash ``` regions inside `SKILL.md`.
  Run inline by Claude; no shebang, no shared state across blocks.

The rules below are numbered `S1`–`S20`. `script-author` writes scripts that
PASS every rule; `audit-script` reports violations with severity.

---

## S1 — Shebang and `set` flags (hooks, scripts only)

| Context | Shebang | `set` flags | Reason |
|---|---|---|---|
| Hooks (any bucket) | `#!/usr/bin/env bash` | `set -u` (always); `set -euo pipefail` ONLY when bucket = `enforcement` AND you exit on failure | `pipefail` propagates `jq` errors in pipelines; in `intelligence`/`bookkeeping` it would block on best-effort code |
| Repo scripts | `#!/usr/bin/env bash` | `set -euo pipefail` | Failing fast is what the user expects |
| Skill bash blocks | no shebang | inherit from caller | Lives inside markdown |

Hooks **MUST NOT** use `set -e` outside `enforcement/`. Bookkeeping and
intelligence must always reach the final `exit 0` — they are non-blocking.

Severity: HIGH (hook with `set -e` outside enforcement breaks the
non-blocking contract).

---

## S2 — Header doc-comment (hooks, scripts)

Every hook and repo script starts with a structured header comment as the
first non-shebang lines. The fields are fixed:

```bash
#!/usr/bin/env bash
# <one-line purpose>
#
# Bucket: enforcement | bookkeeping | intelligence | script   (hooks only)
# Listens to: <event-name>[, <event-name>...]                  (hooks only)
# Blocking: yes (may exit 2) | no (always exit 0)              (hooks only)
# Input  (stdin JSON): { ... shape ... }                       (hooks only)
# Output: <description of stdout/exit-code semantics>
#
# <2-6 lines describing what it does, in declarative voice>
```

For repo scripts, drop `Bucket`/`Listens to`/`Blocking`/`Input` and add:

```bash
# Usage: <script-name> [--flag] <positional>
# Exit codes: 0 = ok, 1 = caller error, 2 = upstream failure, ...
```

Severity: MEDIUM (missing or malformed header).

---

## S3 — Payload parsing — defensive

Hooks read the payload exactly once into a variable, then parse from
that variable. Never `cat` stdin twice.

```bash
payload=$(cat)
subject=$(printf '%s' "$payload" | jq -r '.task.subject // empty' 2>/dev/null)
[ -z "$subject" ] && { printf '{}'; exit 0; }
```

Rules:

- Always pipe `printf '%s' "$payload"` into `jq`, never `echo` (echo
  interprets `-e`, `-n` flags inside the payload).
- Always provide `// empty` as a default and check `[ -z ]` before use.
- Always redirect `jq` stderr to `/dev/null` — malformed payloads are
  not the hook's responsibility to report.
- Always `printf '{}'; exit 0` on missing required fields, never
  `exit 1`. Failing a hook with non-zero status that the harness
  interprets as block is a foot-gun.

Severity: HIGH (using `echo` or skipping the empty check leads to
silent corruption).

---

## S4 — Dispatch on `hook_event_name` when listening to multiple events

Purpose-driven hooks (the `intelligence/` bucket especially) listen to
multiple events. They MUST dispatch on `hook_event_name`, never on
payload shape sniffing:

```bash
event=$(printf '%s' "$payload" | jq -r '.hook_event_name // empty')
case "$event" in
  TaskCompleted)    handle_task_completed "$payload" ;;
  UserPromptSubmit) handle_user_prompt "$payload" ;;
  PostToolUse)      handle_tool_use "$payload" ;;
  *)                printf '{}'; exit 0 ;;
esac
```

Severity: HIGH (sniffing shape breaks when Claude Code adds new fields).

---

## S5 — Exit-code discipline

| Bucket / Context | Allowed exit codes |
|---|---|
| `enforcement/` hooks | `0` (allow) or `2` (block, with stderr feedback) |
| `bookkeeping/` hooks | `0` only |
| `intelligence/` hooks | `0` only |
| Repo scripts | `0` (ok), `1` (caller error), `2+` (typed failures, documented in header) |

Every script must end with `exit 0` (or `exit <code>` for scripts that
have already returned non-zero from inside a function). No falling off
the end of the file — make exit explicit.

Severity: HIGH (silent exit code from end-of-file is unreliable across
shells).

---

## S6 — `printf` over `echo`

Use `printf` for all output. `echo` is unreliable across shells (zsh
interprets `-e`, `-n`, `-E` flags inside arguments; some bash versions
do too with `xpg_echo` set). The `_encode:25: command not found: -e`
errors you saw in the `claude -p` runs trace to this exact mismatch.

```bash
# WRONG
echo "result: $msg"

# RIGHT
printf '%s\n' "$msg"
printf 'result: %s\n' "$msg"
```

Severity: MEDIUM (works most of the time; fails silently when content
starts with `-`).

---

## S7 — `git` and external tools always use `-C` or absolute paths

Never `cd` to change context. Always pass the working directory
explicitly:

```bash
# WRONG
cd "$repo" && git status

# RIGHT
git -C "$repo" status
```

Exceptions:

- `gh pr create` and `gh repo view` infer the repo from cwd and have no
  `-C` equivalent. Use a subshell: `( cd "$repo" && gh pr create ... )`.
- Tools that intrinsically use cwd (e.g., `pnpm install`) → subshell.

This is the project-wide convention from `CLAUDE.md` ("Worktree commands
use `-C`").

Severity: MEDIUM (causes subtle multi-repo bugs like the one fixed in
`session-end.sh`).

---

## S8 — Idempotency

Any script that mutates state outside its own process (writes a file,
appends to a log, opens a PR) MUST be safe to run twice with the same
input. Strategies:

| Mutation | Idempotency strategy |
|---|---|
| Append to log/markdown | Dedupe key check before appending (e.g., `grep -q "^## ${date}.*${feature}" "$file"` skip) |
| Create branch / PR | Check existence with `gh pr list` / `git rev-parse` before creating |
| File overwrite | OK if input → output is a pure function |
| Counter increment | Avoid — use a set / hash instead |

Severity: HIGH (non-idempotent hooks corrupt state on retry).

---

## S9 — Best-effort error handling

Side-effect scripts (`bookkeeping/`, `intelligence/`) must never crash
on parse errors, missing files, or external command failures. Use:

```bash
# Read file that may not exist
content=$(cat "$file" 2>/dev/null || true)

# Run external tool, fall back on failure
result=$(some_tool 2>/dev/null) || result=""

# Critical write — use a temp file and atomic move
tmp=$(mktemp 2>/dev/null) || tmp=""
if [ -n "$tmp" ]; then
  produce_output > "$tmp"
  [ -s "$tmp" ] && cat "$tmp" > "$target"
  rm -f "$tmp"
fi
```

Never use `||` followed by a complex compound — keep error paths
explicit so audit reads obviously.

Severity: MEDIUM (crashes in non-blocking hooks degrade the system).

---

## S10 — Bash quoting and word-splitting

- Quote every variable expansion: `"$var"`, never bare `$var`.
- Quote file paths: `"$file"`, never `$file`.
- Use `[ ]` not `[[ ]]` when the script may be sourced under POSIX shell
  (most ia-tools hooks are bash-specific, so `[[ ]]` is fine when
  shebang is `#!/usr/bin/env bash`).
- Arrays must be quoted with `"${arr[@]}"`, never `${arr[@]}`.

Severity: HIGH for unquoted file paths (breaks on spaces); LOW for
`[[` vs `[`.

---

## S11 — `awk` over `sed` for structured edits

Editing YAML/structured text with `sed` is fragile. Prefer `awk` with
explicit state machines:

```bash
# RIGHT — awk state machine
awk -v key="$key" -v val="$val" '
  BEGIN { state = "pre" }
  /^---$/ && state == "pre" { state = "front"; print; next }
  state == "front" && $0 ~ "^" key ":" { sub(/:.*/, ": " val); state = "done" }
  { print }
' "$file" > "$tmp" && mv "$tmp" "$file"
```

`sed` is fine for line-level substitutions where the match pattern is
unambiguous (e.g., updating a literal value). It's not fine for
context-aware edits (find this YAML key inside this block).

Severity: MEDIUM.

---

## S12 — Tool availability checks

Scripts that depend on external tools (`jq`, `gh`, `claude`, `tmux`)
must check availability upfront and degrade gracefully:

```bash
has_gh=0
command -v gh >/dev/null 2>&1 && has_gh=1

# Later
[ "$has_gh" -eq 1 ] || return 0
gh pr create ...
```

Hooks must never fail because an optional tool is missing.

Severity: MEDIUM.

---

## S13 — No `claude -p` in `enforcement/` or `bookkeeping/`

Calls to `claude -p` add ~1-3 s latency and depend on network. They are
acceptable only in `intelligence/` hooks and in `SessionEnd`. Never in
enforcement (must be fast) or bookkeeping (must be deterministic).

When using `claude -p`:

- Do not pass flags that change across versions (`--max-tokens`,
  `--temperature`). Use only stable flags (`--model`, `-p`).
- Always `2>/dev/null` to suppress wrapper noise.
- Always `|| true` so the script continues on failure.
- Strip ```` ```language ```` fences from the output before using it.

Severity: HIGH (using `claude -p` outside intelligence; non-stable flag).

---

## S14 — Hook output JSON

When a hook needs to return a structured decision (e.g., `PreToolUse`
deny), build the JSON with `printf`, not interpolated heredocs:

```bash
deny() {
  local reason="$1"
  local esc=${reason//\\/\\\\}
  esc=${esc//\"/\\\"}
  esc=${esc//$'\n'/\\n}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$esc"
  exit 0
}
```

Escape backslashes, quotes, and newlines explicitly. Heredocs with
unescaped content corrupt the JSON when the reason contains paths
with backslashes (Windows / WSL).

For success or no-action, emit `printf '{}'`. The harness treats empty
or absent stdout as "no override".

Severity: HIGH (malformed JSON gets ignored, hook appears to no-op
silently).

---

## S15 — Function naming and local scope

- Top-level scripts: 3-30 lines max body, helpers extracted as
  functions.
- Function names use `snake_case` and start with a verb: `resolve_X`,
  `write_Y`, `parse_Z`, `handle_W`.
- Every function declares its locals with `local`:
  ```bash
  resolve_memory_agent() {
    local agent="$1" repo="$2" role="$3"
    ...
  }
  ```
- Functions return values via stdout (`printf '%s' "$x"`), never via
  global variable assignment. The caller captures with `result=$(fn)`.

Severity: MEDIUM (global variable leaks across function calls).

---

## S16 — Doc-comment sections inside functions

Long helper functions (> 15 lines) get a brief comment block:

```bash
# ── Helper: resolve memory target agent name ───────────────────────────
# If <repo>/.claude/agents/<agent>.md exists → return <agent>.
# If agent is a fallback pattern (impl-*) → return "implementer".
# Otherwise → return empty (skip memory write).
# Args:    $1=agent  $2=repo  $3=role
# Returns: agent name on stdout, or empty.
resolve_memory_agent() {
  ...
}
```

Severity: LOW.

---

## S17 — Hooks.json registration

When the script is a hook, the matching `hooks.json` entry MUST:

- Use `${CLAUDE_PLUGIN_ROOT}` for the path, never hardcoded `/Users/...`.
- Use the correct event name(s) (PreToolUse, PostToolUse, TaskCompleted,
  TaskCreated, TeammateIdle, UserPromptSubmit, SessionStart, SessionEnd).
- Use `matcher` when filtering tool names (e.g., `"matcher": "Edit|Write"`).
- Order scripts inside one event from enforcement → bookkeeping →
  intelligence. An enforcement `exit 2` short-circuits the rest, which
  is the desired behavior.

```jsonc
"TaskCompleted": [
  { "hooks": [
      { "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/enforcement/enforce-task-invariants.sh" },
      { "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/bookkeeping/record-state-event.sh" }
  ]}
]
```

Severity: HIGH (broken `command:` path means the hook never fires).

---

## S18 — No `cd` to change session context

`cd` is acceptable in three cases only:

1. Inside a subshell `( cd "$dir" && some_tool_without_-C )` (S7).
2. In a script that explicitly documents it operates on the user's
   current directory.
3. Inside `BEGIN` of an awk script (different `cd`).

Never `cd "$HOME/some/path"` at top level — this changes the cwd for
every following invocation in the same hook process.

Severity: HIGH.

---

## S19 — Skill bash blocks have no global state

Bash blocks inside `SKILL.md` files are read by Claude and may be
executed one-at-a-time as separate processes. They MUST NOT rely on
shell state from prior blocks (variable assignments, `cd`, exported
env). Every block is self-contained.

```markdown
# WRONG
First, set the target dir:
```bash
TARGET=/some/path
```

Then write the file:
```bash
echo hello > "$TARGET/file"   # TARGET is gone
```

# RIGHT — single block, or pass values explicitly
```bash
TARGET=/some/path
mkdir -p "$TARGET"
echo hello > "$TARGET/file"
```
```

Severity: HIGH (skill bash blocks that reference variables defined in
an earlier block silently fail).

---

## S20 — `find` and `grep` rooted to a path, never bare

- `find` must always have a path argument, never start at `/`.
- `grep -r` must always have a path, never default cwd.
- Use `find . -maxdepth N` to bound search depth — unbounded `find`
  in a worktree with `node_modules` is a hang.

Severity: MEDIUM.

---

## Severity grid

| Severity | Meaning |
|---|---|
| HIGH    | Functional defect: silent corruption, broken JSON, wrong exit code, wrong cwd assumption |
| MEDIUM  | Maintenance defect: missing doc, weak idempotency, brittle parser |
| LOW     | Style: function comments, naming, ordering |

`/audit-script` blocks merge on any HIGH; reports MEDIUM as warnings;
notes LOW informationally. `/edit-script --fix` auto-fixes HIGH and
MEDIUM where the fix is mechanical (header insertion, `set -u` add,
`echo`→`printf` swap, `cd X &&`→`( cd X && ... )`).

---

## Bucket assignment (hooks only)

When auditing or generating a hook, derive its bucket from what it
does, not what file it sits in today. Use this decision tree:

```
Does it ever exit 2 to block a Claude Code action?
  Yes → enforcement
  No  → Does it call `claude -p`, `Bun.spawn` with Anthropic SDK, or any other LLM?
          Yes → intelligence
          No  → Does it modify state.md, hook-audit.log, or other persistent state?
                  Yes → bookkeeping
                  No  → it should not be a hook; consider making it a repo script
```

If a script mixes responsibilities (e.g., enforces + appends to a log),
the audit reports `bucket-mismatch` and suggests splitting:

- Lift the enforcement path into `enforcement/<name>.sh`.
- Lift the bookkeeping path into `bookkeeping/<name>.sh`.
- Both registered in `hooks.json` for the same event, enforcement first.

The user's choice in the original AskUserQuestion is to enable this
suggestion in `/audit-script` mode; the audit emits a `migrate:` block
in its output but never applies the split automatically (too invasive).
