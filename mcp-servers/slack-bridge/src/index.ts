#!/usr/bin/env node

/**
 * Slack Bridge — Claude Code Channel (official channels protocol).
 *
 * Pushes Slack messages into Claude via notifications/claude/channel.
 * Claude replies via the reply_slack tool.
 *
 * Run with: claude --dangerously-load-development-channels server:slack-bridge
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from "@slack/web-api";
import { log } from "./utils/logger.js";
import { loadEnv } from "./utils/env.js";
import { startSlackListener } from "./handlers/slack-listener.js";
import { MessageStore } from "./utils/message-store.js";

const env = loadEnv();
const web = new WebClient(env.botToken);
const store = new MessageStore();

// ─── MCP Server with claude/channel capability ──────────────────────
const mcp = new Server(
  { name: "slack-bridge", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      'Slack messages arrive as <channel source="slack-bridge" channel_id="..." channel_name="..." user_name="..." message_ts="..." thread_ts="...">.',
      "To reply, use the reply_slack tool passing channel_id and thread_ts (or message_ts if no thread_ts) from the tag attributes.",
      "Always reply in threads. Be concise.",
    ].join(" "),
  }
);

// ─── Tools: Claude calls these to interact with Slack ────────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply_slack",
      description: "Reply to a Slack message. Always use thread_ts to reply in-thread.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string", description: "Channel ID from the channel tag" },
          text: { type: "string", description: "Message text (supports Slack mrkdwn)" },
          thread_ts: { type: "string", description: "Thread ts from the channel tag (use message_ts if no thread_ts)" },
        },
        required: ["channel_id", "text"],
      },
    },
    {
      name: "list_slack_channels",
      description: "List Slack channels the bot is a member of",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;

  if (name === "reply_slack") {
    const { channel_id, text, thread_ts } = req.params.arguments as {
      channel_id: string;
      text: string;
      thread_ts?: string;
    };
    try {
      const result = await web.chat.postMessage({
        channel: channel_id,
        text,
        thread_ts,
      });
      log.info(`Replied in ${channel_id} ts=${result.ts}`);
      return { content: [{ type: "text" as const, text: `sent (ts: ${result.ts})` }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`reply_slack: ${msg}`);
      return { content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true };
    }
  }

  if (name === "list_slack_channels") {
    try {
      const result = await web.users.conversations({ types: "public_channel,private_channel", limit: 100 });
      const channels = (result.channels ?? []).map((c) => `#${c.name} (${c.id})`).join("\n");
      return { content: [{ type: "text" as const, text: channels || "No channels found" }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true };
    }
  }

  throw new Error(`unknown tool: ${name}`);
});

// ─── Connect MCP and start Slack ─────────────────────────────────────
await mcp.connect(new StdioServerTransport());
log.info("MCP channel ready");

// Start Slack listener — passes mcp so it can push notifications
startSlackListener({ env, store, mcp }).catch((err) => {
  log.error(`Slack connection failed: ${err}`);
});
