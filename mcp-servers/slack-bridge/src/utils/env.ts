/**
 * Environment configuration for Slack Bridge MCP.
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN     — xoxb-... Bot User OAuth Token
 *   SLACK_APP_TOKEN     — xapp-... App-Level Token (Socket Mode)
 *
 * Optional:
 *   SLACK_CHANNELS      — Comma-separated channel IDs to monitor (default: all where bot is invited)
 *   SLACK_THREAD_ONLY   — "true" to only forward thread replies, not top-level messages
 */

export interface SlackEnv {
  botToken: string;
  appToken: string;
  threadOnly: boolean;
  /** "poll" = Claude calls poll_slack; "reactive" = sampling on each message */
  mode: "poll" | "reactive";
  /** Only receive DMs (im channels), ignore all public/private channels */
  dmUsers: string[];

  channels: string[];
  allowedUsers: string[];
  /** If set, only process messages in this specific thread */
  threadTs?: string;
}

export function loadEnv(): SlackEnv {
  const botToken = process.env["SLACK_BOT_TOKEN"];
  const appToken = process.env["SLACK_APP_TOKEN"];

  if (!botToken) {
    throw new Error(
      "Missing SLACK_BOT_TOKEN. Set it to your bot's xoxb-... token."
    );
  }
  if (!appToken) {
    throw new Error(
      "Missing SLACK_APP_TOKEN. Set it to your app-level xapp-... token (Socket Mode)."
    );
  }

  const channelsRaw = process.env["SLACK_CHANNELS"] ?? "";
  const channels = channelsRaw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const dmUsersRaw = process.env["SLACK_DM_USERS"] ?? "";
  const dmUsers = dmUsersRaw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const threadOnly = process.env["SLACK_THREAD_ONLY"] === "true";

  const modeRaw = process.env["SLACK_BRIDGE_MODE"] ?? "poll";
  const mode = modeRaw === "reactive" ? "reactive" : "poll";

  const threadTs = process.env["SLACK_THREAD_TS"] || undefined;

  const allowedUsersRaw = process.env["SLACK_ALLOWED_USERS"] ?? "";
  const allowedUsers = allowedUsersRaw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  return { botToken, appToken, channels, threadOnly, mode, dmUsers, threadTs, allowedUsers };
}
