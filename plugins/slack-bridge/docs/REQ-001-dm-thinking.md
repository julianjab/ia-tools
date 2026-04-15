# REQ-001 — DM replies + "thinking" ack UX

**Package:** `@ia-tools/slack-bridge` (`plugins/slack-bridge/`)
**Branch:** `feat/slack-bridge-dm-thinking`
**Worktree:** `/Users/julianbuitrago/development/ia-tools/.worktrees/feat-slack-bridge-dm-thinking`

## Context

Today the slack-bridge forwards every Slack message to its subscribers and Claude replies via `reply_slack`. Two UX problems:

1. **DMs look broken.** Claude always passes `thread_ts = message_ts` to keep replies in-thread. In a DM with no pre-existing thread, Slack interprets that as a brand-new reply thread, which is not how humans expect DMs to work. DM replies should go top-level; only preserve a thread when the source message was already threaded.
2. **No "thinking" feedback.** When Claude is working on a reply there is no visible ack in Slack. The user does not know whether the bot is alive. We want an emoji reaction + assistant thread status "thinking..." as soon as the daemon routes the message to a subscriber, and we want both cleared once Claude successfully posts a reply.

This requirement is scoped to 4 internal sub-tasks against the slack-bridge package.

## Acceptance Criteria

- **AC1 — DM routing awareness.** Every `SlackMessage` forwarded by the daemon carries `is_dm: boolean` derived from the channel id prefix (`D*` → true; `C*` / `G*` → false). The MCP server forwards `is_dm` in `notifications/claude/channel` meta. Claude's `reply_slack` description instructs it to omit `thread_ts` in DMs unless the source message was already threaded.
- **AC2 — Thinking ack on route.** When the daemon finds at least one subscriber for an incoming message, it adds an emoji reaction (`reactions.add`) and sets the assistant thread status (`assistant.threads.setStatus`) before fanning out the webhook. Both calls are best-effort and wrapped in `.catch(warn)` — they never block or fail routing. When no subscribers match, neither call is made. Emoji and status strings are read from env at startup: `SLACK_ACK_EMOJI` (default `eyes`), `SLACK_ACK_STATUS` (default `thinking...`).
- **AC3 — Ack cleanup on successful reply.** `reply_slack` now requires `message_ts` in its input schema. On successful `chat.postMessage`, it calls `clearThinkingAck`, which removes the reaction and clears the assistant thread status (empty string). On postMessage failure it does NOT run cleanup. Cleanup failures are swallowed (`.catch(warn)`); the tool still returns success content.
- **AC4 — DM thread status target.** Both set and clear status calls use `thread_ts = message_ts` when the source message has no `thread_ts`, and the existing `thread_ts` otherwise. This mirrors Slack's Assistant thread model where DMs use the message ts as their virtual thread root.
- **AC5 — Documentation.** README documents the new env vars (`SLACK_ACK_EMOJI`, `SLACK_ACK_STATUS`), the required Slack scopes (`reactions:write`, `assistant:write`), and the DM reply behavior. The `instructions` string on the MCP server walks Claude through the new flow (claim → reply with `message_ts` → DM threading rule).

## Out of Scope

- Retry logic for `reactions.add` / `setStatus` failures.
- Cleanup on `chat.postMessage` failure (explicitly rejected — keep simple).
- Non-default emojis or status strings beyond env override.
- Cross-subscriber coordination: if two subscribers match, each ack happens once at daemon level (deduped by design — ack is daemon-side, not subscriber-side).

## BDD Scenarios

### Sub-task 1 — `is_dm` propagation

```gherkin
Feature: Daemon tags messages with is_dm so DMs can be replied top-level

  Scenario: DM without existing thread
    Given a Slack event from channel "D12345" with no thread_ts
    When the daemon builds a SlackMessage
    Then message.is_dm is true
    And message.thread_ts is undefined

  Scenario: DM inside an existing thread
    Given a Slack event from channel "D12345" with thread_ts="1700000000.000100"
    When the daemon builds a SlackMessage
    Then message.is_dm is true
    And message.thread_ts equals "1700000000.000100"

  Scenario: Public channel message
    Given a Slack event from channel "C98765"
    When the daemon builds a SlackMessage
    Then message.is_dm is false

  Scenario: Private group DM
    Given a Slack event from channel "G55555"
    When the daemon builds a SlackMessage
    Then message.is_dm is false

  Scenario: MCP forwards is_dm to notification meta
    Given a MessagePayload with message.is_dm=true arrives at the MCP webhook
    When the MCP emits notifications/claude/channel
    Then meta.is_dm equals true
```

### Sub-task 2 — Thinking ack on route

```gherkin
Feature: Daemon acks incoming messages so users see Claude is working

  Scenario: At least one subscriber matches
    Given a SlackMessage with channel_id="C1" and message_ts="111.222"
    And one registered subscriber matching the message
    When the daemon routes the message
    Then reactions.add is called with name="eyes", channel="C1", timestamp="111.222"

  Scenario: No subscribers match
    Given a SlackMessage with no matching subscribers
    When the daemon routes the message
    Then reactions.add is not called
    And assistant.threads.setStatus is not called

  Scenario: DM without existing thread sets status on message_ts
    Given a SlackMessage with is_dm=true, message_ts="333.444", thread_ts=undefined
    And a matching subscriber
    When the daemon routes the message
    Then assistant.threads.setStatus is called with channel_id, thread_ts="333.444", status="thinking..."

  Scenario: Threaded message sets status on existing thread_ts
    Given a SlackMessage with thread_ts="999.000"
    And a matching subscriber
    When the daemon routes the message
    Then assistant.threads.setStatus is called with thread_ts="999.000"

  Scenario: reactions.add rejects — routing continues
    Given reactions.add will reject with "already_reacted"
    And a matching subscriber
    When the daemon routes the message
    Then the warning is logged
    And the subscriber webhook is still invoked

  Scenario: setStatus rejects — routing unaffected
    Given assistant.threads.setStatus will reject with "not_allowed_token_type"
    And a matching subscriber
    When the daemon routes the message
    Then no exception propagates
    And the subscriber webhook is still invoked

  Scenario: Env overrides honored
    Given SLACK_ACK_EMOJI="hourglass_flowing_sand" and SLACK_ACK_STATUS="working..."
    And a matching subscriber
    When the daemon routes the message
    Then reactions.add is called with name="hourglass_flowing_sand"
    And setStatus is called with status="working..."
```

### Sub-task 3 — Cleanup on successful reply

```gherkin
Feature: reply_slack clears the thinking ack on success

  Scenario: Successful reply removes the reaction
    Given reply_slack is called with channel_id="C1", text="hi", message_ts="111.222"
    And chat.postMessage resolves
    Then reactions.remove is called with name="eyes", channel="C1", timestamp="111.222"

  Scenario: Successful DM reply clears status on message_ts
    Given reply_slack is called with channel_id="D1", text="hi", message_ts="333.444" (no thread_ts)
    And chat.postMessage resolves
    Then assistant.threads.setStatus is called with channel_id="D1", thread_ts="333.444", status=""

  Scenario: Successful threaded reply clears status on existing thread_ts
    Given reply_slack is called with channel_id="C1", text="hi", message_ts="111.222", thread_ts="999.000"
    And chat.postMessage resolves
    Then assistant.threads.setStatus is called with thread_ts="999.000", status=""

  Scenario: reactions.remove rejects — tool still returns success
    Given chat.postMessage resolves
    And reactions.remove will reject with "no_reaction"
    When reply_slack is called
    Then the tool result has no isError flag
    And the warning is logged

  Scenario: message_ts missing
    Given reply_slack is called without message_ts
    Then the tool returns isError=true
    And the content explains message_ts is required
```

### Sub-task 4 — Documentation

```gherkin
Feature: README documents the new UX

  Scenario: README lists new env vars
    When a developer reads plugins/slack-bridge/README.md
    Then it documents SLACK_ACK_EMOJI and SLACK_ACK_STATUS with defaults
    And it lists the required Slack scopes reactions:write and assistant:write
    And it explains the DM reply behavior (no thread_ts in DMs unless already threaded)
```

## Dependency Graph

```
#1 is_dm ─┐
          ├──► #3 cleanup ──► #4 docs
#2 ack ───┘
```

- #1 and #2 are independent and can ship in parallel.
- #3 is blocked by both: it needs `is_dm` from #1 to pick the right `thread_ts` for `setStatus`, and it needs the env var parsing from #2 for the emoji name.
- #4 is a docs-only pass after the code is in place.

## TDD Plan

| Phase | Owner | Deliverable |
|-------|-------|-------------|
| RED | qa-agent | Tests in `src/__tests__/` covering every scenario above, using `vitest` mocks of `@slack/web-api`. Verify tests FAIL before handoff. |
| GREEN #1 + #2 | backend-lead (parallel) | `types.ts` + `daemon/index.ts` for #1; `daemon/ack.ts` + wiring for #2. |
| GREEN #3 | backend-lead | `ack-client.ts` + `mcp-server.ts` schema + cleanup wiring. |
| GREEN #4 | backend-lead | README + final `instructions` polish. |
| Security | security-reviewer | Scopes audit, secret leak scan, input validation on `message_ts`. |
