// codex-rollout-reader.mjs — a bounded-memory, synchronous line reader for
// Codex rollouts too large to hold as one string (ADR-0052).
//
// `fs.readFileSync(file, 'utf8')` throws ERR_STRING_TOO_LONG above ~512 MB, and
// the index swallowed that as "unparsed": the largest rollout on the audited
// machine (4.2 GB, an active user thread with 188M ledger tokens) silently
// vanished from the scorecard. This reads the file in fixed chunks, splits on
// `\n` across chunk boundaries, and hands the SAME parser one parsed envelope at
// a time — memory is one chunk plus one line, never the file. It stays
// synchronous (fs.openSync/readSync) so the scan needs no async refactor.
//
// A single line longer than `maxLineBytes` is never held or parsed. Rollout
// lines that big are tool output or an inlined image; the parser needs only an
// `event_msg`'s identity (its type, and an item's type), and that sits in the
// first bytes of the line. So an oversized `event_msg` is yielded as a CLIPPED
// stub of exactly those facts (`clipped: true`, counted in `stats`), and an
// oversized line of any other kind is dropped and counted. Nothing is clipped
// silently: `stats.clippedLines` reaches the source-health diagnostics.
//
// No I/O beyond reading the one file. Never throws once the file is open: an
// unreadable file surfaces from openCodexRollout / iteration as a plain error
// the caller classifies.
import fs from 'node:fs';

/** Bytes of the file's head kept for session-origin detection — the same bound
 *  usageSessionOrigin applies to a string. */
export const ROLLOUT_HEAD_BYTES = 256 * 1024;
/** Chunk size for the streaming read. Large enough to amortise syscalls, small
 *  enough that it is noise next to a line. */
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
/** Longest line parsed whole. The largest real line measured on the audited
 *  corpus (7.9 GB, 1,498 rollouts) is 1.5 MB; 16 MiB is an order of magnitude
 *  of headroom and still bounds one line's memory. */
export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
/** How much of an oversized line is kept to identify it. */
const CLIP_HEAD_BYTES = 4096;

const NEWLINE = 10;
const OPEN_BRACE = 123;

/** The identity of an oversized `event_msg` line, read from its head, or `null`
 *  when the line is not an event_msg (or its head is not the expected envelope)
 *  and so carries nothing the parser needs. Envelope order on the wire is
 *  timestamp, ordinal, type, payload, which is what the anchored pattern reads. */
function clippedStub(head) {
  const m = /^\{(?:"timestamp":"([^"]*)",)?(?:"ordinal":(\d+),)?"type":"event_msg","payload":\{"type":"([A-Za-z_]+)"/.exec(head);
  if (!m) return null;
  const [, timestamp, ordinal, payloadType] = m;
  const payload = { type: payloadType };
  const item = /"item":\{"type":"([A-Za-z]+)"/.exec(head);
  if (item) payload.item = { type: item[1] };
  return {
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(ordinal !== undefined ? { ordinal: Number(ordinal) } : {}),
    type: 'event_msg', payload, clipped: true,
  };
}

/** Parse one whole line, or `null` for anything that is not a JSON object. */
function parseLine(buf) {
  if (!buf.length || buf[0] !== OPEN_BRACE) return null;
  try {
    const obj = JSON.parse(buf.toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

/**
 * One pass over the file as parsed envelopes. A generator, so an early `break`
 * in the consumer closes the descriptor.
 *
 * Only the bytes that existed when the pass opened the file are read: an active
 * rollout being appended to cannot make a pass run forever, and a torn final
 * line is skipped like any malformed line.
 */
function* passOver(file, { chunkBytes, maxLineBytes, stats }) {
  stats.clippedLines = 0;
  const fd = fs.openSync(file, 'r');
  try {
    const limit = fs.fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(Math.max(1, chunkBytes));
    let pos = 0;
    let parts = [];      // segments of the line being assembled
    let partsLen = 0;
    let oversize = false; // this line already passed maxLineBytes
    let head = null;      // its first CLIP_HEAD_BYTES, kept to identify it

    const take = (segment) => {
      if (oversize) return;
      if (partsLen + segment.length <= maxLineBytes) {
        parts.push(segment); partsLen += segment.length;
        return;
      }
      oversize = true;
      const joined = Buffer.concat([...parts, segment.subarray(0, CLIP_HEAD_BYTES)]);
      head = joined.subarray(0, CLIP_HEAD_BYTES).toString('utf8');
      parts = []; partsLen = 0;
    };
    const finish = () => {
      let out = null;
      if (oversize) {
        stats.clippedLines++;
        out = clippedStub(head);
      } else if (partsLen) {
        out = parseLine(parts.length === 1 ? parts[0] : Buffer.concat(parts, partsLen));
      }
      parts = []; partsLen = 0; oversize = false; head = null;
      return out;
    };

    while (pos < limit) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, limit - pos), pos);
      if (n <= 0) break;
      pos += n;
      const view = chunk.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = view.indexOf(NEWLINE, start);
        if (nl < 0) break;
        let obj;
        if (partsLen === 0 && !oversize && nl - start <= maxLineBytes) {
          obj = parseLine(view.subarray(start, nl)); // whole line inside this chunk: no copy
        } else {
          take(Buffer.from(view.subarray(start, nl))); // `chunk` is reused, so keep a copy
          obj = finish();
        }
        if (obj) yield obj;
        start = nl + 1;
      }
      if (start < n) take(Buffer.from(view.subarray(start, n)));
    }
    const last = finish(); // a final line with no trailing newline
    if (last) yield last;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Open a rollout for parsing. Returns a source `parseCodex` accepts in place of
 * a string: `head` (the first 256 KiB, for session-origin detection), `lines`
 * (re-iterable — each iteration re-reads the file, which the subagent replay
 * pre-pass needs) and `stats` (`clippedLines` of the LAST pass).
 *
 * Throws (ENOENT, EACCES, …) when the file cannot be opened or its head read;
 * the caller decides how to report that.
 *
 * @param {string} file
 * @param {{ chunkBytes?: number, maxLineBytes?: number }} [limits]
 */
export function openCodexRollout(file, limits = {}) {
  const chunkBytes = limits.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const maxLineBytes = limits.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const stats = { clippedLines: 0 };
  const fd = fs.openSync(file, 'r');
  let head;
  try {
    const buf = Buffer.allocUnsafe(ROLLOUT_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  return {
    head,
    stats,
    lines: { [Symbol.iterator]: () => passOver(file, { chunkBytes, maxLineBytes, stats }) },
  };
}
