/**
 * Loader for the session-manager role prompt.
 *
 * The slack-bridge MCP optionally surfaces the session-manager prompt as
 * its `instructions` field so the operator's main Claude session adopts
 * that role. The decision to load (or skip) the prompt is made by the
 * entry point based on whether the parent Claude process was launched with
 * an `--agent` flag.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './logger.js';

/**
 * Load the session-manager role prompt from `${CLAUDE_PLUGIN_ROOT}/agents/session-manager.md`.
 * Returns an empty string (and logs a warning) on any failure — empty is the
 * "skip injection" sentinel that the constructor honours.
 */
export function loadSessionManagerPrompt(log: Logger): string {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) {
    log.warn('CLAUDE_PLUGIN_ROOT unset — session-manager prompt unavailable');
    return '';
  }
  const path = join(pluginRoot, 'agents', 'session-manager.md');
  if (!existsSync(path)) {
    log.warn(`session-manager prompt not found at ${path}`);
    return '';
  }
  try {
    const content = readFileSync(path, 'utf8');
    log.log(`loaded session-manager prompt (${content.length} chars) from ${path}`);
    return content;
  } catch (err) {
    log.warn(`failed to read session-manager prompt at ${path}: ${err}`);
    return '';
  }
}
