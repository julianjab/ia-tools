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
export interface SlackFilters {
    channel?: string;
    user?: string;
    message?: string;
    thread?: string;
}
export interface SlackChannelConfig {
    bot?: {
        label?: string;
    };
    channels?: string[];
    dms?: string[];
    threads?: string[];
    filters?: SlackFilters;
}
export interface ChannelsConfig {
    slack?: SlackChannelConfig;
}
export declare function loadConfig(cwd?: string): SlackChannelConfig;
export declare function saveConfig(patch: Partial<SlackChannelConfig>, cwd?: string): void;
//# sourceMappingURL=config.d.ts.map