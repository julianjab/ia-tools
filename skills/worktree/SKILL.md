---
name: worktree
description: >
  Git worktree management for parallel development workflows.
  Create isolated worktrees for features, reviews, and hotfixes without switching branches.
  Supports: `init` (create worktree), `spawn` (create worktree + open Claude in tmux, optionally
  subscribed to a Slack thread), `list` (show active worktrees), `switch` (change context),
  `cleanup` (remove merged/stale worktrees), `status` (overview of all worktrees).
  Examples: `/worktree init feat/notification-service`, `/worktree spawn feat/my-task --slack-thread 1234.567 --channel C07815S0XNX`,
  `/worktree list`, `/worktree cleanup --merged`, `/worktree status`.
argument-hint: "[init|spawn|list|switch|cleanup|status] [branch-name] [--base main] [--slack-thread <ts>] [--channel <id>] [--session <name>]"
disable-model-invocation: false
---

## Worktree Manager — Parallel Development Workflow

**This is the preferred way to start new tasks.** Use `/worktree init` instead of `git checkout -b` to keep `main` clean and enable parallel development.

Parse `$ARGUMENTS` to determine which sub-command to execute:

| First token in `$ARGUMENTS` | Action |
|-----------------------------|--------|
| `init` | Create a new worktree for a feature/fix/review |
| `spawn` | Create worktree (if needed) + open Claude in tmux, optionally subscribed to a Slack thread |
| `list` | List all active worktrees with their branches and status |
| `switch` | Print the path of an existing worktree (context guidance) |
| `cleanup` | Remove worktree(s) that are merged or no longer needed |
| `status` | Comprehensive overview: all worktrees, uncommitted changes, unpushed commits |
| _(empty)_ | Run `status` by default |

---

## Concepts

### Worktree Directory Layout

All worktrees are created as siblings of the main repo under a `.worktrees/` directory:

```
ia-tools/                  ← main repo (stays on main/master)
ia-tools/.worktrees/
  feat-notification/       ← worktree for feat/notification-service
  fix-duplicate-msgs/      ← worktree for fix/duplicate-whatsapp-messages
  review-pr-42/            ← worktree for reviewing PR #42
```

**Why `.worktrees/` inside the repo?**
- Underscore prefix keeps it sorted at the top and signals "infrastructure"
- `.gitignore` excludes it — never committed
- Easy to find relative to the project root

### Branch-to-Directory Naming

Convert branch names to directory-safe names:
- `feat/notification-service` → `feat-notification-service`
- `fix/duplicate-whatsapp-messages` → `fix-duplicate-whatsapp-messages`
- `review/pr-42` → `review-pr-42`

Rule: replace `/` with `-`.

---

## Sub-command: `init`

**Purpose**: Create an isolated worktree for a new task, keeping `main` clean in the primary repo.

**Arguments**: `/worktree init <branch-name> [--base main] [--review <pr-number>]`

### Steps

1. **Determine repo root and validate**:
   ```bash
   git rev-parse --show-toplevel
   git rev-parse --is-inside-work-tree
   ```
   - If inside an existing worktree, navigate to the main repo root first:
     ```bash
     git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel
     ```

2. **Fetch latest from origin**:
   ```bash
   git fetch origin
   ```

3. **Ensure `.worktrees/` directory exists and is gitignored**:
   ```bash
   mkdir -p _worktrees
   ```
   - Check if `.worktrees/` is in `.gitignore`. If not, append it:
     ```bash
     grep -qxF '.worktrees/' .gitignore || echo '.worktrees/' >> .gitignore
     ```

4. **Determine base branch**: Use `--base` if provided, default to `main`. Fall back to `master` if `main` doesn't exist.

5. **Convert branch name to directory name**:
   ```bash
   DIR_NAME=$(echo "<branch-name>" | tr '/' '-')
   WORKTREE_PATH=".worktrees/${DIR_NAME}"
   ```

6. **Check if worktree already exists**:
   ```bash
   git worktree list --porcelain | grep -q "${WORKTREE_PATH}"
   ```
   - If yes: Report that it already exists and print the path. Ask user if they want to switch to it.
   - If no: Continue to create.

7. **Create the worktree**:

   **For a new feature branch:**
   ```bash
   git worktree add -b <branch-name> "${WORKTREE_PATH}" origin/<base>
   ```

   **For reviewing an existing PR (--review flag):**
   ```bash
   gh pr checkout <pr-number> --branch review/pr-<pr-number>
   # Then detach and re-create as worktree:
   git worktree add "${WORKTREE_PATH}" review/pr-<pr-number>
   ```

   **For an existing remote branch:**
   ```bash
   git worktree add --track -b <branch-name> "${WORKTREE_PATH}" origin/<branch-name>
   ```

8. **Verify the worktree**:
   ```bash
   cd "${WORKTREE_PATH}" && git branch --show-current && git log --oneline -3
   ```

9. **Report**:
   ```
   Worktree created:
     Path:   .worktrees/<dir-name>
     Branch: <branch-name>
     Base:   origin/<base>
     Status: clean

   To work in this worktree, operate on files at: <absolute-path>
   The main repo remains on: main (undisturbed)
   ```

---

## Sub-command: `spawn`

**Purpose**: Create a worktree (if it doesn't exist yet) and open a Claude Code session inside it in a tmux window. Optionally pre-subscribe Claude to a Slack thread so the session receives messages and can act on them autonomously.

**Arguments**: `/worktree spawn <branch-name> [--slack-thread <ts>] [--channel <channel-id>] [--session <tmux-session-name>]`

| Flag | Default | Description |
|------|---------|-------------|
| `--slack-thread <ts>` | _(none)_ | Slack thread timestamp to subscribe to |
| `--channel <id>` | _(none)_ | Slack channel ID (required when `--slack-thread` is set) |
| `--session <name>` | branch dir name | tmux session name; if it already exists, a new window is added |

### Steps

1. **Check dependencies**:
   ```bash
   command -v tmux  || { echo "tmux not installed — brew install tmux"; exit 1; }
   command -v claude || { echo "claude CLI not found in PATH"; exit 1; }
   ```

2. **Ensure the worktree exists** — if not, run the `init` logic first (fetch origin, create `.worktrees/<dir>`, create branch). If it already exists, skip creation and report.

3. **Resolve the worktree absolute path**:
   ```bash
   REPO=$(git rev-parse --show-toplevel)
   DIR_NAME=$(echo "<branch-name>" | tr '/' '-')
   WORKTREE_PATH="$REPO/.worktrees/$DIR_NAME"
   ```

4. **Resolve the tmux session name**: Use `--session` if provided, otherwise use `$DIR_NAME`.

5. **Resolve the OAuth token** (same pattern as `spawn-team.sh`):
   ```bash
   AGENT_TOKEN="${CLAUDE_TEAM_OAUTH_TOKEN:-$CLAUDE_CODE_OAUTH_TOKEN}"
   ```

6. **Build the Claude launch command**:
   - With Slack: `SLACK_THREAD_TS=<ts> SLACK_CHANNELS=<channel-id> CLAUDE_CODE_OAUTH_TOKEN=<token> claude --dangerously-skip-permissions`
   - Without Slack: `CLAUDE_CODE_OAUTH_TOKEN=<token> claude --dangerously-skip-permissions`

7. **Create or reuse tmux session**:
   ```bash
   # If session exists, add a new window; otherwise create a new session
   if tmux has-session -t "$SESSION" 2>/dev/null; then
     tmux new-window -t "$SESSION" -n "$DIR_NAME" -c "$WORKTREE_PATH"
   else
     tmux new-session -d -s "$SESSION" -n "$DIR_NAME" -c "$WORKTREE_PATH"
   fi
   ```

8. **Send the Claude launch command** to the tmux pane:
   ```bash
   tmux send-keys -t "$SESSION:$DIR_NAME" "$CLAUDE_CMD" Enter
   ```

9. **Send the boot prompt** after a short delay (1s for Claude to start):
   - **With Slack**: instruct Claude to call `subscribe_slack` with `threads: ["<ts>"]`, `channels: ["<channel-id>"]`, and `label: "task: <branch-name>"`, then wait for messages and act on them autonomously.
   - **Without Slack**: instruct Claude to read the worktree's `CLAUDE.md`, understand the project context, and wait for tasks from the main session or user.

   ```bash
   sleep 1
   tmux send-keys -t "$SESSION:$DIR_NAME" "<boot-prompt>" Enter
   ```

10. **Report**:
    ```
    Worktree session spawned:
      Branch:   <branch-name>
      Path:     .worktrees/<dir-name>
      tmux:     session=<session-name>  window=<dir-name>
      Slack:    subscribed to thread <ts> in channel <channel-id>  [or: not connected]

    Attach with:
      tmux attach -t <session-name>
    ```

### Boot prompts

**With Slack thread:**
```
You are a Claude Code agent working on branch <branch-name> inside worktree <path>.
Call subscribe_slack with threads=["<ts>"], channels=["<channel-id>"], label="task: <branch-name>".
Then wait for messages from the Slack thread. When a message arrives, read it, plan your response,
and act on it. Use /commit for checkpoints. Report progress back via reply_slack.
Do NOT do anything until you receive a Slack message.
```

**Without Slack:**
```
You are a Claude Code agent working on branch <branch-name> inside worktree <path>.
Read CLAUDE.md to understand the project. Then wait — the orchestrator or user will
send you tasks via the main Claude session or by writing to .worktrees/.team/tasks/.
Use /commit for checkpoints. Do NOT do anything until you receive a task.
```

### Delegate to script

The actual shell work is handled by `skills/worktree/scripts/spawn-claude.sh`:

```bash
bash "$(git rev-parse --show-toplevel)/skills/worktree/scripts/spawn-claude.sh" \
  "$WORKTREE_PATH" "$SESSION" "$DIR_NAME" "$SLACK_THREAD_TS" "$SLACK_CHANNEL_ID" "$BRANCH_NAME"
```

---

## Sub-command: `list`

**Purpose**: Show all active worktrees with key metadata.

### Steps

1. **Get worktree list**:
   ```bash
   git worktree list
   ```

2. **For each worktree, gather details**:
   ```bash
   # For each worktree path:
   git -C <path> branch --show-current
   git -C <path> status --porcelain | wc -l
   git -C <path> log origin/main..HEAD --oneline 2>/dev/null | wc -l
   ```

3. **Present as a table**:
   ```
   Active Worktrees:

   | # | Directory              | Branch                       | Uncommitted | Unpushed | PR     |
   |---|------------------------|------------------------------|-------------|----------|--------|
   | 1 | (main repo)            | main                         | 0           | 0        | —      |
   | 2 | .worktrees/feat-notif  | feat/notification-service    | 3           | 2        | #45    |
   | 3 | .worktrees/fix-dupes   | fix/duplicate-whatsapp-msgs  | 0           | 1        | —      |
   ```

4. **Check for PR association**:
   ```bash
   git -C <path> log --oneline -1 --format="%s" | head -1
   gh pr list --head <branch-name> --json number,url --jq '.[0]' 2>/dev/null
   ```

---

## Sub-command: `switch`

**Purpose**: Guide the user/agent to work in a different worktree context.

**Arguments**: `/worktree switch <branch-name-or-directory>`

### Steps

1. **Find the worktree**:
   ```bash
   git worktree list --porcelain
   ```
   - Match by branch name or directory name (partial match OK).

2. **If found**:
   - Print the absolute path
   - Show current status (uncommitted changes, branch, last commit)
   - **Guidance**: "To work in this worktree, read/write files at: `<absolute-path>/`"

3. **If not found**:
   - Show available worktrees
   - Suggest: "Run `/worktree init <branch-name>` to create it"

4. **Important**: Worktree switching is about file paths, not `cd`. Since agents operate via file tools, "switching" means targeting a different directory for Read/Write/Edit operations.

---

## Sub-command: `cleanup`

**Purpose**: Remove worktrees that are no longer needed.

**Arguments**: `/worktree cleanup [<branch-name>] [--merged] [--stale <days>] [--force]`

### Steps

1. **Determine what to clean**:

   | Argument | Behavior |
   |----------|----------|
   | `<branch-name>` | Remove only that specific worktree |
   | `--merged` | Remove all worktrees whose branch has been merged into main |
   | `--stale 30` | Remove worktrees with no commits in the last N days |
   | `--force` | Skip confirmation prompts |
   | _(none)_ | Interactive — show candidates and ask which to remove |

2. **For `--merged` detection**:
   ```bash
   git branch --merged origin/main
   ```
   Cross-reference with worktree branches.

3. **For each worktree to remove**:
   a. **Safety check**: Verify no uncommitted changes:
      ```bash
      git -C <path> status --porcelain
      ```
      - If uncommitted changes exist and `--force` not set: **STOP** and warn the user.

   b. **Remove the worktree**:
      ```bash
      git worktree remove <path>
      ```
      - If locked: `git worktree remove --force <path>` (only with `--force` flag)

   c. **Optionally delete the remote branch** (ask user unless `--force`):
      ```bash
      git push origin --delete <branch-name>
      ```

   d. **Prune stale worktree references**:
      ```bash
      git worktree prune
      ```

4. **Report**:
   ```
   Cleanup complete:
     Removed: feat/notification-service (.worktrees/feat-notification-service)
     Remote branch: deleted
     Remaining worktrees: 2
   ```

---

## Sub-command: `status`

**Purpose**: Comprehensive overview of all worktrees and their state.

### Steps

1. Run all checks from `list` plus:
   ```bash
   # Per worktree:
   git -C <path> stash list | wc -l          # stashed changes
   git -C <path> log --oneline -1 --format="%cr"  # last commit age
   ```

2. **Check CI status for worktrees with PRs**:
   ```bash
   gh pr checks <pr-number> --json name,state --jq '.[] | select(.state != "SUCCESS")' 2>/dev/null
   ```

3. **Present summary**:
   ```
   Worktree Status Overview:

   feat/notification-service (2 days old)
     Path: .worktrees/feat-notification-service
     Commits: 4 ahead of main
     Changes: 2 uncommitted files
     PR: #45 — CI passing ✓
     Action needed: commit + push

   fix/duplicate-whatsapp-msgs (5 days old)
     Path: .worktrees/fix-duplicate-whatsapp-msgs
     Commits: 1 ahead of main
     Changes: clean
     PR: none
     Action needed: create PR

   review/pr-42 (1 day old)
     Path: .worktrees/review-pr-42
     Commits: 0 local changes
     Changes: clean
     PR: #42 (reviewing)
     Action needed: finish review, then cleanup
   ```

4. **Suggest next actions** based on state:
   - Worktrees with uncommitted changes → suggest `/deliver commit`
   - Worktrees ready for PR → suggest `/deliver pr`
   - Review worktrees with no activity → suggest `/worktree cleanup`
   - Merged branches → suggest `/worktree cleanup --merged`

---

## Integration with /deliver

The `/worktree` skill is designed to complement `/deliver`:

| Workflow Step | Skill | What happens |
|--------------|-------|--------------|
| Start new task (simple) | `/worktree init feat/x` | Creates isolated worktree + branch |
| Start new task (async) | `/worktree spawn feat/x --slack-thread <ts> --channel <id>` | Creates worktree + opens Claude in tmux subscribed to Slack thread |
| Write code | _(agent works in worktree path)_ | Files at `.worktrees/feat-x/` |
| Commit checkpoint | `/commit` | Formats, stages, commits from within the worktree |
| Validate quality | `/review` | Runs fmt + tests + coverage + rules |
| Create PR | `/pr` | Invokes `/review --fix`, pushes, creates PR with diagrams |
| Start review | `/worktree init --review 42` | Creates review worktree for PR #42 |
| Finish task | `/worktree cleanup feat/x` | Removes worktree after merge |
| Parallel work | `/worktree switch fix/y` | Redirects agent to another worktree |
| Full pipeline | `/deliver` | Auto-detects state, orchestrates all skills |

**Key rule**: All skills (`/commit`, `/review`, `/pr`) work the same inside a worktree as in the main repo. The branch is already set by the worktree — no checkout needed.

---

## Error Handling

| Error | Action |
|-------|--------|
| Branch already checked out in another worktree | Report which worktree has it, suggest `switch` |
| Worktree path already exists but is not registered | Run `git worktree prune` then retry |
| Cannot remove worktree with uncommitted changes | Warn user, require `--force` to override |
| Inside a worktree, trying to create another | Navigate to main repo root first |
| Branch name conflicts | Suggest a different name or ask user to resolve |
| Detached HEAD in worktree | Warn and suggest creating/checking out a branch |
| `spawn`: tmux not installed | Report error, suggest `brew install tmux` |
| `spawn`: claude CLI not found | Report error, check PATH and `~/.claude/local/` |
| `spawn`: `--slack-thread` without `--channel` | Report error, both flags are required together |
| `spawn`: session name conflict (wrong project) | Warn user; use `--session` flag to pick a different name |

## Important Rules

- **NEVER delete the main worktree** (the primary repo checkout)
- **ALWAYS check for uncommitted changes** before removing a worktree
- **ALWAYS run `git worktree prune`** after removals to clean up stale references
- **`.worktrees/` MUST be in `.gitignore`** — never commit worktree directories
- **Worktrees share the same `.git` database** — commits, stashes, and refs are shared across all worktrees
- **Each worktree has an independent working directory** — changes in one don't affect others
- **Never `cd` into a worktree** — always use `git -C <worktree-path>` and `pnpm --dir <worktree-path>` to run commands inside a worktree from the main repo
