---
name: ipc-answer
description: Use to send an answer back to a child lead session that asked a question via parent IPC. The router-Claude sees inbound questions injected as `[ipc id=<uuid> from=<session>] <text>` lines; replying through this skill delivers the answer to the waiting child over the Unix socket the router boots with.
when_to_use: |
  Trigger on any inbound that arrives in this terminal prefixed with
  `[ipc id=<uuid> from=<session>] …`. That prefix is the router-IPC
  protocol marker: a child lead (booted in local mode without an attached
  operator) is blocking on a Unix socket waiting for your reply. Compose
  the answer and invoke this skill to deliver it.
argument-hint: <question_id> <answer text>
arguments: [id, text]
allowed-tools: Bash(node *)
---

# /ipc-answer — reply to a parent-IPC question from a child lead

When a child lead in local mode posts a question via `/ask-user`, the router's background IPC server injects it into this tmux session as a synthetic user message:

```
[ipc id=550e8400-e29b-41d4-a716-446655440000 from=feat/foo-bar] Should I use approach A or B for the X migration?
```

The id is the protocol handle; the `from` segment identifies which feature/session is waiting. The child lead is blocked on the socket connection waiting for the answer.

## Arguments

| Position | Meaning |
|----------|---------|
| `$ARGUMENTS[0]` (`id`) | The UUID from the `[ipc id=…]` prefix (required). |
| `$ARGUMENTS[1]` (`text`) | The full answer text. Free-form. Multi-line ok. |

## Steps

1. Read the inbound IPC line that triggered this skill. Extract the `id` from the `[ipc id=<uuid> …]` prefix verbatim.
2. Compose the answer. Address it to the child as if the operator were typing — the child lead receives the text as the response to its blocking `/ask-user --ask` call.
3. Resolve the script path. The IPC client lives at `${CLAUDE_PLUGIN_ROOT:-/Users/julianbuitrago/.claude/plugins/cache/ia-tools/team-workflow/0.8.0}/skills/router/scripts/ipc-client.mjs` when invoked from this plugin. For ad-hoc use, the script is also reachable relative to this SKILL.md as `../router/scripts/ipc-client.mjs`.
4. Invoke the client in `answer` mode:
   ```bash
   node "<path>/ipc-client.mjs" answer "<id>" "<answer text>"
   ```
5. Read the exit code:
   - `0` → answer delivered, child unblocked.
   - `2` → usage error (missing id or text).
   - `3` → IPC unavailable (`IA_TW_PARENT_SOCK` unset or socket missing). The router was not booted with the IPC server; the child is not actually waiting on this transport.
   - `5` → server rejected the answer (e.g. id unknown — child timed out and the question was evicted).

## Output

```
/ipc-answer dispatched
  Question id: <id>
  From:        <from session, parsed from the original prefix>
  Status:      delivered | timed-out | invalid-id
```

## Error handling

| Condition | Action |
|-----------|--------|
| `id` argument missing | STOP — print `Usage: /ipc-answer <question_id> <answer text>`. |
| Exit code 3 (no socket) | Report the router was not booted with IPC. The child lead probably fell back to terminal `AskUserQuestion` and the answer must be delivered there instead. |
| Exit code 5 (unknown id) | The question id was evicted (TTL expired or the child disconnected). Surface this to the operator — the child has already given up waiting. |
| Multi-line answer with special shell characters | Pass the text via a heredoc or quoted argument; the client treats `$ARGUMENTS[1..]` as a single text payload. |

## Scope

Own: parsing the `[ipc id=…]` prefix from an inbound line, invoking the IPC client in `answer` mode, surfacing the delivery status.

Boundaries:
- Stay out of question content. Answers are free-form; this skill never edits or post-processes the text.
- Do not invent ids. Use only the id from the matching inbound prefix.
- Do not retry on exit code 5 — the question was evicted; retrying delivers nothing.
