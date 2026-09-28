import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events/DomainEvent.js';
import { Inbox } from '../Inbox.js';

describe('Inbox', () => {
  it('hands out each delivered message once, and what nobody read once', () => {
    const inbox = new Inbox();
    const first = createEvent('comment', { n: 1 });
    const late = createEvent('comment', { n: 2 });

    inbox.deliver('uno', first);
    expect(inbox.drain()).toEqual(['uno']);
    expect(inbox.drain()).toEqual([]);

    inbox.deliver('dos', late);
    expect(inbox.takeUnread()).toEqual([late]);
    expect(inbox.takeUnread()).toEqual([]);
  });

  it('remembers what nobody accepted until it is taken', () => {
    const inbox = new Inbox();
    const ci = createEvent('ci', {});
    inbox.miss(ci);
    expect(inbox.takeMissed()).toEqual([ci]);
    expect(inbox.takeMissed()).toEqual([]);
  });
});
