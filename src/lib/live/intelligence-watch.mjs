// intelligence-watch.mjs — detects when this project's own learning/
// intelligence data actually changes on disk, and reacts by (a) persisting a
// health-history snapshot (via intel-history.mjs's appendHealthSnapshot) and
// (b) handing a fresh combined read to a caller-supplied onUpdate callback,
// so a dashboard SSE route can push near-instant updates instead of waiting
// out its own slower poll loop.
//
// Two independent, complementary change signals feed one debounced pipeline:
//   1. `.claude-flow/data/pending-insights.jsonl` is tailed with JsonlTailer
//      purely as a cheap, low-latency "something just happened" trigger —
//      its line CONTENTS are never read or trusted as data. See
//      jsonl-tailer.mjs's own doc comment for why polling (not fs.watch) is
//      deliberate there; the same reasoning applies here to the direct mtime
//      polling below: fs.watch is only a hint on several filesystems, while
//      stat reconciliation is honest about what actually changed.
//   2. `.claude-flow/neural/stats.json`, `.claude-flow/neural/patterns.json`,
//      and `.claude-flow/data/intelligence-snapshot.json` mtimes are polled
//      directly via fs.statSync, as a fallback AND a primary signal in their
//      own right — not every real change to these files produces a
//      pending-insights line.
// Either signal marks a pending change; the poll loop itself measures the
// quiet gap since the most recent one against `debounceMs` (a trailing-edge
// debounce built entirely from the injected `now`/`setInterval` primitives —
// no extra timer primitive needed) so a burst of edits during an active
// session collapses into a single onUpdate call per debounce window.
//
// Two DIFFERENT metrics ride through here and must not be conflated (see
// intel-history.mjs's own header for the authoritative statement): the
// pattern-STORE history (readNeuralPatternStoreHistory, sourced from
// patterns.json — entries actually present right now) and the
// patternsLearned COUNTER inside globalStats (sourced from stats.json — a
// cumulative lifetime count). They can legitimately diverge; this module
// forwards both, unmodified, and treats neither as a stand-in for the other.
//
// Design note on readers: intel-history.mjs's contract is frozen, but this
// module intentionally never hard-depends on module-load timing — the three
// reader functions are constructor-injectable, defaulting to the real
// intel-history.mjs exports. Production callers get real reads for free;
// tests inject fakes and never touch the filesystem.
import fs from 'node:fs';
import path from 'node:path';
import { projectClaudeFlowDir } from '../paths.mjs';
import { JsonlTailer } from './index.mjs';
import {
  readGlobalStats as defaultReadGlobalStats,
  readIntelHistory as defaultReadIntelHistory,
  appendHealthSnapshot as defaultAppendHealthSnapshot,
} from '../dashboard/intel-history.mjs';

/** Shallow, key-order-independent equality over the flat numeric objects
 *  readGlobalStats returns (or null). Good enough for change detection —
 *  this never needs to compare nested structures. */
function statsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]));
}

/**
 * Watches this project's on-disk learning/intelligence sources for real
 * changes and pushes fresh combined reads through `onUpdate` — debounced,
 * so a burst of writes collapses into one push.
 */
export class IntelligenceWatch {
  #options;
  #cwd;
  #watchedFiles;
  #tailer;
  #timer = null;
  #started = false;
  #mtimes = new Map();
  #tailerDirty = false;
  #pendingChange = false;
  #lastChangeAt = 0;
  #lastGlobalStats;

  /**
   * `onUpdate` is typed optional only so the `options = {}` default below
   * type-checks (TS requires a bare-object default to satisfy every
   * non-optional property); it is still functionally REQUIRED — the
   * constructor throws a TypeError immediately below when it's missing or
   * not a function.
   * @param {{
   *   cwd?: string,
   *   onUpdate?: (combined: { patternStore: unknown[], graph: unknown[]|null,
   *     healthRing: unknown[]|null, globalStats: object|null }) => void,
   *   onError?: (error: unknown) => void,
   *   pendingInsightsFile?: string,
   *   watchedFiles?: string[],
   *   pollIntervalMs?: number,
   *   debounceMs?: number,
   *   setInterval?: typeof globalThis.setInterval,
   *   clearInterval?: typeof globalThis.clearInterval,
   *   now?: () => number,
   *   fsImpl?: Pick<typeof fs, 'statSync'>,
   *   readGlobalStats?: (cwd: string) => object|null,
   *   readIntelHistory?: (cwd: string) => object,
   *   appendHealthSnapshot?: (cwd: string, snapshot: object) => void,
   * }} options
   */
  constructor(options = {}) {
    if (typeof options.onUpdate !== 'function') throw new TypeError('onUpdate is required');
    const cwd = options.cwd ?? process.cwd();
    const claudeFlowDir = projectClaudeFlowDir(cwd);
    this.#cwd = cwd;
    this.#watchedFiles = Array.isArray(options.watchedFiles) ? options.watchedFiles : [
      path.join(claudeFlowDir, 'neural', 'stats.json'),
      path.join(claudeFlowDir, 'neural', 'patterns.json'),
      path.join(claudeFlowDir, 'data', 'intelligence-snapshot.json'),
    ];
    this.#options = {
      onUpdate: options.onUpdate,
      onError: options.onError ?? (() => {}),
      pollIntervalMs: options.pollIntervalMs ?? 1_000,
      debounceMs: options.debounceMs ?? 2_500,
      setInterval: options.setInterval ?? globalThis.setInterval,
      clearInterval: options.clearInterval ?? globalThis.clearInterval,
      now: options.now ?? (() => Date.now()),
      fsImpl: options.fsImpl ?? fs,
      readGlobalStats: options.readGlobalStats ?? defaultReadGlobalStats,
      readIntelHistory: options.readIntelHistory ?? defaultReadIntelHistory,
      appendHealthSnapshot: options.appendHealthSnapshot ?? defaultAppendHealthSnapshot,
    };
    const pendingInsightsFile = options.pendingInsightsFile
      ?? path.join(claudeFlowDir, 'data', 'pending-insights.jsonl');
    // Lines are never inspected — reconcile() firing onRecord at all IS the
    // signal. Started at end so pre-existing history doesn't manufacture a
    // change on the very first poll (the mtime baseline below already covers
    // "first observation" for the three data files themselves).
    this.#tailer = new JsonlTailer(pendingInsightsFile, {
      onRecord: () => { this.#tailerDirty = true; },
      onError: (error) => this.#options.onError(error),
      startAtEnd: true,
    });
  }

  start() {
    if (this.#started) return this;
    this.#started = true;
    this.#poll();
    this.#timer = this.#options.setInterval(() => this.#poll(), this.#options.pollIntervalMs);
    this.#timer?.unref?.();
    return this;
  }

  stop() {
    if (this.#timer != null) this.#options.clearInterval(this.#timer);
    this.#timer = null;
    this.#tailer.close();
    this.#started = false;
    return this;
  }

  #poll() {
    let changed = false;
    for (const file of this.#watchedFiles) {
      let mtimeMs;
      try {
        mtimeMs = this.#options.fsImpl.statSync(file).mtimeMs;
      } catch (error) {
        if (error?.code !== 'ENOENT') this.#options.onError(error);
        mtimeMs = null;
      }
      const seen = this.#mtimes.has(file);
      if (!seen || this.#mtimes.get(file) !== mtimeMs) {
        changed = true;
        this.#mtimes.set(file, mtimeMs);
      }
    }
    try {
      this.#tailer.reconcile();
    } catch (error) {
      this.#options.onError(error);
    }
    if (this.#tailerDirty) {
      changed = true;
      this.#tailerDirty = false;
    }
    const now = this.#options.now();
    if (changed) {
      this.#pendingChange = true;
      this.#lastChangeAt = now;
    }
    if (this.#pendingChange && now - this.#lastChangeAt >= this.#options.debounceMs) {
      this.#pendingChange = false;
      this.#flush();
    }
  }

  #flush() {
    let globalStats = null;
    try {
      globalStats = this.#options.readGlobalStats(this.#cwd);
    } catch (error) {
      this.#options.onError(error);
    }
    if (!statsEqual(globalStats, this.#lastGlobalStats)) {
      this.#lastGlobalStats = globalStats;
      if (globalStats) {
        try {
          this.#options.appendHealthSnapshot(this.#cwd, {
            ts: this.#options.now(),
            ...globalStats,
          });
        } catch (error) {
          this.#options.onError(error);
        }
      }
    }
    let combined = null;
    try {
      combined = this.#options.readIntelHistory(this.#cwd);
    } catch (error) {
      this.#options.onError(error);
    }
    if (combined) {
      try {
        this.#options.onUpdate(combined);
      } catch (error) {
        this.#options.onError(error);
      }
    }
  }
}
