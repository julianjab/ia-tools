import { z } from "zod";
import type { JsonlStore, Memory } from "../store/jsonl.js";

export const listSchema = z.object({
  project: z.string().nullable().default(null).describe("Filter by project name (null for all)"),
  tags: z.array(z.string()).nullable().default(null).describe("Filter by tags (matches any)"),
});

export type ListInput = z.infer<typeof listSchema>;

export function handleList(store: JsonlStore, input: ListInput): Memory[] {
  return store.list(input.project, input.tags);
}
