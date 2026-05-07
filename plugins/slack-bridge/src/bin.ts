#!/usr/bin/env node

/**
 * Executable entry point for the slack-bridge MCP server.
 *
 * Kept deliberately thin: this is the ONLY place that triggers the
 * side-effecting bootstrap (signal handlers, session-id resolution,
 * `/tmp/slack-bridge/<id>/` dir creation, daemon ensure, port allocation,
 * stdio-transport connect). `mcp-server.ts` exports `main()` and the
 * `McpBridgeServer` class as plain library code, so importing it from a
 * test or another tool never starts the MCP.
 */

import { main } from './mcp-server.js';

await main();
