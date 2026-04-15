/**
 * WebhookServer — receives forwarded Slack messages from the daemon.
 *
 * Binds to a random port (0) on start. Handles:
 *   GET  /health  → 200 {"status":"ok"}
 *   POST /message → parse MessagePayload, invoke onMessage callback
 *   *             → 404
 */
import type { MessagePayload } from './shared/types.js';
export declare class WebhookServer {
    private readonly onMessage;
    private port_;
    private server_;
    constructor(onMessage: (payload: MessagePayload) => Promise<void>);
    get port(): number | undefined;
    start(): Promise<number>;
    stop(): Promise<void>;
    private handleRequest;
}
//# sourceMappingURL=webhook-server.d.ts.map