#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, resolve } from "node:path";
import { getRulesSchema, handleGetRules } from "./tools/get-rules.js";
import { handleListRules } from "./tools/list-rules.js";

// Default to the rules/ directory relative to the repo root
const rulesDir = resolve(
  process.env["RULES_DIR"] ?? join(import.meta.dirname, "..", "..", "..", "rules")
);

const server = new McpServer({
  name: "ia-tools-conventions",
  version: "0.1.0",
});

server.tool(
  "get_rules",
  "Get coding rules/standards for a specific context (e.g., python, typescript, testing, git, review, base)",
  getRulesSchema.shape,
  async (input) => {
    const result = handleGetRules(rulesDir, input);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "list_rules",
  "List all available rule files with their names, file paths, and applicable glob patterns",
  {},
  async () => {
    const rules = handleListRules(rulesDir);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ count: rules.length, rules }, null, 2),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`ia-tools-conventions MCP server running on stdio (rules: ${rulesDir})`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
