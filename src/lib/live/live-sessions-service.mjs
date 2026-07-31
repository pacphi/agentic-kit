import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, codexDir } from '../paths.mjs';
import { readCodexState as defaultReadCodexState } from '../codex-state.mjs';
import { adaptClaudeRecord } from './claude-adapter.mjs';
import { adaptCodexLedger, adaptCodexRecord } from './codex-adapter.mjs';
import { JsonlTailer } from './jsonl-tailer.mjs';
import {
  emptyLiveProjection, reduceLiveEvent, serializeLiveProjection, sweepLiveProjection,
} from './projection.mjs';
import { LiveReplayStream } from './replay-stream.mjs';
import { adaptStructuredEvent } from './structured-adapter.mjs';
import { resolveProjectLabel } from './project-label.mjs';

const safeEntries = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
};

function discoverJsonl(root, { maxDepth, maxFiles, accept }) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth || found.length >= 4096) return;
    for (const entry of safeEntries(dir)) {
      if (found.length >= 4096) break;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && accept(entry.name)) {
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* skip ordering evidence */ }
        found.push({ file, mtimeMs });
      }
    }
  };
  visit(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles).map((entry) => entry.file);
}

/** Read only a small prefix and retain only records with safe runtime metadata. */
function bootstrapRecords(file, adapter) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = Math.min(fs.fstatSync(fd).size, 128 * 1024);
      const bytes = Buffer.alloc(size);
      fs.readSync(fd, bytes, 0, size, 0);
      text = bytes.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const records = [];
  for (const line of text.split('\n').slice(0, 256)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (adapter === 'codex' && ['session_meta', 'turn_context'].includes(record?.type)) {
      records.push(record);
    } else if (adapter === 'claude'
      && ['user', 'assistant'].includes(record?.type)
      && (record.sessionId || record.cwd || record.message?.model)) {
      records.push(record);
      if (record.cwd && record.message?.model) break;
    }
  }
  return records;
}

function codexId(file) {
  return path.basename(file, '.jsonl')
    .replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '');
}

/**
 * Coordinates bounded transcript tailers into one privacy-safe live projection.
 * Transcript contents exist only for the duration of adapter calls.
 */
export class LiveSessionsService {
  #options;
  #stream;
  #projection = emptyLiveProjection();
  #tailers = new Map();
  #contexts = new Map();
  #timer = null;
  #started = false;
  #edgeKeys = new Set();
  #health = new Map();

  constructor(options = {}) {
    const roots = options.roots ?? {};
    this.#options = {
      roots: {
        claude: roots.claude ?? path.join(claudeDir(), 'projects'),
        codex: roots.codex ?? path.join(codexDir(), 'sessions'),
      },
      structuredSources: Array.isArray(options.structuredSources) ? options.structuredSources : [],
      intervalMs: options.intervalMs ?? 750,
      maxFiles: options.maxFiles ?? 256,
      replayCapacity: options.replayCapacity ?? 2000,
      readCodexState: options.readCodexState ?? defaultReadCodexState,
      setInterval: options.setInterval ?? globalThis.setInterval,
      clearInterval: options.clearInterval ?? globalThis.clearInterval,
      now: options.now ?? (() => new Date().toISOString()),
      quiescentMs: options.quiescentMs ?? 30_000,
      expiryMs: options.expiryMs ?? 300_000,
      pendingExpiryMs: options.pendingExpiryMs ?? 1_800_000,
      maxSessions: options.maxSessions ?? 100,
      maxNodesPerSession: options.maxNodesPerSession ?? 1000,
    };
    this.#stream = new LiveReplayStream({ capacity: this.#options.replayCapacity });
    for (const name of ['claude', 'codex', 'ruflo', 'aqe', 'codex-state']) {
      this.#health.set(name, { status: 'idle', files: 0, events: 0, errors: 0, lastError: null });
    }
  }

  start() {
    if (this.#started) return this;
    this.#started = true;
    this.#reconcile(true);
    this.#timer = this.#options.setInterval(() => this.#reconcile(false), this.#options.intervalMs);
    this.#timer?.unref?.();
    return this;
  }

  close() {
    if (this.#timer != null) this.#options.clearInterval(this.#timer);
    this.#timer = null;
    for (const tailer of this.#tailers.values()) tailer.close();
    this.#tailers.clear();
    this.#contexts.clear();
    this.#started = false;
  }

  snapshot() {
    return {
      ...serializeLiveProjection(this.#projection),
      health: Object.fromEntries(this.#health),
    };
  }

  replay(cursor = null) {
    return this.#stream.replay(cursor);
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener is required');
    this.#stream.on('event', listener);
    return () => this.#stream.off('event', listener);
  }

  #reconcile(initial) {
    this.#discover(initial);
    for (const [file, tailer] of this.#tailers) {
      try {
        tailer.reconcile();
        const context = this.#contexts.get(file);
        this.#mark(context.adapter, { status: 'ok' });
      } catch (error) {
        this.#error(this.#contexts.get(file)?.adapter ?? 'internal', error);
      }
    }
    this.#ingestLedger();
    this.#projection = sweepLiveProjection(this.#projection, {
      now: this.#options.now(),
      quiescentMs: this.#options.quiescentMs,
      expiryMs: this.#options.expiryMs,
      pendingExpiryMs: this.#options.pendingExpiryMs,
    });
  }

  #discover(initial) {
    // Explicit operator-selected sources have priority over automatic native
    // discovery. Otherwise saturated Claude + Codex stores can consume every
    // tailer slot before a --live-source file is considered.
    for (const source of this.#options.structuredSources.slice(0, this.#options.maxFiles)) {
      if (!source?.file || !['ruflo', 'aqe'].includes(source.surface)) continue;
      this.#add(source.file, {
        adapter: source.surface, surface: source.surface,
        sessionId: source.sessionId,
      }, initial);
    }
    const remaining = Math.max(0, this.#options.maxFiles - this.#tailers.size);
    const claudeLimit = Math.ceil(remaining / 2);
    const codexLimit = remaining - claudeLimit;
    // Depth 3 reaches `<project>/<session>/subagents/agent-*.jsonl`; a session
    // delegating to workers stays observable while its own transcript is idle.
    const claude = discoverJsonl(this.#options.roots.claude, {
      maxDepth: 3, maxFiles: claudeLimit, accept: () => true,
    });
    const codex = discoverJsonl(this.#options.roots.codex, {
      maxDepth: 4, maxFiles: codexLimit, accept: (name) => name.startsWith('rollout-'),
    });
    for (const file of claude) {
      this.#add(file, {
        adapter: 'claude', sessionId: path.basename(file, '.jsonl'),
        project: 'unknown',
      }, initial);
    }
    for (const file of codex) {
      this.#add(file, { adapter: 'codex', sessionId: codexId(file), meta: {} }, initial);
    }
  }

  #add(file, context, initial) {
    if (this.#tailers.has(file) || this.#tailers.size >= this.#options.maxFiles) return;
    if (initial && ['claude', 'codex'].includes(context.adapter)) {
      for (const record of bootstrapRecords(file, context.adapter)) {
        this.#record(record, { ...context, bootstrap: true }, file);
      }
    }
    const onRecord = (record) => this.#record(record, context, file);
    const onError = (error) => this.#error(context.adapter, error);
    const tailer = new JsonlTailer(file, { onRecord, onError, startAtEnd: initial });
    this.#tailers.set(file, tailer);
    this.#contexts.set(file, context);
    this.#mark(context.adapter, { files: (this.#health.get(context.adapter)?.files ?? 0) + 1 });
  }

  #record(record, context, file) {
    const explicitCwd = record?.cwd
      ?? (['session_meta', 'turn_context'].includes(record?.type) ? record.payload?.cwd : null);
    if (explicitCwd) context.project = resolveProjectLabel(explicitCwd);
    const explicitModel = record?.message?.model
      ?? (['session_meta', 'turn_context'].includes(record?.type) ? record.payload?.model : null);
    if (typeof explicitModel === 'string') context.model = explicitModel;
    const common = {
      ...context, artifact: file, observedAt: this.#options.now(),
    };
    let events;
    if (context.adapter === 'claude') {
      events = adaptClaudeRecord(record, common);
    } else if (context.adapter === 'codex') {
      if (record?.type === 'session_meta' && record.payload?.id) {
        context.sessionId = record.payload.id;
        context.meta = record.payload;
      }
      events = adaptCodexRecord(record, common);
    } else {
      events = adaptStructuredEvent(record, {
        ...common, artifact: path.basename(file),
        surface: context.surface, adapter: `${context.surface}-jsonl`,
      });
    }
    for (const event of events) this.#publish(event, context.adapter);
  }

  #publish(event, adapter) {
    const published = this.#stream.publish(event);
    this.#projection = reduceLiveEvent(this.#projection, published, {
      maxSessions: this.#options.maxSessions,
      maxNodesPerSession: this.#options.maxNodesPerSession,
    });
    const current = this.#health.get(adapter);
    this.#mark(adapter, { status: 'ok', events: (current?.events ?? 0) + 1 });
  }

  #ingestLedger() {
    let ledger;
    try { ledger = this.#options.readCodexState(); } catch (error) {
      this.#error('codex-state', error);
      return;
    }
    for (const event of adaptCodexLedger(ledger, { observedAt: this.#options.now() })) {
      const key = `${event.action}|${event.actor.id}|${event.target?.id ?? ''}`;
      if (this.#edgeKeys.has(key)) continue;
      this.#edgeKeys.add(key);
      this.#publish(event, 'codex-state');
    }
    this.#mark('codex-state', { status: ledger ? 'ok' : 'unavailable' });
  }

  #mark(adapter, update) {
    const prior = this.#health.get(adapter) ?? {
      status: 'idle', files: 0, events: 0, errors: 0, lastError: null,
    };
    this.#health.set(adapter, { ...prior, ...update });
  }

  #error(adapter, error) {
    const prior = this.#health.get(adapter);
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code).slice(0, 32) : null;
    this.#mark(adapter, {
      status: 'degraded', errors: (prior?.errors ?? 0) + 1,
      // Error messages from fs commonly contain absolute transcript paths.
      lastError: code ?? (error instanceof SyntaxError ? 'invalid-json' : 'unknown-error'),
    });
  }
}
