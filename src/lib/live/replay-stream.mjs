import { EventEmitter } from 'node:events';

/** Bounded in-process event log used by the SSE layer. */
export class LiveReplayStream extends EventEmitter {
  #capacity;
  #prefix;
  #sequence = 0;
  #events = [];

  constructor({ capacity = 1000, prefix = 'ak' } = {}) {
    super();
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be positive');
    this.#capacity = capacity;
    this.#prefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '') || 'ak';
  }

  publish(event) {
    const ingestSeq = ++this.#sequence;
    const item = { ...event, eventId: `${this.#prefix}:${ingestSeq}`, ingestSeq };
    this.#events.push(item);
    if (this.#events.length > this.#capacity) this.#events.shift();
    this.emit('event', item);
    return item;
  }

  replay(afterId = null) {
    if (afterId == null || afterId === '') {
      return { reset: false, events: [...this.#events] };
    }
    const seq = this.#parseId(afterId);
    if (seq == null) return { reset: true, events: [...this.#events] };
    const oldest = this.#events[0]?.ingestSeq ?? this.#sequence + 1;
    if (seq < oldest - 1 || seq > this.#sequence) {
      return { reset: true, events: [...this.#events] };
    }
    return { reset: false, events: this.#events.filter((event) => event.ingestSeq > seq) };
  }

  snapshot() {
    return { cursor: `${this.#prefix}:${this.#sequence}`, events: [...this.#events] };
  }

  #parseId(id) {
    const match = new RegExp(`^${this.#prefix}:(\\d+)$`).exec(String(id));
    return match ? Number(match[1]) : null;
  }
}
