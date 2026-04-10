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
  info: (msg: string, ...args: unknown[]) => write("INFO", `${msg} ${JSON.stringify(args)}`),
  warn: (msg: string, ...args: unknown[]) => write("WARN", `${msg} ${JSON.stringify(args)}`),
  error: (msg: string, ...args: unknown[]) => write("ERROR", `${msg} ${JSON.stringify(args)}`),
  debug: (msg: string, ...args: unknown[]) => write("DEBUG", `${msg} ${JSON.stringify(args)}`),
  path: LOG_PATH,
};
