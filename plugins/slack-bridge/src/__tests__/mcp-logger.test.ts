/**
 * McpLogger — session-scoped Logger for the MCP server.
 *
 * Contract:
 *   - Constructed with { sessionId, paths?: PathResolver, stderr?: boolean }.
 *   - Resolves its log file via paths.getMcpLogPath(sessionId).
 *   - Writes JSON-style lines via the shared createLogger factory under label "mcp".
 *   - Exposes Logger surface: log/warn/error/debug + logPath.
 *   - Defaults to writing all levels to stderr (MCP protocol uses stdout).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpLogger } from '../shared/mcp-logger.js';
import { PathResolver } from '../shared/path-resolver.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-logger-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('McpLogger', () => {
  it('writes its log file inside paths.getMcpLogPath(sessionId)', () => {
    const paths = new PathResolver({ baseDir: tmp });
    const logger = new McpLogger({ sessionId: 'sess-1', paths });

    logger.log('hello');

    const expected = join(tmp, 'sess-1', 'mcp-logs.json');
    expect(logger.logPath).toBe(expected);
    expect(existsSync(expected)).toBe(true);

    const content = readFileSync(expected, 'utf8');
    expect(content).toContain('hello');
    expect(content).toContain('[mcp]');
    expect(content).toContain('INFO');
  });

  it('exposes the Logger surface (log/warn/error/debug)', () => {
    const paths = new PathResolver({ baseDir: tmp });
    const logger = new McpLogger({ sessionId: 'sess-2', paths });

    logger.log('info-msg');
    logger.warn('warn-msg');
    logger.error('error-msg');
    logger.debug('debug-msg');

    const content = readFileSync(join(tmp, 'sess-2', 'mcp-logs.json'), 'utf8');
    expect(content).toContain('info-msg');
    expect(content).toContain('warn-msg');
    expect(content).toContain('error-msg');
    expect(content).toContain('debug-msg');
  });

  it('uses a default PathResolver when none is provided', () => {
    const logger = new McpLogger({ sessionId: 'sess-default' });
    expect(logger.logPath).toBe('/tmp/slack-bridge/sess-default/mcp-logs.json');
  });

  it('throws when sessionId is empty', () => {
    expect(() => new McpLogger({ sessionId: '' })).toThrow(/sessionId/);
  });
});
