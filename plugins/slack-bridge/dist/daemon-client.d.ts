/**
 * DaemonClient — HTTP client for the slack-bridge daemon.
 *
 * Encapsulates all communication with the daemon:
 *   subscribe()     → POST /subscribe
 *   unsubscribe()   → DELETE /subscribe/:port
 *   claim()         → POST /claim/:messageTs
 */
import type { SlackFilters } from './config.js';
import type { ClaimResponse, SubscriptionFilters } from './shared/types.js';
export declare class DaemonClient {
    private readonly daemonUrl;
    private readonly webhookPort;
    constructor(daemonUrl: string | undefined, webhookPort: number);
    get port(): number;
    subscribe(filters: SubscriptionFilters, regexp?: SlackFilters, label?: string): Promise<boolean>;
    unsubscribe(): Promise<boolean>;
    claim(messageTs: string): Promise<ClaimResponse>;
}
//# sourceMappingURL=daemon-client.d.ts.map