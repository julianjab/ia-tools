/**
 * REQ-007 — Daemon port file autodiscovery
 *
 * TDD RED phase: tests for resolveDaemonUrl() which does not exist yet.
 * All tests in this file MUST fail until the implementation is added.
 *
 * Target: src/ensure-daemon.ts — export resolveDaemonUrl(): string
 */

import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Module under test — resolveDaemonUrl does NOT exist yet (RED).
// The import itself will resolve because the module exists, but the named
// export will be undefined, causing every test below to fail.
// --------------------------------------------------------------------------
import { resolveDaemonUrl } from '../ensure-daemon.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Creates a temp state dir and writes daemon.port with the given content. */
function makeTempStateDir(portContent?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'req007-'));
  if (portContent !== undefined) {
    writeFileSync(join(dir, 'daemon.port'), portContent, 'utf8');
  }
  return dir;
}

/** Restores all env vars modified during a test. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const originals: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(overrides)) {
    originals[key] = process.env[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, orig] of Object.entries(originals)) {
      if (orig === undefined) delete process.env[key];
      else process.env[key] = orig;
    }
  }
}

// --------------------------------------------------------------------------
// Test suites
// --------------------------------------------------------------------------

describe('resolveDaemonUrl — AC-3: env > port file > fallback', () => {
  // ── Happy path ──────────────────────────────────────────────────────────

  it('returns DAEMON_URL env var when defined and non-empty (BDD: env precedence)', () => {
    // Given DAEMON_URL is set, daemon.port contains 3800
    const stateDir = makeTempStateDir('3800');
    withEnv({ DAEMON_URL: 'http://localhost:9000', XDG_STATE_HOME: stateDir }, () => {
      // When
      const url = resolveDaemonUrl();
      // Then: env wins, port file is ignored
      expect(url).toBe('http://localhost:9000');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('reads daemon.port and constructs URL when DAEMON_URL is not set (BDD: autodiscovery)', () => {
    // Given daemon.port contains "3800", DAEMON_URL not set
    const stateDir = makeTempStateDir('3800');
    withEnv({ DAEMON_URL: undefined, XDG_STATE_HOME: stateDir }, () => {
      // When
      const url = resolveDaemonUrl();
      // Then
      expect(url).toBe('http://localhost:3800');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('reads daemon.port with non-default port (BDD: daemon on port 4200)', () => {
    // Given daemon.port contains "4200", DAEMON_URL not set
    const stateDir = makeTempStateDir('4200');
    withEnv({ DAEMON_URL: undefined, XDG_STATE_HOME: stateDir }, () => {
      const url = resolveDaemonUrl();
      expect(url).toBe('http://localhost:4200');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ── DAEMON_URL empty string — treated as absent ─────────────────────────

  it('falls through to port file when DAEMON_URL is empty string (BDD: empty DAEMON_URL)', () => {
    // Given DAEMON_URL="" (empty), daemon.port="3800"
    const stateDir = makeTempStateDir('3800');
    withEnv({ DAEMON_URL: '', XDG_STATE_HOME: stateDir }, () => {
      const url = resolveDaemonUrl();
      // Then: empty string is treated as absent — reads port file
      expect(url).toBe('http://localhost:3800');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('falls through to port file when DAEMON_URL is whitespace-only', () => {
    const stateDir = makeTempStateDir('3800');
    withEnv({ DAEMON_URL: '   ', XDG_STATE_HOME: stateDir }, () => {
      const url = resolveDaemonUrl();
      expect(url).toBe('http://localhost:3800');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ── Fallback cases — invalid or missing port file ───────────────────────

  it('returns fallback http://localhost:3800 when daemon.port does not exist (BDD: first boot)', () => {
    // Given daemon.port does not exist, DAEMON_URL not set
    const stateDir = makeTempStateDir(); // no port file written
    withEnv({ DAEMON_URL: undefined, XDG_STATE_HOME: stateDir }, () => {
      // When / Then — must not throw
      let url: string;
      expect(() => {
        url = resolveDaemonUrl();
      }).not.toThrow();
      expect(url!).toBe('http://localhost:3800');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('returns fallback when daemon.port contains non-numeric string (BDD: invalid port file)', () => {
    const stateDir = makeTempStateDir('not-a-number');
    withEnv({ DAEMON_URL: undefined, XDG_STATE_HOME: stateDir }, () => {
      let url: string;
      expect(() => {
        url = resolveDaemonUrl();
      }).not.toThrow();
      expect(url!).toBe('http://localhost:3800');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('returns fallback when daemon.port contains port out of range >65535 (BDD: out-of-range port)', () => {
    const stateDir = makeTempStateDir('99999');
    withEnv({ DAEMON_URL: undefined, XDG_STATE_HOME: stateDir }, () => {
      let url: string;
      expect(() => {
        url = resolveDaemonUrl();
      }).not.toThrow();
      expect(url!).toBe('http://localhost:3800');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('returns fallback when daemon.port contains port 0 (boundary — out of valid range)', () => {
    const stateDir = makeTempStateDir('0');
    withEnv({ DAEMON_URL: undefined, XDG_STATE_HOME: stateDir }, () => {
      let url: string;
      expect(() => {
        url = resolveDaemonUrl();
      }).not.toThrow();
      expect(url!).toBe('http://localhost:3800');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('returns fallback when daemon.port is empty (BDD: empty port file)', () => {
    const stateDir = makeTempStateDir(''); // empty file
    withEnv({ DAEMON_URL: undefined, XDG_STATE_HOME: stateDir }, () => {
      let url: string;
      expect(() => {
        url = resolveDaemonUrl();
      }).not.toThrow();
      expect(url!).toBe('http://localhost:3800');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('returns fallback when daemon.port contains negative number', () => {
    const stateDir = makeTempStateDir('-1');
    withEnv({ DAEMON_URL: undefined, XDG_STATE_HOME: stateDir }, () => {
      let url: string;
      expect(() => {
        url = resolveDaemonUrl();
      }).not.toThrow();
      expect(url!).toBe('http://localhost:3800');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ── Valid boundary ports ─────────────────────────────────────────────────

  it('accepts port 1 (lower boundary) as valid (BDD: daemon on port 1)', () => {
    const stateDir = makeTempStateDir('1');
    withEnv({ DAEMON_URL: undefined, XDG_STATE_HOME: stateDir }, () => {
      const url = resolveDaemonUrl();
      expect(url).toBe('http://localhost:1');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('accepts port 65535 (upper boundary) as valid (BDD: daemon on port 65535)', () => {
    const stateDir = makeTempStateDir('65535');
    withEnv({ DAEMON_URL: undefined, XDG_STATE_HOME: stateDir }, () => {
      const url = resolveDaemonUrl();
      expect(url).toBe('http://localhost:65535');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ── DAEMON_URL trimming ──────────────────────────────────────────────────

  it('trims whitespace from DAEMON_URL before returning', () => {
    const stateDir = makeTempStateDir('3800');
    withEnv({ DAEMON_URL: '  http://localhost:9000  ', XDG_STATE_HOME: stateDir }, () => {
      const url = resolveDaemonUrl();
      expect(url).toBe('http://localhost:9000');
    });
    rmSync(stateDir, { recursive: true, force: true });
  });
});
