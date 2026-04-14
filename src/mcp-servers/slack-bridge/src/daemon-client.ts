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

export class DaemonClient {
  constructor(
    private readonly daemonUrl: string | undefined,
    private readonly webhookPort: number,
  ) {}

  get port(): number {
    return this.webhookPort;
  }

  async subscribe(filters: SubscriptionFilters, regexp?: SlackFilters, label?: string): Promise<boolean> {
    if (!this.daemonUrl) {
      throw new Error('DAEMON_URL is not set — cannot subscribe');
    }

    const body: Record<string, unknown> = {
      port: this.webhookPort,
      filters,
    };
    if (regexp !== undefined) body.regexp = regexp;
    if (label !== undefined) body.label = label;

    const res = await fetch(`${this.daemonUrl}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`subscribe failed — daemon returned ${res.status}: ${await res.text()}`);
    }

    return true;
  }

  async unsubscribe(): Promise<boolean> {
    if (!this.daemonUrl) return false;

    const res = await fetch(`${this.daemonUrl}/subscribe/${this.webhookPort}`, {
      method: 'DELETE',
    });

    return res.ok;
  }

  async claim(messageTs: string): Promise<ClaimResponse> {
    const res = await fetch(`${this.daemonUrl}/claim/${messageTs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriber_port: this.webhookPort }),
    });

    return (await res.json()) as ClaimResponse;
  }
}
