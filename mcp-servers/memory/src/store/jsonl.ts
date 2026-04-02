import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  project: string | null;
  type: "decision" | "pattern" | "mistake" | "convention" | "note";
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_STORE_PATH = join(homedir(), ".ia-tools", "memory.jsonl");

export class JsonlStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_STORE_PATH;
    this.ensureFile();
  }

  private ensureFile(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, "", "utf-8");
    }
  }

  private readAll(): Memory[] {
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as Memory;
        } catch {
          console.error(`[ia-memory] Skipping corrupted line: ${line.slice(0, 100)}`);
          return null;
        }
      })
      .filter((m): m is Memory => m !== null);
  }

  private writeAll(memories: Memory[]): void {
    const content = memories.map((m) => JSON.stringify(m)).join("\n");
    writeFileSync(this.filePath, content ? content + "\n" : "", "utf-8");
  }

  remember(
    content: string,
    tags: string[],
    project: string | null,
    type: Memory["type"]
  ): Memory {
    const memory: Memory = {
      id: randomUUID(),
      content,
      tags,
      project,
      type,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const all = this.readAll();
    all.push(memory);
    this.writeAll(all);
    return memory;
  }

  recall(
    query: string,
    project: string | null,
    limit: number
  ): Memory[] {
    const all = this.readAll();
    const queryLower = query.toLowerCase();
    const words = queryLower.split(/\s+/);

    const scored = all
      .filter((m) => {
        if (project && m.project && m.project !== project) return false;
        return true;
      })
      .map((m) => {
        const contentLower = m.content.toLowerCase();
        const tagsLower = m.tags.map((t) => t.toLowerCase());

        let score = 0;
        for (const word of words) {
          if (contentLower.includes(word)) score += 2;
          if (tagsLower.some((t) => t.includes(word))) score += 3;
        }
        // Boost exact phrase match
        if (contentLower.includes(queryLower)) score += 5;

        return { memory: m, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => s.memory);
  }

  forget(id: string): boolean {
    const all = this.readAll();
    const idx = all.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    all.splice(idx, 1);
    this.writeAll(all);
    return true;
  }

  list(
    project: string | null,
    tags: string[] | null
  ): Memory[] {
    const all = this.readAll();
    return all.filter((m) => {
      if (project && m.project !== project) return false;
      if (tags && tags.length > 0) {
        const memTags = m.tags.map((t) => t.toLowerCase());
        if (!tags.some((t) => memTags.includes(t.toLowerCase()))) return false;
      }
      return true;
    });
  }
}
