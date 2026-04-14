---
name: ship
description: >
  Request PR review via Slack after CI/CD passes. Assumes a PR already exists
  (created by /deliver or manually). Waits for all CI checks to pass, then
  sends a review request to the configured Slack channel. Defaults are read
  from the project's CLAUDE.md (ship.channel, ship.mentions). Use when the user
  says "ship", "request review", "notify the team", or wants to send the PR for review.
argument-hint: "[pr-url] [#channel] [@mentions...]"
disable-model-invocation: false
---

## Ship workflow — Request PR Review

Waits for CI/CD to pass on an existing PR, then notifies Slack requesting review.

### Arguments
- `$ARGUMENTS` — optional overrides (tokens parsed in order):
  - URL token (contains `github.com`) → PR URL (skip auto-detection)
  - Token starting with `#` → Slack channel name (override default)
  - Token starting with `C` → Slack channel ID (override default)
  - Token starting with `@` → mention, strip `@` and format as `<@ID>` or `<!subteam^ID>`
  - Token starting with `U` → Slack user ID, format as `<@ID>`
  - Token starting with `S` → Slack user group ID, format as `<!subteam^ID>`

### Defaults (when no arguments provided)

Read defaults from the project's `CLAUDE.md`. Look for a `ship` config block:

```markdown
## Ship Config
- channel: #your-channel-name (or channel ID starting with C)
- mentions: @user1 @user2 (or Slack IDs: U... for users, S... for user groups)
```

If no config is found in `CLAUDE.md`, **ask the user** for the channel and mentions before proceeding — never assume defaults.

If the user provides channel or mention arguments, those **replace** the config entirely.

---

### Step 1 — Find the PR

1. If a PR URL was provided in `$ARGUMENTS`, use it directly.
2. Otherwise, detect the current branch's PR:
   ```bash
   gh pr view --json url,state,title,number --jq '{url, state, title, number}'
   ```
3. If no PR exists for the current branch, **stop** and tell the user:
   ```
   No PR found for this branch. Run /deliver first to create one, or provide a PR URL:
   /ship https://github.com/la-haus/subscriptions/pull/123
   ```

---

### Step 2 — Wait for CI/CD (MANDATORY)

**Do NOT send the Slack notification until ALL checks pass.**

1. Run CI watch:
   ```bash
   gh pr checks <pr-url> --watch --interval 30
   ```
2. Evaluate results:
   - **All checks pass** → Proceed to Step 3
   - **Any check fails** → Report the failure and **STOP**:
     ```
     CI FAILED — cannot request review.

     Failed check: <check-name>
     Run: gh run view <run-id> --log-failed

     Fix the issue and run /ship again.
     ```
   - **Checks pending for too long** (>15 min) → Report status and ask user if they want to keep waiting

---

### Step 3 — Resolve Channel & Find Existing Thread

#### 3a. Resolve the channel

- If channel name provided (e.g., `#my-team-channel`), resolve to ID using `slack_search_channels`
- If channel ID provided (starts with `C`), use directly
- If no channel provided, use the value from CLAUDE.md ship config (resolved in Defaults step)

#### 3b. Search for existing thread (ALWAYS do this before posting)

**ALWAYS search for an existing Slack thread for this PR before deciding how to post.**

Check if `SLACK_THREAD_TS` env var is set:
```bash
echo "${SLACK_THREAD_TS:-not set}"
```

- **If `SLACK_THREAD_TS` is set** → use it directly as the thread to reply to. Skip the search.
- **If not set** → search Slack for the PR URL in the resolved channel using `slack_search_public_and_private`:
  ```
  query: "<pr-url>" in:<channel-name>
  ```
  - If found → save its `ts` as the `thread_ts`
  - If not found → `thread_ts` stays empty (will create new message)

After this step you have: `channel_id`, `thread_ts` (or empty), and the review state from Step 2.

---

### Step 4 — Send Slack Notification

#### 4a. Build mentions

- If mentions provided in arguments, use those
- If no mentions provided, use the mentions from CLAUDE.md ship config (resolved in Defaults step)

#### 4b. Post the message

**If `thread_ts` exists → reply to it:**

For re-review:
```
<mentions> Corregidos los comentarios, cuando puedan re-revisan 🙏
```

For first review (thread found from env or previous ship):
```
<mentions> Cuando puedan me ayudan con este PR: <pr-url>
```

Use `thread_ts` as the reply target. The `thread_ts` for step 5 is this same value.

**If `thread_ts` is empty → create new message:**
```
<mentions> Cuando puedan me ayudan con este PR: <pr-url>
```

The `thread_ts` for step 5 is the `ts` from the Slack API response (the new message's timestamp).

#### 4c. Report the result

```
PR review requested!

PR: <pr-url>
Mode: first review | re-review | reply to existing thread
Channel: <channel-name>
Mentions: <who was mentioned>
CI Status: All checks passed
Slack: <new message | reply to existing thread>
Thread: <thread_ts>
```

Proceed immediately to Step 5 (subscribe to the thread) — no user confirmation needed.

---

### Step 5 — Subscribe to the thread

Immediately after sending the Slack message, subscribe to the thread so Claude receives any replies:

Call `subscribe_slack` with:
- `threads: [<thread_ts>]` — the timestamp returned by Slack in Step 4 (the new message ts OR the existing thread ts replied to)
- `label` — set to `"ship: <pr-title>"` so the subscription is identifiable in daemon logs

Example call:
```
subscribe_slack(
  threads: ["1775665186.334219"],
  label: "ship: feat(slack-bridge): class-based refactor"
)
```

This replaces the old manual-command approach. The current session is now connected to the thread automatically — no extra terminal needed.

---

### Error Handling

| Error | Action |
|-------|--------|
| No PR found | Tell user to run `/deliver` first or provide PR URL |
| CI checks fail | Show failure details, do NOT send Slack message |
| Slack send fails | Report error, suggest manual notification |
| Channel not found | Ask user for correct channel name/ID |

### Examples

```bash
# Default: current branch PR → wait CI → notify configured channel
/ship

# Specific PR URL
/ship https://github.com/my-org/my-repo/pull/42

# Override channel and mentions
/ship #other-channel @alice @bob

# Mix of IDs and names
/ship C07815S0XNX S078TCCKQ05 U0AGVLRV6A2
```
