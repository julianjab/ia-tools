/**
 * MCP-side helper to clear the thinking acknowledgement after a reply is sent.
 *
 * Both calls are best-effort — rejections are swallowed so a Slack API error
 * never surfaces to the caller.
 *
 * The emoji to remove is read from SLACK_ACK_EMOJI at call time so that
 * the env var can be changed without restarting the process.
 */
import type { WebClient } from '@slack/web-api';
export interface ClearAckArgs {
    channel_id: string;
    message_ts: string;
    thread_ts?: string;
}
/**
 * Remove the reaction emoji and clear the assistant thread status, signalling
 * that the reply has been delivered.
 */
export declare function clearThinkingAck(web: WebClient, args: ClearAckArgs): Promise<void>;
//# sourceMappingURL=ack-client.d.ts.map