import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuleSummary {
  name: string;
  file: string;
  paths: string[] | null;
  firstLine: string;
}

export function handleListRules(rulesDir: string): RuleSummary[] {
  let files: string[];
  try {
    files = readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  return files.map((file) => {
    const content = readFileSync(join(rulesDir, file), "utf-8");
    const name = file.replace(/\.md$/, "");

    // Extract paths from frontmatter if present
    let paths: string[] | null = null;
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const pathsMatch = frontmatterMatch[1].match(
        /paths:\n((?:\s+-\s+"[^"]+"\n?)+)/
      );
      if (pathsMatch) {
        paths = pathsMatch[1]
          .split("\n")
          .map((l) => l.trim().replace(/^-\s+"/, "").replace(/"$/, ""))
          .filter(Boolean);
      }
    }

    // Get first meaningful line (skip frontmatter and empty lines)
    const lines = content.replace(/^---[\s\S]*?---\n*/, "").split("\n");
    const firstLine =
      lines.find((l) => l.trim() && l.startsWith("# "))?.replace("# ", "") ??
      name;

    return { name, file, paths, firstLine };
  });
}
