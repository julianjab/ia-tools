# Spec — Unix-socket-everywhere transport

**Status:** exploratory — not yet implemented. Captured for future iteration after the parent-IPC work landed in PR #83 (`feat/atomic-reply-claim`).

## Goal

Replace every TCP port team-workflow currently opens with a Unix domain socket, keeping functional parity. After the change, `lsof -i` shows zero ports owned by team-workflow components; `lsof -U` shows the sockets.

Concretely:

- The slack-bridge **daemon** stops binding a TCP port (today `localhost:<port>` discovered via `DAEMON_URL`). It binds a Unix socket at `$HOME/.claude/team-workflow/slack.sock` instead.
- The slack-bridge **MCP** stops spawning its own webhook server (today a random local TCP port the daemon POSTs into). It opens a persistent socket connection to the daemon and reads pushed events from it.
- The **per-tmux parent IPC** (introduced in PR #83 at `~/.claude/team-workflow/ipc/router-<tmux>.sock`) generalises to one socket per tmux session that can spawn children — not just the router. Each such tmux owns its socket; children inherit `IA_TW_PARENT_SOCK`.

## Why

This is a **consistency / hardening** spec, not a "something is on fire" spec. There is no concrete pain point in the current TCP setup; everything works. The motivation is:

1. **One protocol everywhere.** Today there are two transports: HTTP (daemon ↔ MCP, push via webhook callbacks) and JSONL-over-Unix-socket (parent IPC, introduced in PR #83). The migration collapses them into one. The shared module `src/shared/jsonl-socket.ts` becomes the only transport primitive in the plugin.
2. **Filesystem-grade security.** `chmod 0600 <sock>` enforces single-user access at the OS layer; no "I hope nobody on this machine scans `localhost`."
3. **No port reservation per Claude session.** Each MCP no longer asks the kernel for a free port at boot — one fewer race when many sessions start in parallel.
4. **Cleaner discovery.** Daemon location is a fixed path, not a runtime-allocated `DAEMON_URL`. No `ensure-daemon.sh` URL-resolution dance.

Reasons not to do it (and the reasons to keep this in spec form for now):

- Migration cost: ~3–4 days of implementation + half a day of real Slack testing.
- The protocol shape changes from request/response to persistent bidirectional stream — push semantics need reconnect logic, heartbeat, backpressure handling. New code, new failure modes.
- Cross-platform: Unix sockets are macOS / Linux only. Windows would need named pipes with different path conventions. If the consumer base is all Mac/Linux this is academic; if not, it matters.
- macOS socket path length cap (≈104 bytes). `$HOME/.claude/team-workflow/slack.sock` fits comfortably for typical `$HOME` values but limits the freedom to encode session IDs into the path.
- Coordinated MCP + daemon version bump per release. HTTP today tolerates minor drift; a wire-protocol swap does not.

## Architecture (after migration)

```
                 Slack API
                    │ socket-mode (unchanged)
                    ▼
   ┌──────────────────────────────────┐
   │  slack-listener daemon           │  one per machine
   │  binds: $HOME/.claude/team-      │  no TCP port
   │         workflow/slack.sock      │
   │  protocol: JSONL bidirectional   │
   └──────────────────────────────────┘
                    │ persistent socket
                    │ (push from daemon, requests from MCP)
                    ▼
   ┌──────────────────────────────────┐
   │  slack-bridge MCP                │  one per Claude session
   │  no webhook server, no own port  │
   │  reads pushed events from socket │
   └──────────────────────────────────┘

   Independently, each tmux that can spawn children:

   ┌──────────────────────────────────┐
   │  parent IPC socket               │  per tmux session
   │  $HOME/.claude/team-workflow/    │  (already implemented in
   │  ipc/<tmux-name>.sock            │   PR #83 for router; this
   │                                  │   spec generalises to any
   │                                  │   spawning tmux)
   └──────────────────────────────────┘
```

Routing inside the `/ask-user` skill stays unchanged from PR #83:

| Env state | Destination |
|-----------|-------------|
| `IA_TW_SLACK_TOPIC` set | slack-bridge `reply()` to that topic |
| `IA_TW_PARENT_SOCK` set and live | parent socket via `ipc-client.mjs ask` |
| Neither | terminal AskUserQuestion (vanilla session only — the redirect hook blocks this when team-workflow context is active) |

## Wire protocol (sketch)

Reuse the JSONL-line model already proven in PR #83.

**MCP → daemon (request frames):**

```
{type:"subscribe",   session_id, topics:[…]}
{type:"unsubscribe", session_id, topics?:[…]}
{type:"claim",       session_id, message_ts}
{type:"shutdown"}
{type:"health"}
```

**daemon → MCP (response + push frames, same connection):**

```
{type:"subscribed",   session_id, topics:[…]}
{type:"unsubscribed", session_id, topics:[…]}
{type:"claim_result", message_ts, claimed:bool, claimed_by?}
{type:"event",        topic, message:{channel_id, message_ts, text, …}}
{type:"health",       uptime, subscribers, socketMode}
{type:"error",        reason}
```

Connection lifecycle:

- MCP opens socket on boot, sends `subscribe` once.
- Connection stays open. Daemon pushes `event` frames as Slack messages arrive.
- MCP sends `claim` synchronously when it decides to work an inbound; correlates by `message_ts` on the response.
- If the connection breaks (daemon restart, EPIPE), MCP retries with exponential backoff and re-subscribes.

## Migration plan (when ready)

1. Extract `src/shared/jsonl-socket.ts` from the current parent-IPC code (`ipc-server.mjs` + `ipc-client.mjs`). Make it framework-agnostic (server side + client side + reconnect helper).
2. Add the new socket protocol to the daemon **alongside** the HTTP API. Old HTTP routes stay; the socket is additive.
3. Migrate the MCP to use the socket first, with an env override `DAEMON_TRANSPORT=http|socket` (default `socket` after rollout, `http` for one release to allow rollback).
4. Once stable across a release, remove the HTTP API and `webhook-server.ts`. `DAEMON_URL` env becomes unused; `DAEMON_SOCK` (path) replaces it.
5. Migrate the parent-IPC server and client to use the shared module so there is one implementation.
6. Update all tests. Add new integration tests that simulate daemon restart + MCP reconnect.

## Out of scope

- Cross-machine support (the current HTTP setup is already `localhost`-only in practice; this spec does not change that).
- Windows / named pipes.
- Replacing the slack-bridge's socket-mode connection to Slack itself (that stays exactly as is — Slack's API, not local IPC).
- Restructuring topics/claims/auth — only the transport changes.

## Open questions

- Should the daemon socket path be configurable via env (`DAEMON_SOCK`) for tests / CI, or pinned at `$HOME/.claude/team-workflow/slack.sock`? Probably configurable with the documented default.
- Permissions: enforce `0600` at bind time, or rely on parent directory perms? Probably bind-time, explicit.
- Heartbeat interval: how often does the MCP ping to detect a dead daemon? Suggested 30s with 90s timeout.
- Backpressure: what happens if a Slack burst arrives while an MCP is slow to read? Daemon queues up to N events, then drops oldest with a `dropped_event` notice. N TBD.

## Trigger for picking this up

Re-open when ANY of these conditions appear:

- A second team-workflow component needs JSONL-over-socket (justifies the shared module already, even without the slack-bridge migration).
- A real port conflict or firewall issue blocks team-workflow on someone's machine.
- The MCP's webhook-server becomes a real friction point (e.g. permission prompts on macOS, sandboxing, Docker bridges).

Otherwise: defer. The current HTTP + per-MCP webhook works; PR #83's parent-IPC fills the local-orchestration gap.
