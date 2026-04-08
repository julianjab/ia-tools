/**
 * In-memory store for incoming Slack messages.
 * Claude polls this via the `poll_slack` tool.
 * Messages are dequeued once read (at-most-once delivery).
 */

export interface SlackMessage {
  id: string;
  channel: string;
  channelName?: string;
  user: string;
  userName?: string;
  text: string;
  threadTs?: string;
  ts: string;
  receivedAt: string;
}

export class MessageStore {
  private queue: SlackMessage[] = [];
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  push(msg: SlackMessage): void {
    if (this.queue.length >= this.maxSize) {
      // Drop oldest to prevent unbounded growth
      this.queue.shift();
    }
    this.queue.push(msg);
  }

  /** Drain all pending messages (FIFO). Returns empty array if none. */
  drain(): SlackMessage[] {
    const messages = [...this.queue];
    this.queue = [];
    return messages;
  }

  /** Peek without draining */
  peek(): SlackMessage[] {
    return [...this.queue];
  }

  get length(): number {
    return this.queue.length;
  }
}
