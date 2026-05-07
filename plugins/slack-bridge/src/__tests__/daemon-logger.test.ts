/**
 * DaemonLogger — path-scoped Logger for the daemon process.
 *
 * Contract:
 *   - Constructed with { logPath: string } (path is injected; no env reads).
 *   - Writes via the shared createLogger factory under label "daemon".
 *   - Exposes Logger surface: log/warn/error/debug + logPath.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DaemonLogger } from '../shared/daemon-logger.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'daemon-logger-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('DaemonLogger', () => {
  it('writes to the injected log path', () => {
    const logPath = join(tmp, 'daemon-logs.json');
    const logger = new DaemonLogger({ logPath });

    logger.log('boot');

    expect(logger.logPath).toBe(logPath);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('boot');
    expect(content).toContain('[daemon]');
    expect(content).toContain('INFO');
  });

  it('exposes the full Logger surface', () => {
    const logPath = join(tmp, 'daemon-logs.json');
    const logger = new DaemonLogger({ logPath });
    logger.log('i');
    logger.warn('w');
    logger.error('e');
    logger.debug('d');
    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('i');
    expect(content).toContain('w');
    expect(content).toContain('e');
    expect(content).toContain('d');
  });

  it('throws when logPath is empty', () => {
    expect(() => new DaemonLogger({ logPath: '' })).toThrow(/logPath/);
  });
});
