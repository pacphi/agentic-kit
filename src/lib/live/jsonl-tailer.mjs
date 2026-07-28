import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/**
 * Append-aware JSONL reader. Polling is deliberate: fs.watch is only a hint on
 * several supported filesystems, while stat reconciliation catches missed
 * notifications, replacement, truncation and late partial-line completion.
 */
export class JsonlTailer {
  #file;
  #onRecord;
  #onError;
  #offset = 0;
  #carry = '';
  #decoder = new StringDecoder('utf8');
  #identity = null;
  #timer = null;

  /**
   * @param {string} file
   * @param {{
   *   onRecord: (record: object) => void,
   *   onError?: (error: unknown, line?: string) => void,
   *   intervalMs?: number,
   *   startAtEnd?: boolean,
   *   startOffset?: number,
   *   canRead?: (file: string) => boolean
   * }} options
   */
  constructor(file, {
    onRecord, onError = () => {}, intervalMs = 500, startAtEnd = false,
    startOffset, canRead = () => true,
  }) {
    if (typeof onRecord !== 'function') throw new TypeError('onRecord is required');
    this.#file = file;
    this.#onRecord = onRecord;
    this.#onError = onError;
    this.intervalMs = intervalMs;
    this.startAtEnd = startAtEnd;
    this.startOffset = Number.isSafeInteger(startOffset) && startOffset >= 0 ? startOffset : null;
    this.canRead = typeof canRead === 'function' ? canRead : () => false;
  }

  reconcile() {
    if (!this.canRead(this.#file)) return;
    let stat;
    try { stat = fs.statSync(this.#file); } catch (error) {
      if (error.code !== 'ENOENT') this.#onError(error);
      return;
    }
    const identity = `${stat.dev}:${stat.ino}`;
    if (this.#identity == null) {
      this.#identity = identity;
      if (this.startOffset != null) this.#offset = Math.min(this.startOffset, stat.size);
      else if (this.startAtEnd) this.#offset = stat.size;
    } else if (this.#identity !== identity || stat.size < this.#offset) {
      this.#identity = identity;
      this.#offset = 0;
      this.#carry = '';
      this.#decoder = new StringDecoder('utf8');
    }
    if (stat.size <= this.#offset) return;
    let bytes;
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(this.#file, flags);
      try {
        bytes = Buffer.alloc(stat.size - this.#offset);
        fs.readSync(fd, bytes, 0, bytes.length, this.#offset);
      } finally { fs.closeSync(fd); }
    } catch (error) {
      this.#onError(error);
      return;
    }
    this.#offset += bytes.length;
    const parts = (this.#carry + this.#decoder.write(bytes)).split('\n');
    this.#carry = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      try { this.#onRecord(JSON.parse(line)); } catch (error) { this.#onError(error, line); }
    }
  }

  start() {
    if (this.#timer) return this;
    this.reconcile();
    this.#timer = setInterval(() => this.reconcile(), this.intervalMs);
    this.#timer.unref?.();
    return this;
  }

  close() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
