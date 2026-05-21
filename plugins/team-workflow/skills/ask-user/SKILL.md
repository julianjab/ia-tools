---
name: ask-user
description: Use when a lead or worker agent needs to send a status update or ask a question to the user, and the destination depends on how the session was launched (Slack topic vs local terminal). Centralizes the routing decision so agent prompts stay clean of "if Slack else AskUserQuestion" branches.
when_to_use: |
  Trigger phrases: "tell the user", "notify the user", "ask the user",
  "send a status update", "publish the plan", "ask for approval", "post to Slack",
  "report progress". Invoke from any agent that talks to the human operator —
  lead, topic-worker, or any custom worker that needs a single point of contact.
argument-hint: <message text> [--ask] [--in-reply-to <message_ts>] [--channel <channel_id>] [--thread <thread_ts>]
arguments: [text, mode, message_ts, channel_id, thread_ts]
allowed-tools: Bash(echo *), Bash(node *), Read, AskUserQuestion
---

# /ask-user — route a message or question to the user

The user lives in different places depending on how the session booted. This skill picks the destination from the environment so the calling agent does not branch on `IA_TW_TOPIC` itself.

**Precondition (Slack topics with multi-listener potential).** When the inbound this call responds to may have been received by other sessions on the same topic, the caller is expected to have already invoked `claim_message(message_ts, …)` from slack-bridge before doing the work that produced this text. `/ask-user` does not re-acquire the claim; it relies on the holder's existing claim and re-checks it implicitly via `reply()`. If the caller skipped the upfront claim, `reply()` will attempt an atomic claim now — which protects against double-posting but does not protect against the wasted work that already happened.

Two modes:

| Form | Behavior |
|------|----------|
| `/ask-user "<text>"` | One-way notification (status update, ack, progress note). Returns when the message lands; does not block on a user reply. |
| `/ask-user --ask "<question>"` | Blocking question. The skill posts the question, then waits for the user's response and returns the response text. |

The skill never branches on transport in the calling prompt — it reads the environment once and dispatches.

## Routing decision (read once, then dispatch)

| Condition | Destination |
|-----------|-------------|
| `$IA_TW_TOPIC` is set and not the literal `local` | Slack via `slack-bridge.reply()` to that topic. |
| `$IA_TW_TOPIC == "local"` AND `$IA_TW_PARENT_SOCK` points at a live Unix socket | Parent-IPC: forward the question to the router-Claude that spawned this lead. The router's `/ipc-answer` skill delivers the response back through the same socket. |
| `$IA_TW_TOPIC == "local"` AND slack-bridge tools are available AND `$LEAD_LOCAL_FALLBACK_DM` resolves to a DM | Slack DM fallback (the same path the lead uses for local mode tier 1). |
| Otherwise | Local terminal: assistant message (one-way) or `AskUserQuestion` (blocking). |

The destination is decided **per invocation** from the environment — the caller does not have to remember its own mode. The Slack path always passes `message_ts` so the claim contract documented in slack-bridge instructions runs.

## Arguments

| Position | Meaning |
|----------|---------|
| `$ARGUMENTS[0]` (`text`) | The message body (required). Multi-line ok. |
| `--ask` (`mode`) | Treat the text as a question; block for a response. Without `--ask`, the call is one-way. |
| `--in-reply-to <ts>` (`message_ts`) | Slack message_ts of the inbound being responded to. Required when the destination is Slack and the call responds to a specific user message. Carried into `reply()` so the claim engages. |
| `--channel <id>` (`channel_id`) | Override the channel_id (defaults to the channel embedded in `$IA_TW_TOPIC`). |
| `--thread <ts>` (`thread_ts`) | Override the thread anchor (defaults to the thread embedded in `$IA_TW_TOPIC`, or to `message_ts`). |

## Steps

### 1. Resolve destination

Read `$IA_TW_TOPIC`. Four cases, evaluated in order:

1. **Slack topic** (not `local`, not empty): parse `<channel>:<user>:<thread_ts>` segments. The channel from the topic is the default `channel_id`; the thread segment is the default `thread_ts`. The skill resolves to `slack` mode.
2. **Parent IPC** (`$IA_TW_TOPIC == "local"` and `$IA_TW_PARENT_SOCK` points at an existing socket file): resolve to `ipc` mode. The question is forwarded over the Unix socket to the router that spawned this lead; the router's `/ipc-answer` skill delivers the response back through the same socket. Only the `--ask` form is supported in this mode — one-way notifications fall through to the next case.
3. **DM fallback** (`$IA_TW_TOPIC == "local"` and slack-bridge tools are visible and `$LEAD_LOCAL_FALLBACK_DM` is set): resolve to `slack` mode targeting the DM channel. Subscribe to it if the session has not subscribed already (label `ask-user:<IA_TW_FEATURE>`).
4. **Pure local**: resolve to `local` mode.

### 2. Dispatch

**Parent-IPC mode (`--ask` only)**

```bash
node "${CLAUDE_PLUGIN_ROOT:-…}/skills/router/scripts/ipc-client.mjs" ask "<text>"
```

The client connects to `$IA_TW_PARENT_SOCK`, posts the question with a generated UUID, blocks reading the socket until the router's `/ipc-answer` delivers the response (or `$IA_TW_IPC_TIMEOUT_MS` elapses — default 30 min). On stdout: the answer text verbatim. Exit codes:

| Code | Meaning | Action |
|------|---------|--------|
| 0 | answer received | return the stdout text to the caller |
| 3 | socket unavailable (env unset or path missing) | fall through to DM fallback / pure local |
| 4 | timeout | return `{kind: timeout, response: null}` |
| 5 | server error / unknown id | fall through and warn |

Parent-IPC does not support one-way (`--notify`-equivalent) calls: there is no useful destination for a fire-and-forget status on the parent side that the operator would actually see. Drop to DM fallback or pure local in that case.

**Slack mode, one-way**

```
reply(
  channel_id = <resolved channel>,
  message_ts = <--in-reply-to | latest inbound ts | now>,
  text       = "<text>",
  thread_ts  = <resolved thread>,
)
```

On `isError "Already claimed"`: another session won the user-facing reply for that `message_ts`. Report the loss back to the caller and stop — the caller decides whether to abandon the turn or pick a different `message_ts`.

**Slack mode, blocking (`--ask`)**

1. Send the question via `reply()` as above.
2. Read the topic's `thread_ts` (resolved from `$IA_TW_TOPIC` or the `--thread` override) so the next inbound from the user in that thread becomes the answer.
3. Block on the next inbound message on the resolved topic that is **not** a bot message. Return its text as the response.
4. If the user responds with an emoji reaction (`:white_check_mark:`, `:x:`), return the canonical equivalent: `aprobar` / `cancelar`. Any other text is returned verbatim.

**Local mode, one-way**

Print the text as an assistant message in the terminal. No return value beyond `Sent`.

**Local mode, blocking (`--ask`)**

Use `AskUserQuestion` with the text as the question and a single free-text option. Return the user's answer.

### 3. Output

```
/ask-user dispatched
  Mode:        <slack | local>
  Destination: <channel_id + thread_ts | terminal>
  Blocking:    <yes | no>
  Response:    "<text returned by the user>"   ← only when --ask
```

For one-way mode, the response section is omitted.

## Error handling

| Condition | Action |
|-----------|--------|
| `text` argument missing | STOP — print `Usage: /ask-user "<text>" [--ask] [--in-reply-to <ts>]`. |
| Slack mode but `reply()` returns isError "Already claimed" | Surface the error to the caller. Caller decides whether to retry with a different ts, or abandon the turn. |
| `$IA_TW_TOPIC` set to a value that does not parse as a topic | Treat as local mode and warn once. |
| Local-DM-fallback path unreachable (`list_subscriptions` fails) | Fall through to pure local mode. |
| `--ask` blocking call times out (no inbound in 30 min) | Return `{kind: timeout, response: null}`; caller decides whether to re-ask. |

## Scope

Own: routing decision (Slack vs local), Slack reply invocation with the correct message_ts/thread_ts, blocking semantics in local mode.

Boundaries:
- Stay out of approval-keyword parsing. The caller decides whether the response is `aprobar`/`cancelar`/edit — this skill returns the raw text and the canonical emoji mapping.
- Stay out of subscription lifecycle for the lead's main topic. Subscribe only the DM fallback label when needed.
- Do not modify `state.md` — that is the lead's job.
