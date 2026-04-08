import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const LOG_PATH =
  process.env["SLACK_BRIDGE_LOG_FILE"] ??
  join(process.cwd(), "mcp-servers", "slack-bridge", "slack-bridge.log");

// Ensure directory exists
try {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
} catch {
  // ignore
}

function ts(): string {
  return new Date().toISOString();
}

function write(level: string, msg: string): void {
  const line = `${ts()} [${level}] ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // fallback to stderr
    console.error(line.trim());
  }
}

export const log = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
  debug: (msg: string) => write("DEBUG", msg),
  path: LOG_PATH,
};
