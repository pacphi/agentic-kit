import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const limit = (value, ceiling) => Number.isSafeInteger(value) && value > 0
  ? Math.min(value, ceiling) : ceiling;

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
  #dropping = false;
  #droppedLines = 0;
  #onCoverage;
  #presence = 'unknown';
  #absentSeen = false;

  /**
   * @param {string} file
   * @param {{
   *   onRecord: (record: object) => void,
   *   onError?: (error: unknown, line?: string) => void,
   *   onCoverage?: (coverage: { complete: boolean, truncated: boolean, droppedLines: number, pendingBytes: number, bufferedBytes: number }) => void,
   *   maxChunkBytes?: number,
   *   maxReadBytes?: number,
   *   maxLineBytes?: number,
   *   intervalMs?: number,
   *   startAtEnd?: boolean,
   *   startOffset?: number,
   *   canRead?: (file: string) => boolean
   * }} options
   */
  constructor(file, {
    onRecord, onError = () => {}, intervalMs = 500, startAtEnd = false,
    startOffset, canRead = () => true, onCoverage = () => {},
    maxChunkBytes, maxReadBytes, maxLineBytes,
  }) {
    if (typeof onRecord !== 'function') throw new TypeError('onRecord is required');
    this.#file = file;
    this.#onRecord = onRecord;
    this.#onError = onError;
    this.#onCoverage = onCoverage;
    this.maxChunkBytes = limit(maxChunkBytes, 64 * 1024);
    this.maxReadBytes = limit(maxReadBytes, 1024 * 1024);
    this.maxLineBytes = limit(maxLineBytes, 1024 * 1024);
    this.intervalMs = intervalMs;
    this.startAtEnd = startAtEnd;
    this.startOffset = Number.isSafeInteger(startOffset) && startOffset >= 0 ? startOffset : null;
    this.canRead = typeof canRead === 'function' ? canRead : () => false;
  }

  /**
   * What the last reconciliation observed about the file itself:
   * `unknown` before the first one, then `absent`, `readable` or `unreadable`.
   * Records are a separate matter; a readable file may still hold bad lines.
   */
  get presence() {
    return this.#presence;
  }

  reconcile() {
    if (!this.canRead(this.#file)) return;
    let stat;
    try { stat = fs.statSync(this.#file); } catch (error) {
      if (error.code === 'ENOENT') this.#absent();
      else this.#unreadable(error);
      return;
    }
    if (!stat.isFile()) {
      // Never open a directory, FIFO or device: a FIFO open blocks.
      this.#unreadable(Object.assign(new Error('live source is not a regular file'), {
        code: 'not-regular-file',
      }));
      return;
    }
    const identity = `${stat.dev}:${stat.ino}`;
    if (this.#identity == null) {
      this.#identity = identity;
      // A file that appeared after tailing began holds only new records, so
      // neither a resume offset nor startAtEnd may skip any of it.
      if (this.#absentSeen) this.#offset = 0;
      else if (this.startOffset != null) this.#offset = Math.min(this.startOffset, stat.size);
      else if (this.startAtEnd) this.#offset = stat.size;
    } else if (this.#identity !== identity || stat.size < this.#offset) {
      this.#identity = identity;
      this.#resetPosition();
    }
    if (stat.size <= this.#offset) {
      // Nothing new to read. Prove readability anyway when it is not yet known
      // (or was lost), so a mode-000 file cannot pass as healthy by staying
      // the same size.
      if (this.#presence !== 'readable') this.#probeReadable();
      this.#coverage(stat.size);
      return;
    }
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(this.#file, flags);
      try {
        let remaining = Math.min(stat.size - this.#offset, this.maxReadBytes);
        const bytes = Buffer.alloc(Math.min(remaining, this.maxChunkBytes));
        while (remaining > 0) {
          const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, remaining), this.#offset);
          if (!count) break;
          this.#offset += count;
          remaining -= count;
          this.#consume(this.#decoder.write(bytes.subarray(0, count)));
        }
      } finally { fs.closeSync(fd); }
      this.#presence = 'readable';
    } catch (error) { this.#unreadable(error); }
    this.#coverage(stat.size);
  }

  #resetPosition() {
    this.#offset = 0;
    this.#carry = '';
    this.#dropping = false;
    this.#decoder = new StringDecoder('utf8');
  }

  #absent() {
    // Forget the old file entirely: whatever appears at this path next is a
    // new file, even if the filesystem reuses its inode.
    if (this.#identity != null) {
      this.#identity = null;
      this.#resetPosition();
    }
    this.#absentSeen = true;
    this.#presence = 'absent';
  }

  /** Report an I/O failure once per transition, not once per poll. */
  #unreadable(error) {
    const first = this.#presence !== 'unreadable';
    this.#presence = 'unreadable';
    if (first) this.#onError(error);
  }

  #probeReadable() {
    try {
      fs.accessSync(this.#file, fs.constants.R_OK);
      this.#presence = 'readable';
    } catch (error) { this.#unreadable(error); }
  }

  #consume(text) {
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const complete = i < parts.length - 1;
      if (!this.#dropping) {
        if (Buffer.byteLength(this.#carry) + Buffer.byteLength(parts[i]) > this.maxLineBytes) {
          this.#carry = '';
          this.#dropping = true;
          this.#droppedLines++;
          this.#onError(new RangeError('JSONL line exceeds acquisition byte limit'));
        } else this.#carry += parts[i];
      }
      if (!complete) continue;
      const line = this.#carry;
      this.#carry = '';
      if (!this.#dropping && line.trim()) {
        try { this.#onRecord(JSON.parse(line)); } catch (error) { this.#onError(error, line); }
      }
      this.#dropping = false;
    }
  }

  #coverage(size) {
    const pendingBytes = Math.max(0, size - this.#offset);
    const bufferedBytes = Buffer.byteLength(this.#carry);
    this.#onCoverage({
      complete: this.#droppedLines === 0 && pendingBytes === 0 && bufferedBytes === 0,
      truncated: this.#droppedLines > 0,
      droppedLines: this.#droppedLines, pendingBytes, bufferedBytes,
    });
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
