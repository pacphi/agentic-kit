import fs from 'node:fs';
import path from 'node:path';
import { JsonlTailer } from './jsonl-tailer.mjs';
import { LiveReplayStream } from './replay-stream.mjs';
import {
  adaptClaudeTranscriptRecord, adaptCodexTranscriptRecord,
} from './transcript-adapter.mjs';
import { canonicalSessionKey } from './project-label.mjs';

const HOSTS = new Set(['claude', 'codex']);
const VALID_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SCAN_FILES = 4096;

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function codexId(file) {
  return path.basename(file, '.jsonl')
    .replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '');
}

function locate(root, host, id) {
  const found = [];
  const maxDepth = host === 'claude' ? 2 : 4;
  let visited = 0;
  const visit = (dir, depth) => {
    if (depth > maxDepth || visited >= MAX_SCAN_FILES) return;
    for (const entry of entries(dir)) {
      if (visited++ >= MAX_SCAN_FILES) break;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const matches = host === 'claude'
          ? entry.name === `${id}.jsonl`
          : entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')
            && codexId(entry.name) === id;
        if (matches) found.push(file);
      }
    }
  };
  visit(root, 0);
  if (!found.length) return null;
  return found.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  })[0];
}

function containedRealFile(root, file) {
  let realRoot;
  let realFile;
  try {
    realRoot = fs.realpathSync(root);
    realFile = fs.realpathSync(file);
  } catch {
    return null;
  }
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) return null;
  try { if (!fs.statSync(realFile).isFile()) return null; } catch { return null; }
  return realFile;
}

function tailLines(file, end, maxBytes, maxRecords) {
  const start = Math.max(0, end - maxBytes);
  let bytes;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      bytes = Buffer.alloc(end - start);
      fs.readSync(fd, bytes, 0, bytes.length, start);
    } finally { fs.closeSync(fd); }
  } catch { return { lines: [], tailOffset: end }; }
  let text = bytes.toString('utf8');
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline < 0 ? '' : text.slice(newline + 1);
  }
  const complete = text.endsWith('\n');
  const lines = text.split('\n');
  if (complete) lines.pop();
  else lines.pop();
  const lastNewline = bytes.lastIndexOf(0x0a);
  const tailOffset = complete ? end
    : (lastNewline >= 0 ? start + lastNewline + 1 : start);
  return {
    lines: lines.slice(-maxRecords),
    tailOffset,
    truncated: start > 0 || lines.length > maxRecords,
  };
}

function maskedText(value, mask, maxChars) {
  if (typeof value !== 'string') return null;
  const safe = String(mask(value));
  return safe.length <= maxChars ? { text: safe, truncated: false }
    : { text: `${safe.slice(0, maxChars)}\n…[truncated]`, truncated: true };
}

function publicEvent(candidate, {
  host, sessionId, mask, maxTextChars, now,
}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const content = maskedText(candidate.text, mask, maxTextChars);
  const detail = maskedText(candidate.details, mask, maxTextChars);
  const safe = (value, max = 256) => {
    if (typeof value !== 'string' || !value) return null;
    return String(mask(value)).slice(0, max);
  };
  return {
    schemaVersion: 1,
    sessionKey: canonicalSessionKey(host, sessionId),
    sessionId,
    host,
    at: safe(candidate.at, 64) ?? now(),
    kind: ['message', 'reasoning', 'tool-call', 'tool-result', 'status'].includes(candidate.kind)
      ? candidate.kind : 'status',
    actor: {
      id: safe(candidate.actor?.id) ?? sessionId,
      role: safe(candidate.actor?.role, 32) ?? 'system',
      label: safe(candidate.actor?.label, 96),
      parentId: safe(candidate.actor?.parentId),
    },
    target: candidate.target?.id ? {
      id: safe(candidate.target.id),
      role: safe(candidate.target.role, 32),
      label: safe(candidate.target.label, 96),
    } : null,
    relation: safe(candidate.relation, 32),
    text: content?.text ?? null,
    truncated: content?.truncated ?? false,
    details: detail?.text ?? null,
    detailsTruncated: detail?.truncated ?? false,
    tool: candidate.tool ? {
      callId: safe(candidate.tool.callId),
      name: safe(candidate.tool.name, 96),
      category: safe(candidate.tool.category, 96),
      status: safe(candidate.tool.status, 32),
    } : null,
  };
}

class TranscriptStream {
  #host;
  #sessionId;
  #options;
  #stream;
  #tailer;
  #seen = new Set();
  #lastMessage = null;
  #historyTruncated = false;
  #published = 0;

  constructor(host, sessionId, file, options) {
    this.#host = host;
    this.#sessionId = sessionId;
    this.#options = options;
    const epoch = fs.statSync(file).ino;
    this.#stream = new LiveReplayStream({
      capacity: options.replayCapacity,
      prefix: `tx-${host}-${sessionId}-${epoch}`,
    });
    const offset = fs.statSync(file).size;
    const history = tailLines(file, offset, options.maxHistoryBytes, options.maxHistoryRecords);
    const candidates = [];
    for (const raw of history.lines) {
      try { candidates.push(...this.#adapt(JSON.parse(raw))); } catch { /* malformed line */ }
    }
    this.#historyTruncated = history.truncated
      || candidates.length > options.maxHistoryEntries;
    for (const candidate of candidates.slice(-options.maxHistoryEntries)) this.#publish(candidate);
    this.#tailer = new JsonlTailer(file, {
      startOffset: history.tailOffset, intervalMs: options.intervalMs,
      canRead: () => containedRealFile(options.roots[host], file) === file,
      onRecord: (record) => {
        for (const candidate of this.#adapt(record)) this.#publish(candidate);
      },
      onError: () => {},
    }).start();
  }

  #adapt(record) {
    const context = {
      sessionId: this.#sessionId,
      observedAt: this.#options.now(),
      actorId: record?.agentId ?? record?.session_id ?? this.#sessionId,
      parentActorId: record?.parentSessionId ?? record?.parent_session_id,
    };
    return this.#host === 'claude'
      ? adaptClaudeTranscriptRecord(record, context)
      : adaptCodexTranscriptRecord(record, context);
  }

  #publish(candidate) {
    const key = candidate.key;
    if (key && this.#seen.has(key)) return;
    if (key) {
      this.#seen.add(key);
      while (this.#seen.size > this.#options.replayCapacity * 2) {
        this.#seen.delete(this.#seen.values().next().value);
      }
    }
    const event = publicEvent(candidate, {
      host: this.#host, sessionId: this.#sessionId,
      mask: this.#options.mask, maxTextChars: this.#options.maxTextChars,
      now: this.#options.now,
    });
    if (event) {
      if (event.kind === 'message') {
        const at = Date.parse(event.at);
        const prior = this.#lastMessage;
        const duplicatePair = prior
          && prior.role === event.actor.role
          && prior.text === event.text
          && Number.isFinite(at) && Number.isFinite(prior.at)
          && Math.abs(at - prior.at) <= 2_000;
        this.#lastMessage = { role: event.actor.role, text: event.text, at };
        if (duplicatePair) return;
      } else {
        this.#lastMessage = null;
      }
      this.#published++;
      if (this.#published > this.#options.replayCapacity) this.#historyTruncated = true;
      this.#stream.publish(event);
    }
  }

  snapshot() {
    const snapshot = this.#stream.snapshot();
    return {
      schemaVersion: 1, sessionKey: canonicalSessionKey(this.#host, this.#sessionId),
      cursor: snapshot.cursor, events: snapshot.events,
    };
  }
  replay(cursor) { return this.#stream.replay(cursor); }
  /**
   * Reconstruct retained evidence at an elapsed-time seek point. Source
   * timestamps define chronology and ingest sequence breaks ties, making the
   * same retained history deterministic across repeated seeks.
   */
  playback({ atMs = null } = {}) {
    const snapshot = this.#stream.snapshot();
    const ordered = [...snapshot.events].sort((a, b) => {
      const time = Date.parse(a.at) - Date.parse(b.at);
      return time || (a.ingestSeq - b.ingestSeq);
    });
    const startedMs = ordered.length ? Date.parse(ordered[0].at) : null;
    const endedMs = ordered.length ? Date.parse(ordered.at(-1).at) : null;
    const durationMs = startedMs == null ? 0 : Math.max(0, endedMs - startedMs);
    const requested = atMs == null ? durationMs : Number(atMs);
    if (!Number.isFinite(requested) || requested < 0) {
      throw new RangeError('playback seek must be a non-negative number');
    }
    const seekAt = Math.min(durationMs, requested);
    const timeline = ordered.map((event) => ({
      ...event,
      elapsedMs: startedMs == null ? 0 : Math.max(0, Date.parse(event.at) - startedMs),
    }));
    const items = timeline.filter((event) => event.elapsedMs <= seekAt);
    // The canvas needs causal coordinates, not a second copy of potentially
    // large transcript bodies. Keep execution events lean and leave rich,
    // masked evidence in transcript.items.
    const events = items.map((event) => ({
      schemaVersion: event.schemaVersion,
      eventId: event.eventId,
      ingestSeq: event.ingestSeq,
      sessionKey: event.sessionKey,
      at: event.at,
      elapsedMs: event.elapsedMs,
      kind: event.kind,
      actor: event.actor,
      target: event.target,
      relation: event.relation,
      tool: event.tool,
      truncated: event.truncated || event.detailsTruncated || false,
    }));
    const startAt = startedMs == null ? null : new Date(startedMs).toISOString();
    const endAt = endedMs == null ? null : new Date(endedMs).toISOString();
    return {
      schemaVersion: 1,
      sessionKey: canonicalSessionKey(this.#host, this.#sessionId),
      host: this.#host,
      sessionId: this.#sessionId,
      startAt,
      endAt,
      durationMs,
      truncated: this.#historyTruncated,
      gap: this.#historyTruncated,
      events,
      transcript: { items },
      range: {
        startedAt: startAt,
        endedAt: endAt,
        durationMs,
        eventCount: timeline.length,
        truncated: this.#historyTruncated,
      },
      seek: {
        requestedMs: requested,
        atMs: seekAt,
        eventIndex: items.length - 1,
      },
      live: {
        cursor: snapshot.cursor,
        eventsEndpoint: `/api/live/transcripts/${this.#host}/${this.#sessionId}/events`,
      },
    };
  }
  subscribe(listener) {
    this.#stream.on('event', listener);
    return () => this.#stream.off('event', listener);
  }
  close() { this.#tailer.close(); }
}

/** Registry of bounded, selected-session transcript streams. */
export class TranscriptStreams {
  #options;
  #streams = new Map();

  constructor(options = {}) {
    if (typeof options.mask !== 'function') {
      throw new Error('no secret masker available — refusing transcript streaming');
    }
    this.#options = {
      roots: options.roots ?? {},
      mask: options.mask,
      intervalMs: Math.max(10, Math.min(60_000, Number(options.intervalMs) || 500)),
      maxHistoryBytes: Math.max(1024, Math.min(16 * 1024 * 1024,
        Number(options.maxHistoryBytes) || 4 * 1024 * 1024)),
      maxHistoryRecords: Math.max(1, Math.min(10_000,
        Number(options.maxHistoryRecords) || 1000)),
      maxHistoryEntries: Math.max(1, Math.min(1000,
        Number(options.maxHistoryEntries) || 100)),
      replayCapacity: Math.max(1, Math.min(4096, Number(options.replayCapacity) || 256)),
      maxTextChars: Math.max(256, Math.min(100_000, Number(options.maxTextChars) || 40_000)),
      idleMs: Math.max(10, Math.min(300_000, Number(options.idleMs) || 15_000)),
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  open(host, id) {
    if (!HOSTS.has(host)) throw new Error('invalid transcript host');
    if (typeof id !== 'string' || !VALID_ID.test(id)) throw new Error('invalid session id');
    const key = canonicalSessionKey(host, id);
    const prior = this.#streams.get(key);
    if (prior) {
      if (prior.timer) clearTimeout(prior.timer);
      prior.timer = null;
      prior.references++;
      return prior.stream;
    }
    const root = this.#options.roots[host];
    if (typeof root !== 'string') throw new Error('transcript root unavailable');
    const candidate = locate(root, host, id);
    if (!candidate) throw new Error('transcript not found');
    const real = containedRealFile(root, candidate);
    if (!real) throw new Error('transcript outside transcript root');
    const stream = new TranscriptStream(host, id, real, this.#options);
    this.#streams.set(key, { stream, references: 1, timer: null });
    return stream;
  }

  release(host, id) {
    const key = canonicalSessionKey(host, id);
    const entry = this.#streams.get(key);
    if (!entry) return;
    entry.references = Math.max(0, entry.references - 1);
    if (entry.references || entry.timer) return;
    entry.timer = setTimeout(() => {
      if (entry.references) return;
      entry.stream.close();
      this.#streams.delete(key);
    }, this.#options.idleMs);
    entry.timer.unref?.();
  }

  close() {
    for (const entry of this.#streams.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.stream.close();
    }
    this.#streams.clear();
  }
}
