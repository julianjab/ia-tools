/**
 * Slack Socket Mode listener.
 * Single connection — routes messages to registered subscribers via HTTP.
 */
import pkg from '@slack/bolt';
declare const App: typeof pkg.App;
export interface ListenerConfig {
    botToken: string;
    appToken: string;
}
export interface SlackEvent {
    channel_id: string;
    user_id: string;
    text: string;
    message_ts: string;
    thread_ts?: string;
}
export type MessageHandler = (event: SlackEvent) => Promise<void>;
export declare function startListener(config: ListenerConfig, onMessage: MessageHandler): Promise<InstanceType<typeof App>>;
/** Resolve user ID → display name using Slack API */
export declare function resolveUser(app: InstanceType<typeof App>, userId: string): Promise<string>;
/** Resolve channel ID → channel name using Slack API */
export declare function resolveChannel(app: InstanceType<typeof App>, channelId: string): Promise<string>;
export {};
//# sourceMappingURL=listener.d.ts.map