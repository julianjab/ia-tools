---
name: worktree
description: >
  Git worktree management for parallel development workflows.
  Create isolated worktrees for features, reviews, and hotfixes without switching branches.
  Supports: `init` (create worktree), `list` (show active worktrees), `switch`
  (change context), `cleanup` (remove merged/stale worktrees), `status`
  (overview of all worktrees).
  `init` accepts `--repo <path>` so teammates can create worktrees in sibling repos
  (multi-repo mode). All other flags are unchanged.
  **Note**: For spawning a Claude sub-session linked to a Slack thread, use
  `/task` instead — that is the only way `session-manager` hands off work.
  Examples: `/worktree init feat/notification-service`,
  `/worktree init feat/payment-tracking --repo /Users/julian/lahaus/backend/python/subscriptions`,
  `/worktree list`, `/worktree cleanup --merged`, `/worktree status`.
argument-hint: "[init|list|switch|cleanup|status] [branch-name] [--base main] [--review <pr>] [--repo <path>]"
disable-model-invocation: false
---

## Worktree Manager — Parallel Development Workflow

**This skill manages git worktrees only.** It does NOT open Claude sessions, does
NOT touch Slack, and does NOT inject any system prompt. For task sub-sessions
linked to a Slack thread, use `/session` — see `skills/session/SKILL.md`.

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

**Arguments**: `/worktree init <branch-name> [--base main] [--review <pr-number>] [--repo <path>]`

| Flag | Required? | Effect |
|------|-----------|--------|
| `--repo <path>` | ❌ | Run as if CWD were `<path>` (the target repo root). Repo root resolution, `.worktrees/` creation, and `.gitignore` handling all happen relative to `<path>`. The created worktree lives at `<path>/.worktrees/<dir-name>`. Composes with `--base` and `--review` unchanged. |

When `--repo <path>` is provided:
- `<path>` MUST be an existing git repo root — assert via `git -C <path> rev-parse --git-dir`.
- All subsequent git operations use `git -C <path>` instead of the current working directory.
- The worktree lives at `<path>/.worktrees/<dir-name>` (inside the **target** repo, not the invoking CWD).
- Single-repo usage (no `--repo`) continues to work identically — the flag is purely additive.

### Steps

1. **Determine target repo root**:
   - If `--repo <path>` is provided: assert `git -C <path> rev-parse --git-dir` succeeds.
     Use `<path>` as the target repo root for all subsequent steps.
   - Otherwise: use the current CWD's repo root:
     ```bash
     git rev-parse --show-toplevel
     git rev-parse --is-inside-work-tree
     ```
   - If inside an existing worktree (and no `--repo`), navigate to the main repo root first:
     ```bash
     git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel
     ```

   All subsequent steps use `TARGET_REPO` (either `--repo <path>` or the detected repo root).

2. **Fetch latest from origin** (using target repo root):
   ```bash
   git -C "${TARGET_REPO}" fetch origin
   ```

3. **Ensure `.worktrees/` directory exists and is gitignored** (relative to target repo root):
   ```bash
   mkdir -p "${TARGET_REPO}/.worktrees"
   ```
   - Check if `.worktrees/` is in the target repo's `.gitignore`. If not, append it:
     ```bash
     grep -qxF '.worktrees/' "${TARGET_REPO}/.gitignore" \
       || echo '.worktrees/' >> "${TARGET_REPO}/.gitignore"
     ```

4. **Determine base branch**: Use `--base` if provided, default to `main`. Fall back to `master` if `main` doesn't exist. Resolve against `TARGET_REPO`.

5. **Convert branch name to directory name**:
   ```bash
   DIR_NAME=$(echo "<branch-name>" | tr '/' '-')
   WORKTREE_PATH="${TARGET_REPO}/.worktrees/${DIR_NAME}"
   ```

6. **Check if worktree already exists**:
   ```bash
   git -C "${TARGET_REPO}" worktree list --porcelain | grep -q "${WORKTREE_PATH}"
   ```
   - If yes: Report that it already exists and print the path. Ask user if they want to switch to it.
   - If no: Continue to create.

7. **Create the worktree** (all git ops use `git -C "${TARGET_REPO}"`):

   **For a new feature branch:**
   ```bash
   git -C "${TARGET_REPO}" worktree add -b <branch-name> "${WORKTREE_PATH}" origin/<base>
   ```

   **For reviewing an existing PR (--review flag):**
   ```bash
   git -C "${TARGET_REPO}" fetch origin "pull/<pr-number>/head:<branch>"
   git -C "${TARGET_REPO}" worktree add "${WORKTREE_PATH}" "<branch>"
   ```

   **For an existing remote branch:**
   ```bash
   git -C "${TARGET_REPO}" worktree add --track -b <branch-name> "${WORKTREE_PATH}" origin/<branch-name>
   ```

8. **Copy root `.claude/` into the worktree** (from TARGET_REPO, not from the invoking CWD):
   ```bash
   cp -r "${TARGET_REPO}/.claude/" "${WORKTREE_PATH}/.claude/"
   ```
   This carries over all Claude config (hooks, skills, channels, settings) so the worktree
   session behaves identically to the main repo. The copy is local — `.claude/` is already
   gitignored so it never reaches the remote.

9. **Verify the worktree**:
   ```bash
   git -C "${WORKTREE_PATH}" branch --show-current && git -C "${WORKTREE_PATH}" log --oneline -3
   ```

10. **Report**:
    ```
    Worktree created:
      Path:    .worktrees/<dir-name>
      Branch:  <branch-name>
      Base:    origin/<base>
      .claude: copied from root
      Status:  clean

    To work in this worktree, operate on files at: <absolute-path>
    The main repo remains on: main (undisturbed)
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

## Integration with other skills

| Workflow Step | Skill | What happens |
|---------------|-------|--------------|
| Start a task locally in the terminal | `/worktree init feat/x` | Creates worktree + branch (no Claude session, no Slack) |
| Start a task from Slack (triage routes) | `/task feat/x --thread <ts> --channel <id> --description "..."` | Handles worktree creation + sub-session + Slack subscribe end-to-end |
| Write code | _(sub-session's stack agents do this)_ | Files at `.worktrees/feat-x/` |
| Commit checkpoint | `/commit` | Formats, stages, commits from within the worktree |
| Validate quality | `/review` | Runs fmt + tests + coverage + rules |
| Create PR | `/pr` | Invokes `/review --fix`, pushes, creates PR with diagrams |
| Start review | `/worktree init --review 42` _or_ `/task review/pr-42 --review 42 --thread <ts> --channel <id>` | Local-only vs Slack-linked variants |
| Finish task | `/worktree cleanup feat/x` | Removes worktree after merge |
| Parallel work | `/worktree switch fix/y` | Redirects agent to another worktree |

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

## Important Rules

- **NEVER delete the main worktree** (the primary repo checkout)
- **ALWAYS check for uncommitted changes** before removing a worktree
- **ALWAYS run `git worktree prune`** after removals to clean up stale references
- **`.worktrees/` MUST be in `.gitignore`** — never commit worktree directories
- **Worktrees share the same `.git` database** — commits, stashes, and refs are shared across all worktrees
- **Each worktree has an independent working directory** — changes in one don't affect others
- **Never `cd` into a worktree** — always use `git -C <worktree-path>` and `pnpm --dir <worktree-path>` to run commands inside a worktree from the main repo
