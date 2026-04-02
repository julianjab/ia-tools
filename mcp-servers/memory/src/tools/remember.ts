import { z } from "zod";
import type { JsonlStore, Memory } from "../store/jsonl.js";

export const rememberSchema = z.object({
  content: z.string().describe("The knowledge to remember (decision, pattern, mistake, convention, or note)"),
  tags: z.array(z.string()).default([]).describe("Tags for categorization and search"),
  project: z.string().nullable().default(null).describe("Project name to scope this memory to (null for global)"),
  type: z
    .enum(["decision", "pattern", "mistake", "convention", "note"])
    .default("note")
    .describe("Type of knowledge being stored"),
});

export type RememberInput = z.infer<typeof rememberSchema>;

export function handleRemember(store: JsonlStore, input: RememberInput): Memory {
  return store.remember(input.content, input.tags, input.project, input.type);
}
