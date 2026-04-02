import { z } from "zod";
import type { JsonlStore, Memory } from "../store/jsonl.js";

export const recallSchema = z.object({
  query: z.string().describe("Search query to find relevant memories"),
  project: z.string().nullable().default(null).describe("Filter by project name (null for all)"),
  limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of results"),
});

export type RecallInput = z.infer<typeof recallSchema>;

export function handleRecall(store: JsonlStore, input: RecallInput): Memory[] {
  return store.recall(input.query, input.project, input.limit);
}
