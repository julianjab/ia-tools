/**
 * DaemonClient — HTTP client for the slack-bridge daemon.
 *
 * Encapsulates all communication with the daemon:
 *   subscribe()     → POST /subscribe
 *   unsubscribe()   → DELETE /subscribe/:port
 *   claim()         → POST /claim/:messageTs
 */
import { debuglog } from 'node:util';
const debug = debuglog('slack-bridge:mcp');
export class DaemonClient {
    daemonUrl;
    webhookPort;
    constructor(daemonUrl, webhookPort) {
        this.daemonUrl = daemonUrl;
        this.webhookPort = webhookPort;
    }
    get port() {
        return this.webhookPort;
    }
    async subscribe(filters, regexp, label) {
        if (!this.daemonUrl) {
            throw new Error('DAEMON_URL is not set — cannot subscribe');
        }
        const body = {
            port: this.webhookPort,
            filters,
        };
        if (regexp !== undefined)
            body.regexp = regexp;
        if (label !== undefined)
            body.label = label;
        debug('subscribe port=%d filters=%j', this.webhookPort, filters);
        const res = await fetch(`${this.daemonUrl}/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`subscribe failed — daemon returned ${res.status}: ${await res.text()}`);
        }
        debug('subscribe ok');
        return true;
    }
    async unsubscribe() {
        if (!this.daemonUrl)
            return false;
        debug('unsubscribe port=%d', this.webhookPort);
        const res = await fetch(`${this.daemonUrl}/subscribe/${this.webhookPort}`, {
            method: 'DELETE',
        });
        debug('unsubscribe status=%d', res.status);
        return res.ok;
    }
    async claim(messageTs) {
        if (!this.daemonUrl)
            throw new Error('DAEMON_URL is not set — cannot claim messages');
        debug('claim ts=%s port=%d', messageTs, this.webhookPort);
        const res = await fetch(`${this.daemonUrl}/claim/${messageTs}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriber_port: this.webhookPort }),
        });
        const result = (await res.json());
        debug('claim result=%j', result);
        return result;
    }
}
//# sourceMappingURL=daemon-client.js.map