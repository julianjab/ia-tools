---
name: worktree
description: >
  Git worktree management for parallel development. Create isolated
  worktrees for features, reviews, and hotfixes without switching
  branches. Supports: `init` (create), `list` (show active),
  `switch` (change context), `cleanup` (remove merged/stale), `status`
  (overview). `init` accepts `--repo <path>` to create worktrees in
  sibling repos (multi-repo mode).
  Examples: `/worktree init feat/notification-service`,
  `/worktree init feat/payment-tracking --repo /path/to/repo`,
  `/worktree list`, `/worktree cleanup --merged`, `/worktree status`.
argument-hint: "[init|list|switch|cleanup|status] [branch-name] [--base main] [--review <pr>] [--repo <path>]"
disable-model-invocation: false
---

## Worktree Manager

This skill manages git worktrees only. It does not open any other
process; callers handle whatever they need on top of the created
worktree.

Parse `$ARGUMENTS` to determine which sub-command to execute:

| First token in `$ARGUMENTS` | Action |
|-----------------------------|--------|
| `init` | Create a new worktree for a feature/fix/review |
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
<repo>/                    ← main repo (stays on main/master)
<repo>/.worktrees/
  feat-notification/       ← worktree for feat/notification-service
  fix-duplicate-msgs/      ← worktree for fix/duplicate-whatsapp-messages
  review-pr-42/            ← worktree for reviewing PR #42
```

**Why `.worktrees/` inside the repo?**
- Sorted at the top, signals "infrastructure"
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

**Purpose**: Create an isolated worktree for a new task on a fresh branch.

**Invocation**: pass arguments verbatim to the init script:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/worktree/scripts/init.sh" \
  <branch-name> [--base <ref>] [--review <pr>] [--repo <path>]
```

The script handles target-repo resolution, fetch, `.worktrees/` +
`.gitignore` setup, base-branch fallback (`main` → `master`), branch
name → directory name conversion, idempotent creation, `.claude/`
config copy, and the result report. Don't reproduce its steps in chat —
just invoke it.

**After the script returns successfully, you MUST also run**:

```
/add-dir <worktree-absolute-path>
```

Extract `<worktree-absolute-path>` from the script's report line
(`Path: …`). `/add-dir` registers the worktree's `.claude/` (agents,
skills, hooks, settings) with the active session so any repo-local
subagent under the new worktree can be spawned via `Agent(...)`.
Skipping this step makes repo-local agents invisible to the spawner
and produces "Agent type '…' not found" errors at spawn time. This is
part of the `init` contract, not an optional follow-up.

**Flags**:

| Flag | Effect |
|---|---|
| `<branch-name>` (required) | Branch to create. `/` is converted to `-` in the directory name. |
| `--base <ref>` | Base branch (default `main`, falls back to `master`). |
| `--review <pr#>` | Create the worktree from a PR head ref instead of a new branch. |
| `--repo <path>` | Run against a different repo root. The worktree lands at `<path>/.worktrees/<dir-name>`. |

`--repo` composes with all other flags. Without it, the script uses the
current CWD's repo root.

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

**Arguments**: `/worktree cleanup [<branch-name>] [--merged] [--stale <days>] [--force] [--dry-run]`

### Steps

1. **Determine what to clean**:

   | Argument | Behavior |
   |----------|----------|
   | `<branch-name>` | Remove only that specific worktree |
   | `--merged` | Remove all worktrees whose branch has been merged into main |
   | `--stale 30` | Remove worktrees with no commits in the last N days |
   | `--force` | Skip confirmation prompts |
   | `--dry-run` | Preview only — list candidates + reasons, make zero changes |
   | _(none)_ | Interactive — show candidates and ask which to remove |

   `--dry-run` composes with every selector (`<branch-name>`, `--merged`, `--stale`, interactive) and with `--force`. When `--dry-run` is set, `--force` only affects whether confirmation prompts are skipped in the preview — nothing is ever executed.

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
      - This check runs in dry-run too, so the preview matches real behavior.

   b. **If `--dry-run` is set, STOP HERE**. Do NOT execute any of the commands in sub-steps (c), (d), or (e). Instead, record the candidate and its reason (merged / stale / explicit name) for the preview report.

   c. **Remove the worktree**:
      ```bash
      git worktree remove <path>
      ```
      - If locked: `git worktree remove --force <path>` (only with `--force` flag)
      - **Skipped under `--dry-run`.**

   d. **Optionally delete the remote branch** (ask user unless `--force`):
      ```bash
      git push origin --delete <branch-name>
      ```
      - **Skipped under `--dry-run`.**

   e. **Prune stale worktree references**:
      ```bash
      git worktree prune
      ```
      - **Skipped under `--dry-run`.**

4. **Report**:

   **Normal run**:
   ```
   Cleanup complete:
     Removed: feat/notification-service (.worktrees/feat-notification-service)
     Remote branch: deleted
     Remaining worktrees: 2
   ```

   **Dry run** (must lead with the preview banner so the user can see it was a preview):
   ```
   DRY RUN — no changes made

   Would remove:
     - feat/notification-service  (.worktrees/feat-notification-service)  reason: merged into main
     - fix/stale-ticket-123       (.worktrees/fix-stale-ticket-123)       reason: stale (42 days)

   Would delete remote branches:
     - origin/feat/notification-service
     - origin/fix/stale-ticket-123

   Safety warnings:
     - .worktrees/feat-notification-service has 2 uncommitted files (would require --force)

   Re-run without --dry-run to apply.
   ```

### Examples

```bash
/worktree cleanup --merged --dry-run             # preview everything that --merged would remove
/worktree cleanup --stale 30 --dry-run           # preview stale worktrees older than 30 days
/worktree cleanup feat/old-branch --dry-run      # preview removal of a single named worktree
/worktree cleanup --merged --force --dry-run     # preview, including worktrees with uncommitted changes
```

---

## Sub-command: `status`

**Purpose**: Comprehensive overview of all worktrees and their state.

### Steps

1. Run all checks from `list` plus:
   ```bash
   git -C <path> stash list | wc -l                # stashed changes
   git -C <path> log --oneline -1 --format="%cr"   # last commit age
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
   - Worktrees with uncommitted changes → suggest `/commit`
   - Worktrees ready for PR → suggest `/pr`
   - Review worktrees with no activity → suggest `/worktree cleanup`
   - Merged branches → suggest `/worktree cleanup --merged`

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

## Important Rules

- **NEVER delete the main worktree** (the primary repo checkout)
- **ALWAYS check for uncommitted changes** before removing a worktree
- **ALWAYS run `git worktree prune`** after removals to clean up stale references
- **`.worktrees/` MUST be in `.gitignore`** — never commit worktree directories
- **Worktrees share the same `.git` database** — commits, stashes, and refs are shared across all worktrees
- **Each worktree has an independent working directory** — changes in one don't affect others
- **Never `cd` into a worktree** — always use `git -C <worktree-path>` and `pnpm --dir <worktree-path>` to run commands inside a worktree from the main repo
