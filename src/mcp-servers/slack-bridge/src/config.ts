/**
 * loadConfig — reads optional .slack.json from the working directory.
 *
 * Supported fields: channels, users, threads, label.
 * Any field whose name contains "token" (case-insensitive) is stripped and
 * triggers a warning so secrets never end up in the config object.
 *
 * Returns {} when the file is absent; warns + returns {} when JSON is invalid.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface SlackConfig {
  channels?: string[];
  users?: string[];
  threads?: string[];
  label?: string;
}

const ALLOWED_KEYS: ReadonlyArray<keyof SlackConfig> = ["channels", "users", "threads", "label"];

export function loadConfig(cwd?: string): SlackConfig {
  const dir = cwd ?? process.cwd();
  const filePath = join(dir, ".slack.json");

  if (!existsSync(filePath)) {
    return {};
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[slack-bridge] Warning: .slack.json contains invalid JSON — ${String(err)}\n`
    );
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(
      `[slack-bridge] Warning: .slack.json must be a JSON object — ignoring file\n`
    );
    return {};
  }

  const record = parsed as Record<string, unknown>;

  // Warn and strip any field whose name contains "token"
  const tokenFields = Object.keys(record).filter((key) =>
    key.toLowerCase().includes("token")
  );
  if (tokenFields.length > 0) {
    process.stderr.write(
      `[slack-bridge] Warning: .slack.json contains token field(s): ${tokenFields.join(", ")} — tokens must not be stored in .slack.json. These fields are ignored.\n`
    );
  }

  // Return only the known safe fields
  const config: SlackConfig = {};
  for (const key of ALLOWED_KEYS) {
    if (key in record) {
      if (key === "label") {
        config.label = record[key] as string;
      } else {
        (config[key] as string[]) = record[key] as string[];
      }
    }
  }

  return config;
}
