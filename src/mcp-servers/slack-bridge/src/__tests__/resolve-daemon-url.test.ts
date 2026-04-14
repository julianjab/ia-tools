/**
 * resolveDaemonUrl — DAEMON_URL env var resolution
 *
 * Returns the trimmed DAEMON_URL value, or null if unset/empty.
 * No port-file fallback — if DAEMON_URL is absent, subscription is skipped.
 */

import { describe, expect, it } from 'vitest';
import { resolveDaemonUrl } from '../ensure-daemon.js';

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
    withEnv({ DAEMON_URL: 'http://localhost:3800' }, () => {
      expect(resolveDaemonUrl()).toBe('http://localhost:3800');
    });
  });

  it('trims whitespace from DAEMON_URL', () => {
    withEnv({ DAEMON_URL: '  http://localhost:3800  ' }, () => {
      expect(resolveDaemonUrl()).toBe('http://localhost:3800');
    });
  });

  it('returns null when DAEMON_URL is not set', () => {
    withEnv({ DAEMON_URL: undefined }, () => {
      expect(resolveDaemonUrl()).toBeNull();
    });
  });

  it('returns null when DAEMON_URL is empty string', () => {
    withEnv({ DAEMON_URL: '' }, () => {
      expect(resolveDaemonUrl()).toBeNull();
    });
  });

  it('returns null when DAEMON_URL is whitespace-only', () => {
    withEnv({ DAEMON_URL: '   ' }, () => {
      expect(resolveDaemonUrl()).toBeNull();
    });
  });
});
