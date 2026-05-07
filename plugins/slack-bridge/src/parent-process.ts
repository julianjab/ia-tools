/**
 * Parent-process inspection.
 *
 * The slack-bridge MCP needs two pieces of information about the Claude
 * process that spawned it: whether the operator passed
 * `--dangerously-load-development-channels` (required for the experimental
 * `claude/channel` capability) and whether they passed `--agent <name>`
 * (which signals "leave the agent's prompt as the active personality").
 *
 * Neither flag is propagated to MCP children via env, but both live in the
 * parent's argv, which `ps -ww -p <pid> -o command=` exposes.
 */

import { execSync } from 'node:child_process';

/**
 * Read the parent process's full command line via `ps -ww -p <ppid> -o command=`.
 * Returns the trimmed string, or `''` on any failure (process gone,
 * `ps` unavailable, etc.).
 */
export function readParentCmd(ppid: number): string {
  try {
    return execSync(`ps -ww -p ${ppid} -o command=`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * True when the parent argv contains `--agent ` (with the trailing space —
 * we want to match the flag, not a substring of an agent name embedded in
 * some other argument).
 */
export function hasAgentFlag(parentCmd: string): boolean {
  return parentCmd.includes('--agent ');
}

/**
 * True when the parent argv contains `--dangerously-load-development-channels`,
 * the flag that enables the experimental `claude/channel` capability the
 * slack-bridge MCP depends on.
 */
export function hasDevChannelsFlag(parentCmd: string): boolean {
  return parentCmd.includes('--dangerously-load-development-channels');
}
