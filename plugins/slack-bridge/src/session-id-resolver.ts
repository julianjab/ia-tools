/**
 * Session id resolution for the slack-bridge MCP.
 *
 * The MCP keys its working directory and state files off the canonical
 * Claude session UUID so logs in `/tmp/slack-bridge/<id>/` line up with
 * Claude's own per-session artifacts (`~/.claude/projects/<cwd>/<id>.jsonl`,
 * `~/.claude/debug/<id>.txt`). This module is the single source of truth
 * for finding that UUID.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Logger } from './logger.js';

/** How resolveSessionId derived the id it returned. */
export type SessionIdSource = 'file' | 'fallback';

/**
 * Claude writes ~/.claude/sessions/<claude_pid>.json with a `sessionId` UUID
 * when it boots. The MCP server is spawned as a child of Claude, so
 * process.ppid points at that exact file. Reading it lets us use the
 * canonical Claude session UUID as the directory namespace, making
 * correlation with Claude's own logs trivial (~/.claude/projects/.../
 * <sessionId>.jsonl, ~/.claude/debug/<sessionId>.txt).
 *
 * Settle gate: Claude rewrites this file twice during a `--resume`: once
 * with a placeholder sessionId on initial boot, then again with the resumed
 * transcript's sessionId once settled. The first write does not include a
 * `status` field, so we use that as our "is settled" gate. Without this
 * gate the MCP would persist the placeholder and create a
 * `/tmp/slack-bridge/<placeholder>/` directory that diverges from
 * `~/.claude/projects/<cwd>/<id>.jsonl`.
 *
 * Race: Claude often writes the session file in parallel with spawning the
 * MCP, so the first read can hit ENOENT or an empty/partial JSON. We retry
 * up to ~3 s before falling back, which covers both the cold-boot race and
 * the resume-settle window with margin while still bounding the worst case.
 *
 * Falls back to <ppid>-<pid> if the file is still unreadable / unsettled
 * after retries (e.g. the MCP being run standalone outside Claude).
 */
export async function readClaudeSessionId(ppid: number): Promise<string | null> {
  const path = `${homedir()}/.claude/sessions/${ppid}.json`;
  const ATTEMPTS = 30;
  const BACKOFF_MS = 100;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const raw = readFileSync(path, 'utf8');
      const data = JSON.parse(raw) as { sessionId?: string; status?: string };
      // Require BOTH a sessionId AND a non-empty `status`. The status field
      // is set by Claude only after it finishes booting / settling a resumed
      // transcript; before that the sessionId may be a placeholder that is
      // about to be overwritten.
      if (
        typeof data.sessionId === 'string' &&
        data.sessionId.length > 0 &&
        typeof data.status === 'string' &&
        data.status.length > 0
      ) {
        return data.sessionId;
      }
    } catch {
      /* not yet — fall through to backoff */
    }
    if (attempt < ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
    }
  }
  return null;
}

/**
 * Resolve the Claude session id with a 2-level fallback chain:
 *   1. ~/.claude/sessions/<ppid>.json — the per-process session file Claude
 *      writes at boot, polled with retry+backoff to absorb the spawn race.
 *      Covers 100% of cases when the MCP runs as a child of `claude`.
 *   2. <ppid>-<pid> — last-resort synthetic id when the file never appears
 *      (e.g. running the MCP standalone outside Claude).
 *
 * Note: an earlier draft also tried `CLAUDE_CODE_SESSION_ID` in the parent's
 * env via `ps eww`, but Claude does not expose that variable in its own
 * process environment — only on subprocesses it spawns for shell tools — so
 * the env probe never fired in practice. Dropped to keep the chain minimal.
 */
export async function resolveSessionId(
  ppid: number,
  logger: Logger,
): Promise<{ id: string; source: SessionIdSource }> {
  const fileId = await readClaudeSessionId(ppid);
  if (fileId) {
    logger.log(`session id from ~/.claude/sessions/${ppid}.json: ${fileId}`);
    return { id: fileId, source: 'file' };
  }
  const fallback = `${ppid}-${process.pid}`;
  logger.warn(
    `claude session id unavailable (ppid=${ppid} file unreadable); using fallback ${fallback}`,
  );
  return { id: fallback, source: 'fallback' };
}
