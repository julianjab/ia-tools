#!/usr/bin/env node

/**
 * Quick test script to verify Slack connection works.
 * Usage: SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... node test-connection.mjs
 */

import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import { WebClient } from "@slack/web-api";

const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
const targetChannel = process.env.SLACK_CHANNELS || "";

if (!botToken || !appToken) {
  console.error("❌ Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN");
  process.exit(1);
}

console.log("🔌 Testing Slack connection...\n");

// Test 1: Web API - auth
const web = new WebClient(botToken);
try {
  const auth = await web.auth.test();
  console.log(`✅ Bot authenticated as: ${auth.user} (team: ${auth.team})`);
  console.log(`   Bot ID: ${auth.user_id}`);
} catch (err) {
  console.error(`❌ Auth failed: ${err.message}`);
  process.exit(1);
}

// Test 2: List channels the bot is in
try {
  const result = await web.users.conversations({
    types: "public_channel,private_channel",
    limit: 20,
  });
  const channels = result.channels || [];
  console.log(`\n✅ Bot is in ${channels.length} channels:`);
  for (const ch of channels) {
    const marker = ch.id === targetChannel ? " 👈 MONITORED" : "";
    console.log(`   #${ch.name} (${ch.id})${marker}`);
  }

  if (targetChannel && !channels.find((c) => c.id === targetChannel)) {
    console.log(
      `\n⚠️  Channel ${targetChannel} not found — invite the bot with /invite @bot-name`
    );
  }
} catch (err) {
  console.error(`❌ Failed to list channels: ${err.message}`);
}

// Test 3: Socket Mode connection
console.log("\n🔌 Testing Socket Mode...");
try {
  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });

  // Listen for any message (just to verify events work)
  let receivedMessage = false;
  app.message(async ({ message }) => {
    const msg = message;
    if (!receivedMessage) {
      receivedMessage = true;
      console.log(`\n✅ Received message from Slack: "${msg.text?.slice(0, 50)}..."`);
      console.log("   Socket Mode is working! Press Ctrl+C to stop.\n");
    }
  });

  await app.start();
  console.log("✅ Socket Mode connected!");
  console.log("\n📩 Waiting for a message... Write something in a channel where the bot is invited.");
  console.log("   (Press Ctrl+C to stop)\n");

  // Keep alive for 60 seconds then exit
  setTimeout(async () => {
    if (!receivedMessage) {
      console.log("\n⏱️  No messages received in 60s. Check that:");
      console.log("   1. The bot is invited to the channel");
      console.log("   2. Event Subscriptions are configured (message.channels, app_mention)");
      console.log("   3. Someone sends a message in that channel");
    }
    await app.stop();
    process.exit(0);
  }, 60000);
} catch (err) {
  console.error(`❌ Socket Mode failed: ${err.message}`);
  process.exit(1);
}
