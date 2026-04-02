import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const getRulesSchema = z.object({
  context: z
    .string()
    .describe(
      'The context to get rules for (e.g., "base", "python", "typescript", "testing", "git", "review")'
    ),
});

export type GetRulesInput = z.infer<typeof getRulesSchema>;

export function handleGetRules(
  rulesDir: string,
  input: GetRulesInput
): { content: string; file: string } | { error: string } {
  const filename = input.context.replace(/\.md$/, "") + ".md";
  const filePath = join(rulesDir, filename);

  if (!existsSync(filePath)) {
    const available = getAvailableRules(rulesDir);
    return {
      error: `Rule file "${filename}" not found. Available rules: ${available.join(", ")}`,
    };
  }

  const content = readFileSync(filePath, "utf-8");
  return { content, file: filename };
}

function getAvailableRules(rulesDir: string): string[] {
  try {
    const { readdirSync } = require("node:fs");
    return readdirSync(rulesDir)
      .filter((f: string) => f.endsWith(".md"))
      .map((f: string) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}
