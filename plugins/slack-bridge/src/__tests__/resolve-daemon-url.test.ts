/**
 * resolveDaemonUrl — DAEMON_URL env var resolution with local default fallback.
 *
 * Returns the trimmed DAEMON_URL value, or a local default so the MCP can
 * auto-boot the daemon out of the box.
 */

import { describe, expect, it } from 'vitest';
import { resolveDaemonUrl } from '../ensure-daemon.js';

const DEFAULT_URL = 'http://127.0.0.1:3800';

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const originals: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(overrides)) {
    originals[key] = process.env[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
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

describe('resolveDaemonUrl', () => {
  it('returns the DAEMON_URL value when set', () => {
    withEnv({ DAEMON_URL: 'http://localhost:9999' }, () => {
      expect(resolveDaemonUrl()).toBe('http://localhost:9999');
    });
  });

  it('trims whitespace from DAEMON_URL', () => {
    withEnv({ DAEMON_URL: '  http://localhost:9999  ' }, () => {
      expect(resolveDaemonUrl()).toBe('http://localhost:9999');
    });
  });

  it('falls back to the local default when DAEMON_URL is not set', () => {
    withEnv({ DAEMON_URL: undefined }, () => {
      expect(resolveDaemonUrl()).toBe(DEFAULT_URL);
    });
  });

  it('falls back to the local default when DAEMON_URL is empty string', () => {
    withEnv({ DAEMON_URL: '' }, () => {
      expect(resolveDaemonUrl()).toBe(DEFAULT_URL);
    });
  });

  it('falls back to the local default when DAEMON_URL is whitespace-only', () => {
    withEnv({ DAEMON_URL: '   ' }, () => {
      expect(resolveDaemonUrl()).toBe(DEFAULT_URL);
    });
  });
});
