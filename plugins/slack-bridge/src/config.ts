/**
 * loadConfig / saveConfig — reads and writes .claude/.channels.json.
 *
 * Schema:
 *   {
 *     "slack": {
 *       "bot":     { "label": string },
 *       "channels": string[],
 *       "dms":      string[],
 *       "threads":  string[],
 *       "filters":  { "channel": regexp-string, "user": regexp-string,
 *                     "message": regexp-string, "thread": regexp-string }
 *     }
 *   }
 *
 * - Any field whose name contains "token" (case-insensitive) is stripped and
 *   triggers a stderr warning so secrets never end up in the config object.
 * - Returns {} when the file is absent; warns + returns {} when JSON is invalid.
 * - saveConfig() merges the provided patch into the existing file's slack key.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SlackFilters {
  channel?: string; // regexp string — filter by channel name
  user?: string; // regexp string — filter by user name / ID
  message?: string; // regexp string — filter by message text
  thread?: string; // regexp string — filter by thread ts
}

export interface SlackChannelConfig {
  bot?: { label?: string };
  channels?: string[];
  dms?: string[];
  threads?: string[];
  filters?: SlackFilters;
}

export interface ChannelsConfig {
  slack?: SlackChannelConfig;
}

const ALLOWED_KEYS: ReadonlyArray<keyof SlackChannelConfig> = [
  'bot',
  'channels',
  'dms',
  'threads',
  'filters',
];

function configFilePath(cwd: string): string {
  return join(cwd, '.claude', '.channels.json');
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
      `[slack-bridge] Warning: .claude/.channels.json contains invalid JSON — ${String(err)}\n`,
    );
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(
      '[slack-bridge] Warning: .claude/.channels.json must be a JSON object — ignoring file\n',
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
      `[slack-bridge] Warning: .claude/.channels.json contains token field(s): ${tokenFields.join(', ')} — tokens must not be stored in .channels.json. These fields are ignored.\n`,
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
