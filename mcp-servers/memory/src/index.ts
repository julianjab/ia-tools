#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JsonlStore } from "./store/jsonl.js";
import { rememberSchema, handleRemember } from "./tools/remember.js";
import { recallSchema, handleRecall } from "./tools/recall.js";
import { forgetSchema, handleForget } from "./tools/forget.js";
import { listSchema, handleList } from "./tools/list.js";

const store = new JsonlStore(process.env["MEMORY_FILE_PATH"] ?? undefined);

const server = new McpServer({
  name: "ia-tools-memory",
  version: "0.1.0",
});

server.tool(
  "remember",
  "Store a piece of knowledge (decision, pattern, mistake, convention, or note) for future reference",
  rememberSchema.shape,
  async (input) => {
    const memory = handleRemember(store, input);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ id: memory.id, stored: true }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "recall",
  "Search for relevant memories by keyword query",
  recallSchema.shape,
  async (input) => {
    const memories = handleRecall(store, input);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { count: memories.length, memories },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "forget",
  "Delete a memory by its UUID",
  forgetSchema.shape,
  async (input) => {
    const result = handleForget(store, input);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result),
        },
      ],
    };
  }
);

server.tool(
  "list_memories",
  "List and filter memories by project and/or tags",
  listSchema.shape,
  async (input) => {
    const memories = handleList(store, input);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { count: memories.length, memories },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ia-tools-memory MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
