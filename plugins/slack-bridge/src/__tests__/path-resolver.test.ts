/**
 * PathResolver — single source of truth for slack-bridge file paths.
 *
 * Contract:
 *   - Default base directory is `/tmp/slack-bridge`.
 *   - getSessionDir(sessionId)    → `<base>/<sessionId>`
 *   - getStateFilePath(sessionId) → `<base>/<sessionId>/slack-bridge.json`
 *   - getMcpLogPath(sessionId)    → `<base>/<sessionId>/mcp-logs.json`
 *   - getDaemonLogPath()          → `<base>/daemon-logs.json`
 *   - Constructor accepts an optional `baseDir` override (DI for tests + DAEMON_LOG env).
 *   - Pure: no side effects, no filesystem access.
 */

import { describe, expect, it } from 'vitest';

import { PathResolver } from '../shared/path-resolver.js';

describe('PathResolver — defaults', () => {
  it('uses /tmp/slack-bridge as the default base directory', () => {
    const r = new PathResolver();
    expect(r.getDaemonLogPath()).toBe('/tmp/slack-bridge/daemon-logs.json');
  });

  it('returns the session directory under the base', () => {
    const r = new PathResolver();
    expect(r.getSessionDir('abc-123')).toBe('/tmp/slack-bridge/abc-123');
  });

  it('returns the state file path inside the session directory', () => {
    const r = new PathResolver();
    expect(r.getStateFilePath('abc-123')).toBe('/tmp/slack-bridge/abc-123/slack-bridge.json');
  });

  it('returns the mcp log path inside the session directory', () => {
    const r = new PathResolver();
    expect(r.getMcpLogPath('abc-123')).toBe('/tmp/slack-bridge/abc-123/mcp-logs.json');
  });
});

describe('PathResolver — DI override', () => {
  it('honors a custom baseDir', () => {
    const r = new PathResolver({ baseDir: '/var/tmp/sbtest' });
    expect(r.getDaemonLogPath()).toBe('/var/tmp/sbtest/daemon-logs.json');
    expect(r.getSessionDir('s1')).toBe('/var/tmp/sbtest/s1');
    expect(r.getStateFilePath('s1')).toBe('/var/tmp/sbtest/s1/slack-bridge.json');
    expect(r.getMcpLogPath('s1')).toBe('/var/tmp/sbtest/s1/mcp-logs.json');
  });

  it('strips a trailing slash from baseDir', () => {
    const r = new PathResolver({ baseDir: '/var/tmp/sbtest/' });
    expect(r.getDaemonLogPath()).toBe('/var/tmp/sbtest/daemon-logs.json');
  });
});

describe('PathResolver — input validation', () => {
  it('throws when sessionId is empty', () => {
    const r = new PathResolver();
    expect(() => r.getSessionDir('')).toThrow(/sessionId/);
    expect(() => r.getStateFilePath('')).toThrow(/sessionId/);
    expect(() => r.getMcpLogPath('')).toThrow(/sessionId/);
  });
});
