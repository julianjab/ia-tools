import { z } from "zod";
import type { JsonlStore } from "../store/jsonl.js";

export const forgetSchema = z.object({
  id: z.string().uuid().describe("The UUID of the memory to delete"),
});

export type ForgetInput = z.infer<typeof forgetSchema>;

export function handleForget(store: JsonlStore, input: ForgetInput): { ok: boolean } {
  return { ok: store.forget(input.id) };
}
