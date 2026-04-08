/**
 * Reactive handler — uses MCP sampling to ask Claude to process
 * incoming Slack messages in real-time.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { WebClient } from "@slack/web-api";
import type { SlackMessage } from "../utils/message-store.js";
import { CreateMessageResultSchema } from "../utils/schemas.js";
import { log } from "../utils/logger.js";

export interface ReactiveConfig {
  systemPrompt: string;
  autoReply: boolean;
  maxTokens: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant monitoring Slack channels.
When you receive a Slack message, analyze it and respond appropriately.
You have access to tools like send_slack, read_slack_thread, and list_channels.

Guidelines:
- If someone asks a question, provide a helpful answer
- If someone mentions a bug or incident, summarize what you see and suggest next steps
- If the message is just casual chat, you can acknowledge briefly or skip
- Always be concise in Slack responses
- Use threads when replying (use the thread_ts from the incoming message)

Respond with a JSON object:
{
  "should_reply": true/false,
  "reply_text": "your response text (if should_reply is true)",
  "summary": "brief internal summary of what happened"
}`;

export function loadReactiveConfig(): ReactiveConfig {
  return {
    systemPrompt:
      process.env["SLACK_BRIDGE_SYSTEM_PROMPT"] ?? DEFAULT_SYSTEM_PROMPT,
    autoReply: process.env["SLACK_BRIDGE_AUTO_REPLY"] !== "false",
    maxTokens: parseInt(process.env["SLACK_BRIDGE_MAX_TOKENS"] ?? "1024", 10),
  };
}

export async function handleReactiveMessage(
  server: Server,
  web: WebClient,
  msg: SlackMessage,
  config: ReactiveConfig
): Promise<void> {
  try {
    const userMessage = [
      `New Slack message received:`,
      `- Channel: #${msg.channelName} (${msg.channel})`,
      `- From: ${msg.userName} (${msg.user})`,
      `- Thread: ${msg.threadTs ?? "top-level"}`,
      `- Timestamp: ${msg.ts}`,
      `- Text: ${msg.text}`,
    ].join("\n");

    log.info(`Sampling request for message from ${msg.userName}...`);

    const stream = server.experimental.tasks.createMessageStream(
      {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: userMessage },
          },
        ],
        systemPrompt: config.systemPrompt,
        maxTokens: config.maxTokens,
      },
      { timeout: 30_000 }
    );

    let responseText = "";

    for await (const message of stream) {
      if (message.type === "result") {
        const result = message.result;
        if (result.content && typeof result.content === "object" && "text" in result.content) {
          responseText = (result.content as { text: string }).text;
        } else if (result.content && typeof result.content === "string") {
          responseText = result.content;
        }
      } else if (message.type === "error") {
        log.error(`Sampling error: ${JSON.stringify(message.error)}`);
        return;
      }
    }

    if (!responseText) {
      log.warn("Empty response from Claude");
      return;
    }

    log.info(`Claude responded: ${responseText.slice(0, 100)}...`);

    if (config.autoReply) {
      try {
        const parsed = JSON.parse(responseText);
        if (parsed.should_reply && parsed.reply_text) {
          await web.chat.postMessage({
            channel: msg.channel,
            text: parsed.reply_text,
            thread_ts: msg.threadTs ?? msg.ts,
          });
          log.info(`Replied in #${msg.channelName}`);
        } else {
          log.info(`Skipped reply (should_reply=false)`);
        }
      } catch {
        await web.chat.postMessage({
          channel: msg.channel,
          text: responseText,
          thread_ts: msg.threadTs ?? msg.ts,
        });
        log.info(`Replied (raw) in #${msg.channelName}`);
      }
    }
  } catch (err) {
    log.error(`Reactive error: ${err}`);
  }
}
