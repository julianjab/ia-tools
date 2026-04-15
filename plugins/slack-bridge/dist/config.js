/**
 * loadConfig / saveConfig — reads and writes .claude/.channels.json.
 *
 * Schema:
 *   {
 *     "slack": {
 *       "bot":     { "label": string },
 *       "channels": string[],
 *       "dms":      string[],
 *       "threads":  string[],
 *       "filters":  { "channel": regexp-string, "user": regexp-string,
 *                     "message": regexp-string, "thread": regexp-string }
 *     }
 *   }
 *
 * - Any field whose name contains "token" (case-insensitive) is stripped and
 *   triggers a stderr warning so secrets never end up in the config object.
 * - Returns {} when the file is absent; warns + returns {} when JSON is invalid.
 * - saveConfig() merges the provided patch into the existing file's slack key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const ALLOWED_KEYS = [
    'bot',
    'channels',
    'dms',
    'threads',
    'filters',
];
function configFilePath(cwd) {
    return join(cwd, '.claude', '.channels.json');
}
function readRawFile(filePath) {
    if (!existsSync(filePath))
        return null;
    let raw;
    try {
        raw = readFileSync(filePath, 'utf8');
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        process.stderr.write(`[slack-bridge] Warning: .claude/.channels.json contains invalid JSON — ${String(err)}\n`);
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        process.stderr.write('[slack-bridge] Warning: .claude/.channels.json must be a JSON object — ignoring file\n');
        return null;
    }
    return parsed;
}
export function loadConfig(cwd) {
    const dir = cwd ?? process.cwd();
    const filePath = configFilePath(dir);
    const raw = readRawFile(filePath);
    if (raw === null)
        return {};
    const slackSection = raw.slack;
    if (typeof slackSection !== 'object' || slackSection === null || Array.isArray(slackSection)) {
        return {};
    }
    const record = slackSection;
    // Warn and strip any field whose name contains "token"
    const tokenFields = Object.keys(record).filter((key) => key.toLowerCase().includes('token'));
    if (tokenFields.length > 0) {
        process.stderr.write(`[slack-bridge] Warning: .claude/.channels.json contains token field(s): ${tokenFields.join(', ')} — tokens must not be stored in .channels.json. These fields are ignored.\n`);
    }
    // Return only the known safe fields
    const config = {};
    for (const key of ALLOWED_KEYS) {
        if (key in record) {
            // biome-ignore lint/suspicious/noExplicitAny: iterating over known keys
            config[key] = record[key];
        }
    }
    return config;
}
export function saveConfig(patch, cwd) {
    const dir = cwd ?? process.cwd();
    const filePath = configFilePath(dir);
    const claudeDir = join(dir, '.claude');
    // Ensure .claude/ directory exists
    mkdirSync(claudeDir, { recursive: true });
    // Read existing file to preserve other top-level keys and merge slack section
    let existing = {};
    if (existsSync(filePath)) {
        try {
            const raw = readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                existing = parsed;
            }
        }
        catch {
            // Ignore parse errors — start fresh for the slack key
        }
    }
    const existingSlack = typeof existing.slack === 'object' && existing.slack !== null
        ? existing.slack
        : {};
    // Merge patch into existing slack section
    const mergedSlack = { ...existingSlack };
    for (const [key, value] of Object.entries(patch)) {
        if (key.toLowerCase().includes('token'))
            continue; // never persist token fields
        mergedSlack[key] = value;
    }
    const output = { ...existing, slack: mergedSlack };
    writeFileSync(filePath, JSON.stringify(output, null, 2), { encoding: 'utf8', mode: 0o600 });
}
//# sourceMappingURL=config.js.map