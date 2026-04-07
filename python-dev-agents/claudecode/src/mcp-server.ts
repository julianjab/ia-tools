/**
 * MCP Server para Python Dev Agents (Claude Code).
 *
 * Expone herramientas de análisis de código Python como tools MCP.
 * Delega la lógica pesada a los scripts Python de libs/ia-core.
 *
 * Tools:
 * - analyze_complexity: Complejidad ciclomática y cognitiva
 * - detect_smells: Detección de code smells
 * - scaffold_tests: Generación de esqueleto de tests
 * - lint_check: Linting con ruff
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const LIBS_PATH = resolve(__dirname, "../../../libs/ia-core");

/**
 * Ejecuta un script Python de ia-core y retorna el resultado.
 */
async function runPythonAnalyzer(
  module: string,
  args: string[]
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "uv",
      ["run", "--directory", LIBS_PATH, "python", "-m", module, ...args],
      { timeout: 30_000 }
    );
    if (stderr) console.error(`[python-dev] stderr: ${stderr}`);
    return stdout;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: `Error ejecutando ${module}: ${msg}` });
  }
}

// --- MCP Server ---

const server = new McpServer({
  name: "python-dev-agents",
  version: "0.1.0",
});

server.tool(
  "analyze_complexity",
  "Analiza la complejidad ciclomática y cognitiva de un archivo Python",
  { file_path: z.string().describe("Ruta al archivo .py a analizar") },
  async ({ file_path }) => ({
    content: [
      {
        type: "text" as const,
        text: await runPythonAnalyzer("ia_core.analyzers.complexity", [
          file_path,
        ]),
      },
    ],
  })
);

server.tool(
  "detect_smells",
  "Detecta code smells comunes en un archivo Python",
  { file_path: z.string().describe("Ruta al archivo .py a analizar") },
  async ({ file_path }) => ({
    content: [
      {
        type: "text" as const,
        text: await runPythonAnalyzer("ia_core.analyzers.smells", [file_path]),
      },
    ],
  })
);

server.tool(
  "scaffold_tests",
  "Genera un esqueleto de tests pytest para un módulo Python",
  { file_path: z.string().describe("Ruta al archivo .py para generar tests") },
  async ({ file_path }) => ({
    content: [
      {
        type: "text" as const,
        text: await runPythonAnalyzer("ia_core.generators.test_scaffold", [
          file_path,
        ]),
      },
    ],
  })
);

server.tool(
  "lint_check",
  "Ejecuta ruff check sobre un archivo o directorio Python",
  {
    path: z.string().describe("Ruta al archivo o directorio"),
    fix: z
      .boolean()
      .optional()
      .default(false)
      .describe("Aplicar fixes automáticos"),
  },
  async ({ path, fix }) => {
    const args = ["check", "--output-format=json"];
    if (fix) args.push("--fix");
    args.push(path);

    try {
      const { stdout } = await execFileAsync("ruff", args, { timeout: 30_000 });
      const violations = stdout ? JSON.parse(stdout) : [];
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                path,
                total_violations: violations.length,
                fixed: fix,
                violations: violations.slice(0, 50),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
      };
    }
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
