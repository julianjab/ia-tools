/**
 * REQ-007 — Daemon port file: write on listen + cleanup on shutdown
 *
 * TDD RED phase: tests for daemon port file behavior.
 *
 * These tests verify:
 *   AC-1: daemon writes daemon.port in the api.listen() callback
 *   AC-2: daemon.port is removed on SIGINT, SIGTERM, and process "exit"
 *
 * The daemon/index.ts module is a top-level script (not a library), so we
 * test the port file helpers by extracting the expected side-effects via
 * a dedicated helper module that the daemon should expose, OR by verifying
 * the filesystem state after controlled daemon startup.
 *
 * Strategy: import the pure helper functions that daemon/index.ts should
 * export — writePortFile(port, stateDir) and cleanupPortFile(stateDir).
 * These exports do NOT exist yet (RED).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach } from "vitest";

// --------------------------------------------------------------------------
// Module under test — writePortFile and cleanupPortFile do NOT exist yet.
// Importing them will yield undefined, making all assertions fail (RED).
// --------------------------------------------------------------------------
import { writePortFile, cleanupPortFile } from "../daemon/port-file.js";

// --------------------------------------------------------------------------
// Helper
// --------------------------------------------------------------------------

function makeTempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "req007-daemon-"));
  return dir;
}

// --------------------------------------------------------------------------
// AC-1: daemon writes daemon.port after listen()
// --------------------------------------------------------------------------

describe("writePortFile — AC-1: port file written after listen()", () => {
  it("creates daemon.port with the port number as a string", () => {
    // Given
    const stateDir = makeTempStateDir();

    // When — simulates what daemon calls in api.listen(port, callback)
    writePortFile(3800, stateDir);

    // Then
    const portFilePath = join(stateDir, "daemon.port");
    expect(existsSync(portFilePath)).toBe(true);
    expect(readFileSync(portFilePath, "utf8").trim()).toBe("3800");

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("creates daemon.port with non-default port (e.g. 4200)", () => {
    const stateDir = makeTempStateDir();

    writePortFile(4200, stateDir);

    const portFilePath = join(stateDir, "daemon.port");
    expect(readFileSync(portFilePath, "utf8").trim()).toBe("4200");

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("overwrites daemon.port if it already exists (stale port file)", () => {
    const stateDir = makeTempStateDir();
    const portFilePath = join(stateDir, "daemon.port");

    // Given: stale port file from dead daemon
    writeFileSync(portFilePath, "9999", "utf8");

    // When: new daemon starts on 3800
    writePortFile(3800, stateDir);

    // Then: file is overwritten
    expect(readFileSync(portFilePath, "utf8").trim()).toBe("3800");

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes port 1 (lower boundary)", () => {
    const stateDir = makeTempStateDir();
    writePortFile(1, stateDir);
    expect(readFileSync(join(stateDir, "daemon.port"), "utf8").trim()).toBe("1");
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes port 65535 (upper boundary)", () => {
    const stateDir = makeTempStateDir();
    writePortFile(65535, stateDir);
    expect(readFileSync(join(stateDir, "daemon.port"), "utf8").trim()).toBe("65535");
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("creates the state directory if it does not exist", () => {
    const parent = makeTempStateDir();
    // Use a non-existent subdirectory
    const stateDir = join(parent, "nested", "state");

    writePortFile(3800, stateDir);

    expect(existsSync(join(stateDir, "daemon.port"))).toBe(true);

    rmSync(parent, { recursive: true, force: true });
  });
});

// --------------------------------------------------------------------------
// AC-2: daemon cleans up daemon.port on shutdown signals and exit
// --------------------------------------------------------------------------

describe("cleanupPortFile — AC-2: port file removed on shutdown", () => {
  it("removes daemon.port when it exists (simulates SIGINT/SIGTERM/exit handler)", () => {
    // Given
    const stateDir = makeTempStateDir();
    const portFilePath = join(stateDir, "daemon.port");
    writeFileSync(portFilePath, "3800", "utf8");
    expect(existsSync(portFilePath)).toBe(true);

    // When — same function called in all three signal handlers
    cleanupPortFile(stateDir);

    // Then
    expect(existsSync(portFilePath)).toBe(false);

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("does not throw when daemon.port does not exist (idempotent cleanup)", () => {
    // Given — no port file
    const stateDir = makeTempStateDir();

    // When/Then — must be best-effort (no throw)
    expect(() => cleanupPortFile(stateDir)).not.toThrow();

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("is idempotent — calling twice does not throw", () => {
    const stateDir = makeTempStateDir();
    const portFilePath = join(stateDir, "daemon.port");
    writeFileSync(portFilePath, "3800", "utf8");

    cleanupPortFile(stateDir);
    // Second call — file already gone
    expect(() => cleanupPortFile(stateDir)).not.toThrow();

    rmSync(stateDir, { recursive: true, force: true });
  });
});
