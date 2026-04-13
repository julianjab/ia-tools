/**
 * REQ-008 — Updated schema (TDD RED → GREEN)
 *
 * Tests for loadConfig() and saveConfig() in src/config.ts.
 *
 * File location: .claude/.channels.json
 * Schema: { "slack": { "bot": { "label": string }, "channels": string[],
 *                       "dms": string[], "threads": string[],
 *                       "filters": { "channel": string, "user": string,
 *                                    "message": string, "thread": string } } }
 *
 * Scenarios covered:
 *   - Happy path: .claude/.channels.json present and valid
 *   - Full schema (bot, channels, dms, threads, filters)
 *   - Missing file → empty config, no error
 *   - Invalid JSON → warning + empty config, no crash
 *   - Field containing "token" → warning, field ignored
 *   - Filters: channel, user, message, thread (regexp strings)
 *   - saveConfig() writes to .claude/.channels.json → slack key
 *   - saveConfig() merges with existing slack config
 *   - saveConfig() creates .claude/ directory if absent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Setup: isolated cwd per test ───────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `req-008-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(testDir);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function writeChannelsJson(content: unknown | string): void {
  const claudeDir = join(testDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const raw = typeof content === 'string' ? content : JSON.stringify(content);
  writeFileSync(join(claudeDir, '.channels.json'), raw, 'utf8');
}

function readChannelsJson(): unknown {
  const filePath = join(testDir, '.claude', '.channels.json');
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// ─── Import under test ──────────────────────────────────────────────────────

const { loadConfig, saveConfig } = await import('../config.js');

// ─── loadConfig() — happy path ───────────────────────────────────────────────

describe('loadConfig() — happy path', () => {
  it('LoadConfig_FileWithChannels_ReturnsChannels', () => {
    // Arrange
    writeChannelsJson({ slack: { channels: ['C123ABC'] } });
    delete process.env['SLACK_CHANNELS'];

    // Act
    const config = loadConfig();

    // Assert
    expect(config.channels).toEqual(['C123ABC']);
  });

  it('LoadConfig_FullSchema_ReturnsAllFields', () => {
    // Arrange
    writeChannelsJson({
      slack: {
        bot: { label: 'mi-bot' },
        channels: ['C123ABC'],
        dms: ['U789GHI'],
        threads: ['T000001'],
        filters: {
          channel: '^dev-',
          user: 'julian|admin',
          message: 'deploy|release',
          thread: '.*',
        },
      },
    });

    // Act
    const config = loadConfig();

    // Assert
    expect(config.bot).toEqual({ label: 'mi-bot' });
    expect(config.channels).toEqual(['C123ABC']);
    expect(config.dms).toEqual(['U789GHI']);
    expect(config.threads).toEqual(['T000001']);
    expect(config.filters?.channel).toBe('^dev-');
    expect(config.filters?.user).toBe('julian|admin');
    expect(config.filters?.message).toBe('deploy|release');
    expect(config.filters?.thread).toBe('.*');
  });

  it('LoadConfig_UnknownFields_DoesNotThrow', () => {
    // Arrange
    writeChannelsJson({ slack: { channels: ['C123ABC'], unknownField: 'ignored' } });

    // Act / Assert
    expect(() => loadConfig()).not.toThrow();
  });

  it('LoadConfig_FiltersOnlyPartial_ReturnsDefinedFilters', () => {
    // Arrange
    writeChannelsJson({ slack: { filters: { channel: '^eng-' } } });

    // Act
    const config = loadConfig();

    // Assert
    expect(config.filters?.channel).toBe('^eng-');
    expect(config.filters?.user).toBeUndefined();
    expect(config.filters?.message).toBeUndefined();
    expect(config.filters?.thread).toBeUndefined();
  });
});

// ─── loadConfig() — archivo ausente ─────────────────────────────────────────

describe('loadConfig() — archivo ausente', () => {
  it('LoadConfig_FileAbsent_ReturnsEmptyConfig', () => {
    // Arrange — testDir exists but has no .claude/.channels.json

    // Act
    const config = loadConfig();

    // Assert
    expect(config.channels ?? []).toEqual([]);
    expect(config.dms ?? []).toEqual([]);
    expect(config.threads ?? []).toEqual([]);
    expect(config.bot).toBeUndefined();
    expect(config.filters).toBeUndefined();
  });

  it('LoadConfig_FileAbsent_EmitsNoWarning', () => {
    // Arrange — no file

    // Act
    loadConfig();

    // Assert
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('LoadConfig_FileAbsent_DoesNotThrow', () => {
    // Arrange / Act / Assert
    expect(() => loadConfig()).not.toThrow();
  });
});

// ─── loadConfig() — JSON inválido ───────────────────────────────────────────

describe('loadConfig() — JSON inválido', () => {
  it('LoadConfig_InvalidJson_ReturnsEmptyConfig', () => {
    // Arrange
    writeChannelsJson('{ slack: broken');

    // Act
    const config = loadConfig();

    // Assert
    expect(config.channels ?? []).toEqual([]);
    expect(config.dms ?? []).toEqual([]);
    expect(config.threads ?? []).toEqual([]);
  });

  it('LoadConfig_InvalidJson_WarningMentionsChannelsJson', () => {
    // Arrange
    writeChannelsJson('{ slack: broken');

    // Act
    loadConfig();

    // Assert
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const warningOutput = stderrCalls.map((args: unknown[]) => String(args[0])).join('');
    expect(warningOutput).toMatch(/\.channels\.json/i);
  });

  it('LoadConfig_InvalidJson_WarningMentionsInvalidOrParse', () => {
    // Arrange
    writeChannelsJson('not json at all !!!');

    // Act
    loadConfig();

    // Assert
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const warningOutput = stderrCalls.map((args: unknown[]) => String(args[0])).join('');
    expect(warningOutput).toMatch(/invalid|parse|syntax/i);
  });

  it('LoadConfig_InvalidJson_DoesNotCallProcessExit', () => {
    // Arrange
    writeChannelsJson('INVALID');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // Act / Assert
    expect(() => loadConfig()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ─── loadConfig() — campo con "token" ────────────────────────────────────────

describe("loadConfig() — campo con 'token' en el nombre", () => {
  it('LoadConfig_TokenFieldPresent_WarnsAboutToken', () => {
    // Arrange
    writeChannelsJson({ slack: { channels: ['C123ABC'], token: 'xoxb-secret' } });

    // Act
    loadConfig();

    // Assert
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const warningOutput = stderrCalls.map((args: unknown[]) => String(args[0])).join('');
    expect(warningOutput).toMatch(/token/i);
  });

  it('LoadConfig_TokenFieldPresent_TokenNotInReturnedConfig', () => {
    // Arrange
    writeChannelsJson({ slack: { channels: ['C123ABC'], token: 'xoxb-secret' } });

    // Act
    const config = loadConfig();

    // Assert
    expect((config as Record<string, unknown>)['token']).toBeUndefined();
  });

  it('LoadConfig_BotTokenFieldPresent_WarnsAboutToken', () => {
    // Arrange
    writeChannelsJson({ slack: { channels: ['C456DEF'], bot_token: 'xoxb-bot-secret' } });

    // Act
    loadConfig();

    // Assert
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const warningOutput = stderrCalls.map((args: unknown[]) => String(args[0])).join('');
    expect(warningOutput).toMatch(/token/i);
  });

  it('LoadConfig_BotTokenFieldPresent_BotTokenNotInReturnedConfig', () => {
    // Arrange
    writeChannelsJson({ slack: { channels: ['C456DEF'], bot_token: 'xoxb-bot-secret' } });

    // Act
    const config = loadConfig();

    // Assert
    expect((config as Record<string, unknown>)['bot_token']).toBeUndefined();
  });

  it('LoadConfig_TokenFieldPresent_SafeFieldsPreserved', () => {
    // Arrange
    writeChannelsJson({ slack: { channels: ['C123ABC'], dms: ['U789GHI'], token: 'xoxb-secret' } });

    // Act
    const config = loadConfig();

    // Assert
    expect(config.channels).toEqual(['C123ABC']);
    expect(config.dms).toEqual(['U789GHI']);
  });
});

// ─── saveConfig() — escritura ────────────────────────────────────────────────

describe('saveConfig() — escritura en .claude/.channels.json', () => {
  it('SaveConfig_NewFile_CreatesClaudeDirectoryAndFile', () => {
    // Arrange — no .claude/ dir exists
    const config = { channels: ['C123ABC'] };

    // Act
    saveConfig(config);

    // Assert
    expect(existsSync(join(testDir, '.claude', '.channels.json'))).toBe(true);
  });

  it('SaveConfig_WithChannels_WritesSlackKeyWithChannels', () => {
    // Arrange
    const config = { channels: ['C123ABC'], dms: ['U789GHI'] };

    // Act
    saveConfig(config);

    // Assert
    const written = readChannelsJson() as { slack: { channels: string[]; dms: string[] } };
    expect(written.slack.channels).toEqual(['C123ABC']);
    expect(written.slack.dms).toEqual(['U789GHI']);
  });

  it('SaveConfig_WithFilters_WritesFiltersUnderSlackKey', () => {
    // Arrange
    const config = {
      channels: ['C123ABC'],
      filters: { channel: '^dev-', user: 'julian' },
    };

    // Act
    saveConfig(config);

    // Assert
    const written = readChannelsJson() as {
      slack: { filters: { channel: string; user: string } };
    };
    expect(written.slack.filters.channel).toBe('^dev-');
    expect(written.slack.filters.user).toBe('julian');
  });

  it('SaveConfig_ExistingFile_MergesWithExistingSlackConfig', () => {
    // Arrange — existing file has label set
    writeChannelsJson({ slack: { bot: { label: 'mi-bot' }, channels: ['C_OLD'] } });
    const newConfig = { channels: ['C_NEW'] };

    // Act
    saveConfig(newConfig);

    // Assert — bot.label preserved, channels updated
    const written = readChannelsJson() as {
      slack: { bot: { label: string }; channels: string[] };
    };
    expect(written.slack.bot.label).toBe('mi-bot');
    expect(written.slack.channels).toEqual(['C_NEW']);
  });

  it('SaveConfig_ExistingFileWithOtherTopLevelKeys_PreservesOtherKeys', () => {
    // Arrange — existing file has a non-slack top-level key
    writeChannelsJson({ slack: { channels: ['C_OLD'] }, other: { foo: 'bar' } });
    const newConfig = { channels: ['C_NEW'] };

    // Act
    saveConfig(newConfig);

    // Assert — other top-level keys preserved
    const written = readChannelsJson() as { other: { foo: string } };
    expect(written.other.foo).toBe('bar');
  });

  it('SaveConfig_DoesNotThrow', () => {
    // Arrange / Act / Assert
    expect(() => saveConfig({ channels: ['C123ABC'] })).not.toThrow();
  });

  it('SaveConfig_EmptyConfig_WritesEmptySlackObject', () => {
    // Arrange
    const config = {};

    // Act
    saveConfig(config);

    // Assert
    const written = readChannelsJson() as { slack: Record<string, unknown> };
    expect(written.slack).toBeDefined();
  });
});
