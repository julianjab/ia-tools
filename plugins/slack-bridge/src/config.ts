/**
 * loadConfig / saveConfig — reads and writes the slack-bridge state file.
 *
 * Schema:
 *   {
 *     "slack": {
 *       "topics": Array<string | { topic: string, label?: string }>
 *     }
 *   }
 *
 * The state file path is supplied by the caller (PathResolver in production).
 * If no path is given, the legacy `<cwd>/.claude/.slack-bridge.json` location
 * is used so existing tests and consumers keep working unchanged.
 *
 * - Any field whose name contains "token" (case-insensitive) is stripped and
 *   triggers a stderr warning so secrets never end up in the config object.
 * - Returns {} when the file is absent; warns + returns {} when JSON is invalid.
 * - saveConfig() merges the provided patch into the existing file's slack key.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TopicSpec } from './shared/types.js';

export interface SlackChannelConfig {
  topics?: Array<string | TopicSpec>;
}

export interface ChannelsConfig {
  slack?: SlackChannelConfig;
}

const ALLOWED_KEYS: ReadonlyArray<keyof SlackChannelConfig> = ['topics'];

/** Legacy location used when no explicit path is provided. */
function legacyConfigFilePath(cwd: string): string {
  return join(cwd, '.claude', '.slack-bridge.json');
}

function readRawFile(filePath: string): ChannelsConfig | null {
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[slack-bridge] Warning: ${filePath} contains invalid JSON — ${String(err)}\n`,
    );
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(`[slack-bridge] Warning: ${filePath} must be a JSON object — ignoring\n`);
    return null;
  }

  return parsed as ChannelsConfig;
}

function projectAllowed(slackSection: unknown): SlackChannelConfig {
  if (typeof slackSection !== 'object' || slackSection === null || Array.isArray(slackSection)) {
    return {};
  }
  const record = slackSection as Record<string, unknown>;

  // Warn and strip any field whose name contains "token"
  const tokenFields = Object.keys(record).filter((key) => key.toLowerCase().includes('token'));
  if (tokenFields.length > 0) {
    process.stderr.write(
      `[slack-bridge] Warning: state file contains token field(s): ${tokenFields.join(', ')} — tokens must not be stored in the state file. These fields are ignored.\n`,
    );
  }

  const config: SlackChannelConfig = {};
  for (const key of ALLOWED_KEYS) {
    if (key in record) {
      // biome-ignore lint/suspicious/noExplicitAny: iterating over known keys
      (config as any)[key] = record[key];
    }
  }
  return config;
}

/**
 * Load the slack channel config from the legacy `<cwd>/.claude/.slack-bridge.json`.
 * Kept for back-compat with existing tests/consumers; new callers should use
 * `loadConfigFromPath` and pass the path resolved via PathResolver.
 */
export function loadConfig(cwd?: string): SlackChannelConfig {
  const dir = cwd ?? process.cwd();
  const filePath = legacyConfigFilePath(dir);
  const raw = readRawFile(filePath);
  if (raw === null) return {};
  return projectAllowed(raw.slack);
}

/** Read the state file at an explicit absolute path. Used by the MCP entrypoint. */
export function loadConfigFromPath(stateFilePath: string): SlackChannelConfig {
  const raw = readRawFile(stateFilePath);
  if (raw === null) return {};
  return projectAllowed(raw.slack);
}

function writeMerged(filePath: string, patch: Partial<SlackChannelConfig>): void {
  // Ensure parent directory exists
  mkdirSync(dirname(filePath), { recursive: true });

  // Read existing file to preserve other top-level keys and merge slack section
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore parse errors — start fresh for the slack key
    }
  }

  const existingSlack =
    typeof existing.slack === 'object' && existing.slack !== null
      ? (existing.slack as Record<string, unknown>)
      : {};

  const mergedSlack: Record<string, unknown> = { ...existingSlack };
  for (const [key, value] of Object.entries(patch)) {
    if (key.toLowerCase().includes('token')) continue; // never persist token fields
    mergedSlack[key] = value;
  }

  const output: Record<string, unknown> = { ...existing, slack: mergedSlack };
  writeFileSync(filePath, JSON.stringify(output, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Save the slack channel config. Legacy: defaults to <cwd>/.claude/.slack-bridge.json. */
export function saveConfig(patch: Partial<SlackChannelConfig>, cwd?: string): void {
  writeMerged(legacyConfigFilePath(cwd ?? process.cwd()), patch);
}

/** Save to an explicit absolute path. Used by the MCP entrypoint. */
export function saveConfigAtPath(stateFilePath: string, patch: Partial<SlackChannelConfig>): void {
  writeMerged(stateFilePath, patch);
}
