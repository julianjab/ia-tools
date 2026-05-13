---
name: team-review
description: >
  Request team review for an existing PR. Loads channel + reviewer
  config from settings.local.json env (or CLAUDE.md fallback), runs a
  quick standards preflight on the PR, blocks until CI is green, posts
  a review-request message in Slack mentioning the configured
  users/groups, and subscribes to the resulting thread so the calling
  session receives every reply. Used standalone by an operator after
  `/pr`, or invoked by `team-lead` as a final follow-up once a PR is
  open. Trigger words: "team review", "request review", "pide review",
  "notify the team", "ship".
argument-hint: "[pr-url] [#channel] [@user-or-group...] [--no-ci-wait] [--skip-review]"
disable-model-invocation: false
---

## /team-review — Request team review

End-to-end loop: locate the PR → run a quick standards preflight →
block until CI is green → post a Slack review request to the
configured channel mentioning the configured users/groups →
subscribe to the resulting thread so the calling session receives
every reply.

### Config resolution order

The skill needs **two values**: a Slack `channel` and a list of
`mentions` (user IDs `Uxxx`, group IDs `Sxxx`, or `@names`).
Resolution priority — first non-empty wins:

1. **CLI arguments** (`$ARGUMENTS`) — highest priority.
2. **Environment variables** (recommended for project config; set
   them in `.claude/settings.local.json` under `env`, or in the
   operator's shell):

   | Env var | Value |
   |---|---|
   | `TEAM_REVIEW_CHANNEL` | `#channel-name` or `Cxxxxxxxxxx` channel ID |
   | `TEAM_REVIEW_MENTIONS` | space-separated list: `@alice U02... S078... <!subteam^S078...>` |
   | `TEAM_REVIEW_CI_TIMEOUT_MIN` | optional, default `15` |

   Example consumer `.claude/settings.local.json`:
   ```json
   {
     "env": {
       "TEAM_REVIEW_CHANNEL": "C06Q8SNF93P",
       "TEAM_REVIEW_MENTIONS": "S078TCCKQ05 U0AGVLRV6A2"
     }
   }
   ```
3. **`CLAUDE.md` block** (backward compat for repos that haven't
   migrated to settings.local.json):
   ```markdown
   ## Team-Review Config
   - channel: #your-channel-name
   - mentions: @user1 U0AGVLRV6A2 S078TCCKQ05
   ```
4. **Ask the user** — if no value is found anywhere, prompt once
   before proceeding. Do not invent defaults.

### Arguments

`$ARGUMENTS` tokens, parsed positionally:

- URL token (contains `github.com/...`) → PR URL (skip auto-detect).
- Token starting with `#` → channel name (overrides config).
- Token starting with `C` → channel ID (overrides config).
- Token starting with `@` → mention; format as `<@ID>` (strip `@`).
- Token starting with `U` → user ID; format as `<@ID>`.
- Token starting with `S` → user group ID; format as `<!subteam^ID>`.
- `--no-ci-wait` → skip the CI-green wait. Use only when CI is known
  irrelevant (docs-only PR, infra-only changes).
- `--skip-review` → skip the standards preflight (Step 2). Use when
  the caller already validated the PR (e.g. team-lead after `/pr`).

### Step 1 — Find the PR

1. If `$ARGUMENTS` contains a `github.com/...` URL → use it.
2. Otherwise: `gh pr view --json url,state,title,number` to detect
   the current branch's PR.
3. If no PR exists → stop. Tell the operator to open one first via
   `/pr`.

### Step 2 — Quick standards preflight (skip with `--skip-review`)

Run a light check against the PR before bothering reviewers:

```bash
gh pr view <pr-url> --json mergeable,state,additions,deletions,changedFiles,isDraft,body
gh pr diff <pr-url> --name-only | head -50
```

Flag and STOP (do not notify) if any of:
- PR is `draft` (`isDraft: true`)
- PR has merge conflicts (`mergeable: CONFLICTING`)
- PR exceeds sanity bounds (>500 net lines or >30 files) — likely needs split
- PR body is empty

When stopped, report the reason clearly so the operator can override
with `--skip-review` if intentional.

### Step 3 — Wait for CI green (skip with `--no-ci-wait`)

```bash
gh pr checks <pr-url> --watch --interval 30
```

Outcomes:
- All green → continue to Step 4.
- Any failure → STOP. Report the failed check and the
  `gh run view <run-id> --log-failed` command. Do NOT post to Slack.
- Pending > `TEAM_REVIEW_CI_TIMEOUT_MIN` (default 15) → ask the
  operator whether to keep waiting or abort.

### Step 4 — Resolve channel + find existing thread

1. Resolve channel:
   - Name (`#x`) → `slack_search_channels` to get the channel ID.
   - ID (`Cxxx`) → use directly.
2. Detect existing thread for this PR:
   - If `SLACK_THREAD_TS` env is set → use it (caller has anchored
     a thread).
   - Otherwise: `slack_search_public_and_private` for the PR URL in
     the resolved channel. If found → take its `ts` as `thread_ts`;
     otherwise `thread_ts` stays empty (new message will be created).

### Step 5 — Post the review request

Build the mention block from the resolved mentions list. Format each
according to its kind:

| Input | Output |
|---|---|
| `Uxxx` | `<@Uxxx>` |
| `Sxxx` | `<!subteam^Sxxx>` |
| `@name` | `<@Uxxx>` after `slack_search_users` resolution |

Compose the message:

- New message (no `thread_ts`):
  > `<mentions> Cuando puedan me ayudan con este PR: <pr-url>`
- Reply to existing thread (re-review):
  > `<mentions> Corregidos los comentarios, ¿pueden re-revisar? 🙏`

Post via the channel's `reply` tool with `channel_id`, `thread_ts`
(if any), and the message text. Capture the response `ts` — this is
the `thread_ts` for Step 6.

### Step 6 — Subscribe to the thread

```
subscribe_slack(
  topics: ["<channel_id>:*:<thread_ts>"],
  label: "team-review: <pr-title>"
)
```

The `*` wildcard catches all replies (users + bots). The calling
session now receives every inbound message in this thread without
extra setup.

### Final report

```
✅ Team review requested
   PR:        <pr-url>
   Channel:   <#name | Cxxx>
   Mentions:  <resolved list>
   CI:        green
   Mode:      new | re-review
   Thread:    <thread_ts>
   Subscribed: yes
```

### Error handling

| Situation | Action |
|---|---|
| Missing `TEAM_REVIEW_CHANNEL` AND no CLI override AND no CLAUDE.md block | Ask the operator once; do not invent. |
| PR not found for current branch | Tell operator to open one first via `/pr`; stop. |
| Step 2 flags PR as not-shippable | Report the reason; halt unless `--skip-review`. |
| CI fails | Report the failed check; do NOT post to Slack. |
| Slack channel not found | Ask for correct ID/name. |
| `subscribe_slack` fails | Notify operator; the message is already posted, so they can subscribe manually. |

### Examples

```bash
# Most common: current branch's PR, using configured channel/mentions
/team-review

# Specific PR URL, otherwise use config
/team-review https://github.com/my-org/my-repo/pull/42

# Override channel and mentions for this run
/team-review #other-channel @alice S078TCCKQ05

# Docs-only PR, skip CI wait
/team-review --no-ci-wait

# Called by team-lead right after /pr — preflight already done
/team-review --skip-review
```

### Use from team-lead

`team-lead` invokes `/team-review --skip-review` as the final task of
a feature after each touched repo's `:pr` task completes.
`--skip-review` because the `/pr` skill already ran `/review --fix`
and the `:security` task already approved the diff. team-lead then
relays follow-up comments from the subscribed thread back to the
user.
