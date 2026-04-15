/**
 * MCP-side helper to clear the thinking acknowledgement after a reply is sent.
 *
 * Both calls are best-effort — rejections are swallowed so a Slack API error
 * never surfaces to the caller.
 *
 * The emoji to remove is read from SLACK_ACK_EMOJI at call time so that
 * the env var can be changed without restarting the process.
 */
function warn(msg) {
    process.stderr.write(`${msg}\n`);
}
/**
 * Remove the reaction emoji and clear the assistant thread status, signalling
 * that the reply has been delivered.
 */
export async function clearThinkingAck(web, args) {
    const emoji = process.env.SLACK_ACK_EMOJI ?? 'eyes';
    const threadTs = args.thread_ts ?? args.message_ts;
    await Promise.allSettled([
        web.reactions
            .remove({
            name: emoji,
            channel: args.channel_id,
            timestamp: args.message_ts,
        })
            .catch((err) => warn(`[ack-client] reactions.remove failed: ${err}`)),
        (async () => {
            try {
                const client = web;
                if (client.assistant?.threads?.setStatus) {
                    await client.assistant.threads.setStatus({
                        channel_id: args.channel_id,
                        thread_ts: threadTs,
                        status: '',
                    });
                }
                else {
                    await client.apiCall('assistant.threads.setStatus', {
                        channel_id: args.channel_id,
                        thread_ts: threadTs,
                        status: '',
                    });
                }
            }
            catch (err) {
                warn(`[ack-client] assistant.threads.setStatus failed: ${err}`);
            }
        })(),
    ]);
}
//# sourceMappingURL=ack-client.js.map