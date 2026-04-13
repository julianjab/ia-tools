/**
 * REQ-008 — TDD RED phase
 *
 * Tests for loadConfig() in src/config.ts (FILE DOES NOT EXIST YET).
 * All tests are expected to fail until the implementation is written.
 *
 * Scenarios covered:
 *   - Happy path: .slack.json present and valid
 *   - Multiple fields (channels, users, threads, label)
 *   - Env vars override file values
 *   - Env var absent / empty does not override file
 *   - No .slack.json → empty config, no error
 *   - Invalid JSON → warning + empty config, no crash
 *   - Field containing "token" → warning, field ignored
 *   - Field "bot_token" → warning, field ignored
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Setup: isolated cwd per test ───────────────────────────────────────────

let testDir: string;
let originalCwd: () => string;

beforeEach(() => {
  // Each test gets its own tmp directory so process.cwd() is predictable
  testDir = join(tmpdir(), `req-008-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  originalCwd = process.cwd.bind(process);
  vi.spyOn(process, "cwd").mockReturnValue(testDir);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
  // Reset env vars that may have been set during tests
  delete process.env["SLACK_CHANNELS"];
  delete process.env["SLACK_USERS"];
  delete process.env["SLACK_THREADS"];
});

// ─── Helper ─────────────────────────────────────────────────────────────────

function writeSlackJson(content: unknown | string): void {
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  writeFileSync(join(testDir, ".slack.json"), raw, "utf8");
}

// ─── Import under test ──────────────────────────────────────────────────────
// This import will fail (MODULE NOT FOUND) until config.ts is created.
// That is the expected RED state.

const { loadConfig } = await import("../config.js");

// ─── Scenario: auto-subscribe desde .slack.json al arrancar ─────────────────

describe("loadConfig() — happy path", () => {
  it("retorna channels del archivo cuando SLACK_CHANNELS no esta definido", () => {
    // Given
    writeSlackJson({ channels: ["C123ABC"] });
    delete process.env["SLACK_CHANNELS"];

    // When
    const config = loadConfig();

    // Then
    expect(config.channels).toEqual(["C123ABC"]);
  });

  it("retorna todos los campos validos del archivo", () => {
    // Given
    writeSlackJson({
      channels: ["C123ABC"],
      users: ["U789GHI"],
      threads: [],
      label: "mi-workspace",
    });

    // When
    const config = loadConfig();

    // Then
    expect(config.channels).toEqual(["C123ABC"]);
    expect(config.users).toEqual(["U789GHI"]);
    expect(config.threads).toEqual([]);
    expect(config.label).toBe("mi-workspace");
  });

  it("ignora campos desconocidos sin error", () => {
    // Given
    writeSlackJson({ channels: ["C123ABC"], unknownField: "ignored" });

    // When — should not throw
    expect(() => loadConfig()).not.toThrow();
  });
});

// ─── Scenario: arranca normalmente sin .slack.json ───────────────────────────

describe("loadConfig() — archivo ausente", () => {
  it("retorna config vacia cuando no existe .slack.json", () => {
    // Given: testDir exists but has no .slack.json

    // When
    const config = loadConfig();

    // Then
    expect(config.channels ?? []).toEqual([]);
    expect(config.users ?? []).toEqual([]);
    expect(config.threads ?? []).toEqual([]);
    expect(config.label).toBeUndefined();
  });

  it("no emite ningun warning cuando no existe .slack.json", () => {
    // Given: no file

    // When
    loadConfig();

    // Then: stderr was not written
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it("no lanza excepcion cuando no existe .slack.json", () => {
    expect(() => loadConfig()).not.toThrow();
  });
});

// ─── Scenario: .slack.json con JSON invalido ────────────────────────────────

describe("loadConfig() — JSON invalido", () => {
  it("retorna config vacia cuando el JSON es invalido", () => {
    // Given
    writeSlackJson("{ channels: broken");

    // When
    const config = loadConfig();

    // Then
    expect(config.channels ?? []).toEqual([]);
    expect(config.users ?? []).toEqual([]);
    expect(config.threads ?? []).toEqual([]);
  });

  it("emite warning por stderr que menciona .slack.json cuando JSON es invalido", () => {
    // Given
    writeSlackJson("{ channels: broken");

    // When
    loadConfig();

    // Then
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const warningOutput = stderrCalls.map((args: unknown[]) => String(args[0])).join("");
    expect(warningOutput).toMatch(/\.slack\.json/i);
  });

  it("emite warning que incluye 'invalid JSON' o similar cuando JSON es invalido", () => {
    // Given
    writeSlackJson("not json at all !!!");

    // When
    loadConfig();

    // Then
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const warningOutput = stderrCalls.map((args: unknown[]) => String(args[0])).join("");
    // Accept "invalid JSON", "parse error", "SyntaxError", etc.
    expect(warningOutput).toMatch(/invalid|parse|syntax/i);
  });

  it("no llama process.exit cuando JSON es invalido", () => {
    // Given
    writeSlackJson("INVALID");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    // When / Then — should not call exit
    expect(() => loadConfig()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ─── Scenario: campo "token" genera warning ──────────────────────────────────

describe("loadConfig() — campo con 'token' en el nombre", () => {
  it("emite warning cuando el archivo contiene un campo llamado 'token'", () => {
    // Given
    writeSlackJson({ channels: ["C123ABC"], token: "xoxb-secret" });

    // When
    loadConfig();

    // Then
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const warningOutput = stderrCalls.map((args: unknown[]) => String(args[0])).join("");
    expect(warningOutput).toMatch(/token/i);
  });

  it("el campo 'token' no aparece en la config retornada", () => {
    // Given
    writeSlackJson({ channels: ["C123ABC"], token: "xoxb-secret" });

    // When
    const config = loadConfig();

    // Then
    expect((config as Record<string, unknown>)["token"]).toBeUndefined();
  });

  it("emite warning cuando el archivo contiene 'bot_token'", () => {
    // Given
    writeSlackJson({ channels: ["C456DEF"], bot_token: "xoxb-bot-secret" });

    // When
    loadConfig();

    // Then
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const warningOutput = stderrCalls.map((args: unknown[]) => String(args[0])).join("");
    expect(warningOutput).toMatch(/token/i);
  });

  it("el campo 'bot_token' no aparece en la config retornada", () => {
    // Given
    writeSlackJson({ channels: ["C456DEF"], bot_token: "xoxb-bot-secret" });

    // When
    const config = loadConfig();

    // Then
    expect((config as Record<string, unknown>)["bot_token"]).toBeUndefined();
  });

  it("retorna el resto de la config correctamente aun cuando hay campo token", () => {
    // Given
    writeSlackJson({ channels: ["C123ABC"], users: ["U789GHI"], token: "xoxb-secret" });

    // When
    const config = loadConfig();

    // Then — known safe fields are preserved
    expect(config.channels).toEqual(["C123ABC"]);
    expect(config.users).toEqual(["U789GHI"]);
  });
});

// ─── Scenario: env vars tienen precedencia sobre .slack.json ─────────────────

describe("loadConfig() — env vars vs archivo (integracion con mcp-server)", () => {
  /**
   * NOTE: loadConfig() itself returns the raw file config.
   * The merge logic (env var precedence) lives in mcp-server.ts.
   * These tests validate the CONTRACT that allows that merge to work:
   * loadConfig() must return the file values so the caller can apply precedence.
   */

  it("retorna channels del archivo para que el caller pueda aplicar precedencia de env vars", () => {
    // Given: archivo con C123ABC, env con C999ZZZ
    writeSlackJson({ channels: ["C123ABC"] });
    process.env["SLACK_CHANNELS"] = "C999ZZZ";

    // When
    const config = loadConfig();

    // Then: config devuelve lo del archivo (el merge lo hace el caller)
    expect(config.channels).toEqual(["C123ABC"]);
    // Caller logic: env ?? file → "C999ZZZ".split(",") → ["C999ZZZ"]
    const effective = process.env["SLACK_CHANNELS"]?.split(",").filter(Boolean) ?? config.channels ?? [];
    expect(effective).toEqual(["C999ZZZ"]);
  });

  it("el caller puede usar channels del archivo cuando env var no esta definida", () => {
    // Given: archivo con C123ABC, sin env var
    writeSlackJson({ channels: ["C123ABC"] });
    delete process.env["SLACK_CHANNELS"];

    // When
    const config = loadConfig();

    // Then: caller logic falls back to file
    const effective = process.env["SLACK_CHANNELS"]?.split(",").filter(Boolean) ?? config.channels ?? [];
    expect(effective).toEqual(["C123ABC"]);
  });

  it("sin archivo y sin env var, el caller obtiene lista vacia", () => {
    // Given: no file, no env var
    delete process.env["SLACK_CHANNELS"];

    // When
    const config = loadConfig();

    // Then
    const effective = process.env["SLACK_CHANNELS"]?.split(",").filter(Boolean) ?? config.channels ?? [];
    expect(effective).toEqual([]);
  });
});
