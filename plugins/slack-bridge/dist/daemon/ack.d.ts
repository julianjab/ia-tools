/**
 * Best-effort thinking acknowledgement helpers for the daemon.
 *
 * Both calls are fire-and-forget; rejections are swallowed so a
 * Slack API error never blocks message routing.
 */
import type { App } from '@slack/bolt';
import type { SlackMessage } from '../shared/types.js';
export interface AckOptions {
    emoji?: string;
    status?: string;
}
/**
 * Adds a reaction emoji and sets the assistant thread status to signal
 * that Claude is working on the message. Both Slack API calls are
 * best-effort — failures are logged and swallowed.
 */
export declare function addThinkingAck(app: App, msg: SlackMessage, opts?: AckOptions): Promise<void>;
//# sourceMappingURL=ack.d.ts.map