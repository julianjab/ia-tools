/**
 * Best-effort thinking acknowledgement helpers for the daemon.
 *
 * Both calls are fire-and-forget; rejections are swallowed so a
 * Slack API error never blocks message routing.
 */
import { warn } from './logger.js';
/**
 * Adds a reaction emoji and sets the assistant thread status to signal
 * that Claude is working on the message. Both Slack API calls are
 * best-effort — failures are logged and swallowed.
 */
export async function addThinkingAck(app, msg, opts) {
    const emoji = opts?.emoji ?? 'eyes';
    const status = opts?.status ?? 'thinking...';
    // Fire both calls concurrently; catch each one independently so the
    // second always executes even if the first rejects.
    await Promise.allSettled([
        app.client.reactions
            .add({
            name: emoji,
            channel: msg.channel_id,
            timestamp: msg.message_ts,
        })
            .catch((err) => warn(`[ack] reactions.add failed: ${err}`)),
        (async () => {
            const threadTs = msg.thread_ts ?? msg.message_ts;
            try {
                // @slack/web-api exposes assistant.threads.setStatus on the typed client
                // in recent versions; fall back to apiCall for older typings.
                const client = app.client;
                if (client.assistant?.threads?.setStatus) {
                    await client.assistant.threads.setStatus({
                        channel_id: msg.channel_id,
                        thread_ts: threadTs,
                        status,
                    });
                }
                else {
                    await client.apiCall('assistant.threads.setStatus', {
                        channel_id: msg.channel_id,
                        thread_ts: threadTs,
                        status,
                    });
                }
            }
            catch (err) {
                warn(`[ack] assistant.threads.setStatus failed: ${err}`);
            }
        })(),
    ]);
}
//# sourceMappingURL=ack.js.map