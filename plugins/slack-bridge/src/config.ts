/**
 * loadConfig / saveConfig — reads and writes .claude/.slack-bridge.json.
 *
 * Schema:
 *   {
 *     "slack": {
 *       "topics": Array<string | { topic: string, label?: string }>
 *     }
 *   }
 *
 * Bare strings are accepted for ergonomics; objects let the caller attach a
 * label that the agent will see on every matched message.
 *
 * - Any field whose name contains "token" (case-insensitive) is stripped and
 *   triggers a stderr warning so secrets never end up in the config object.
 * - Returns {} when the file is absent; warns + returns {} when JSON is invalid.
 * - saveConfig() merges the provided patch into the existing file's slack key.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TopicSpec } from './shared/types.js';

export interface SlackChannelConfig {
  topics?: Array<string | TopicSpec>;
}

export interface ChannelsConfig {
  slack?: SlackChannelConfig;
}

const ALLOWED_KEYS: ReadonlyArray<keyof SlackChannelConfig> = ['topics'];

function configFilePath(cwd: string): string {
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
      `[slack-bridge] Warning: .claude/.slack-bridge.json contains invalid JSON — ${String(err)}\n`,
    );
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(
      '[slack-bridge] Warning: .claude/.slack-bridge.json must be a JSON object — ignoring file\n',
    );
    return null;
  }

  return parsed as ChannelsConfig;
}

export function loadConfig(cwd?: string): SlackChannelConfig {
  const dir = cwd ?? process.cwd();
  const filePath = configFilePath(dir);

  const raw = readRawFile(filePath);
  if (raw === null) return {};

  const slackSection = raw.slack;
  if (typeof slackSection !== 'object' || slackSection === null || Array.isArray(slackSection)) {
    return {};
  }

  const record = slackSection as Record<string, unknown>;

  // Warn and strip any field whose name contains "token"
  const tokenFields = Object.keys(record).filter((key) => key.toLowerCase().includes('token'));
  if (tokenFields.length > 0) {
    process.stderr.write(
      `[slack-bridge] Warning: .claude/.slack-bridge.json contains token field(s): ${tokenFields.join(', ')} — tokens must not be stored in .slack-bridge.json. These fields are ignored.\n`,
    );
  }

  // Return only the known safe fields
  const config: SlackChannelConfig = {};
  for (const key of ALLOWED_KEYS) {
    if (key in record) {
      // biome-ignore lint/suspicious/noExplicitAny: iterating over known keys
      (config as any)[key] = record[key];
    }
  }

  return config;
}

export function saveConfig(patch: Partial<SlackChannelConfig>, cwd?: string): void {
  const dir = cwd ?? process.cwd();
  const filePath = configFilePath(dir);
  const claudeDir = join(dir, '.claude');

  // Ensure .claude/ directory exists
  mkdirSync(claudeDir, { recursive: true });

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

  // Merge patch into existing slack section
  const mergedSlack: Record<string, unknown> = { ...existingSlack };
  for (const [key, value] of Object.entries(patch)) {
    if (key.toLowerCase().includes('token')) continue; // never persist token fields
    mergedSlack[key] = value;
  }

  const output: Record<string, unknown> = { ...existing, slack: mergedSlack };
  writeFileSync(filePath, JSON.stringify(output, null, 2), { encoding: 'utf8', mode: 0o600 });
}
