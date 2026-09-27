import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { claudeDir, codexDir, observabilityWorkspacePath } from '../paths.mjs';
import { readCodexState as defaultReadCodexState } from '../codex-state.mjs';
import { adaptClaudeRecord } from './claude-adapter.mjs';
import { resolveClaudeProvider as defaultResolveClaudeProvider } from './claude-provider.mjs';
import { adaptCodexLedger, adaptCodexRecord } from './codex-adapter.mjs';
import { createLiveEvent } from './event-schema.mjs';
import { JsonlTailer } from './jsonl-tailer.mjs';
import { listActiveHostSessions } from './process-sessions.mjs';
import {
  emptyLiveProjection, reduceLiveEvent, serializeLiveProjection, sweepLiveProjection,
} from './projection.mjs';
import { LiveReplayStream } from './replay-stream.mjs';
import { adaptStructuredEvent, structuredRecordRejection } from './structured-adapter.mjs';
import { canonicalSessionKey, resolveProjectIdentity } from './project-label.mjs';
import { createFolderCorrelator } from './folder-correlator.mjs';
import { workspaceFromSource } from './git-workspace.mjs';
import { WorkspaceSnapshotStore } from './workspace-store.mjs';
import {
  bootstrapRecords, codexTranscriptId, discoverJsonlDetailed,
} from './native-transcript-discovery.mjs';

// historySnapshot() is a one-shot on-demand scan, not a continuously-tailed
// live feed, so it can afford limits well above the live path's maxFiles(256)
// /maxSessions(100) defaults. History pages are sliced only after this scan;
// the live projection's smaller bound must never decide which host's history
// survives. The detailed discovery result makes any safety boundary visible.
const HISTORY_MAX_FILES = 8192;
const HISTORY_MAX_SESSIONS = HISTORY_MAX_FILES * 2;
const HISTORY_DEFAULT_PAGE_SIZE = 100;
const HISTORY_MAX_PAGE_SIZE = 250;
const HISTORY_PAGE_TTL_MS = 60_000;
const HISTORY_PAGE_CACHE_SIZE = 8;

// Adapters fed by file tailers. Their health is recomputed from the tailed
// files after every reconciliation pass instead of being set piecemeal.
const TAILED_ADAPTERS = ['claude', 'codex', 'ruflo', 'aqe'];
const STRUCTURED_ADAPTERS = ['ruflo', 'aqe'];

function initialHealth(name) {
  const base = { status: 'idle', files: 0, events: 0, errors: 0, lastError: null };
  if (!TAILED_ADAPTERS.includes(name)) return base;
  return {
    ...base, readable: 0, missing: 0, unreadable: 0,
    accepted: 0, rejected: 0, lastAcceptedAt: null, lastRejection: null,
  };
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
  #claudeProviders = new Map();
  #runtimeBindings = new Map();
  #lastRuntimeScan = 0;
  #runtimeSurvey = null;
  #workspaceStore = null;
  #historyPages = new Map();
  #discovery = {};
  #observedSince = null;
  // Exact-folder matching for sessions outside a Git repository. All three
  // stay in memory only: nothing here is published, persisted, or logged.
  #folderOf = createFolderCorrelator();
  #sourceCwds = new WeakMap(); // context → { cwd, canonical, folder }
  #sessionFolders = new Map(); // sessionKey → correlator of its non-Git folder

  constructor(options = {}) {
    const roots = options.roots ?? {};
    this.#options = {
      roots: {
        claude: roots.claude ?? path.join(claudeDir(), 'projects'),
        codex: roots.codex ?? path.join(codexDir(), 'sessions'),
      },
      structuredSources: Array.isArray(options.structuredSources) ? options.structuredSources : [],
      structuredProject: resolveProjectIdentity(options.cwd ?? process.cwd()),
      intervalMs: options.intervalMs ?? 750,
      maxFiles: options.maxFiles ?? 256,
      replayCapacity: options.replayCapacity ?? 2000,
      readCodexState: options.readCodexState ?? defaultReadCodexState,
      readActiveSessions: options.readActiveSessions
        ?? (options.roots ? (() => []) : listActiveHostSessions),
      resolveClaudeProvider: options.resolveClaudeProvider ?? defaultResolveClaudeProvider,
      setInterval: options.setInterval ?? globalThis.setInterval,
      clearInterval: options.clearInterval ?? globalThis.clearInterval,
      now: options.now ?? (() => new Date().toISOString()),
      quiescentMs: options.quiescentMs ?? 30_000,
      expiryMs: options.expiryMs ?? 300_000,
      pendingExpiryMs: options.pendingExpiryMs ?? 1_800_000,
      runtimeScanMs: options.runtimeScanMs ?? 2_000,
      runtimeMisses: options.runtimeMisses ?? 3,
      maxSessions: options.maxSessions ?? 100,
      maxNodesPerSession: options.maxNodesPerSession ?? 1000,
    };
    this.#stream = new LiveReplayStream({ capacity: this.#options.replayCapacity });
    if (Object.hasOwn(options, 'workspaceStore')) {
      this.#workspaceStore = options.workspaceStore;
    } else if (options.workspaceFile || !options.roots) {
      this.#workspaceStore = new WorkspaceSnapshotStore(
        options.workspaceFile ?? observabilityWorkspacePath(),
      );
    }
    for (const name of [...TAILED_ADAPTERS, 'codex-state', 'opencode', 'runtime']) {
      this.#health.set(name, initialHealth(name));
    }
  }

  start() {
    if (this.#started) return this;
    this.#started = true;
    // Only the first start bootstraps metadata and follows new appends from
    // the end. A start after an idle stop resumes every retained tailer at its
    // offset, so work appended during the stop is replayed, and a file that
    // appeared meanwhile is read from its first byte like any late file.
    const initial = this.#observedSince == null;
    if (initial) this.#observedSince = this.#options.now();
    this.#restoreWorkspaceHistory();
    this.#reconcile(initial);
    this.#timer = this.#options.setInterval(() => this.#reconcile(false), this.#options.intervalMs);
    this.#timer?.unref?.();
    return this;
  }

  /**
   * Stop following. Tailers keep their byte offsets, partial lines and
   * session contexts so the next start() resumes instead of re-tailing from
   * the end; they hold no descriptor or timer between passes.
   */
  close() {
    if (this.#timer != null) this.#options.clearInterval(this.#timer);
    this.#timer = null;
    for (const tailer of this.#tailers.values()) tailer.close();
    this.#runtimeBindings.clear();
    this.#historyPages.clear();
    this.#started = false;
  }

  snapshot() {
    const acquisitionCoverage = [...this.#contexts.values()].reduce((total, context) => {
      const coverage = context.acquisitionCoverage;
      if (!coverage) return total;
      total.complete &&= coverage.complete;
      total.truncated ||= coverage.truncated;
      total.droppedLines += coverage.droppedLines;
      total.pendingBytes += coverage.pendingBytes;
      return total;
    }, { complete: true, truncated: false, droppedLines: 0, pendingBytes: 0, omittedFiles: 0 });
    // Operations written before observation began are not replayed (only
    // session metadata is bootstrapped), so say when observation began.
    acquisitionCoverage.observedSince = this.#observedSince;
    // Native discovery tails only the newest files per host. When that bound
    // leaves files out, coverage is incomplete and says how many.
    acquisitionCoverage.sources = {};
    for (const [adapter, discovered] of Object.entries(this.#discovery)) {
      acquisitionCoverage.sources[adapter] = { ...discovered };
      if (!discovered.truncated) continue;
      acquisitionCoverage.complete = false;
      acquisitionCoverage.truncated = true;
      acquisitionCoverage.omittedFiles += Math.max(0, discovered.candidateFiles - discovered.returnedFiles);
    }
    return {
      ...serializeLiveProjection(this.#projection),
      health: Object.fromEntries(this.#health),
      acquisitionCoverage,
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
      } catch (error) {
        const context = this.#contexts.get(file);
        if (context) context.fault = true;
        this.#error(context?.adapter ?? 'internal', error);
      }
    }
    this.#refreshSourceHealth();
    this.#ingestLedger();
    this.#scheduleRuntimeSessions();
    this.#projection = sweepLiveProjection(this.#projection, {
      now: this.#options.now(),
      quiescentMs: this.#options.quiescentMs,
      expiryMs: this.#options.expiryMs,
      pendingExpiryMs: this.#options.pendingExpiryMs,
    });
    // Folder correlators follow the bounded projection, not every session seen.
    if (this.#sessionFolders.size > this.#options.maxSessions) {
      for (const key of this.#sessionFolders.keys()) {
        if (!this.#projection.sessions.has(key)) this.#sessionFolders.delete(key);
      }
    }
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
        project: this.#options.structuredProject.label,
        projectKey: this.#options.structuredProject.key,
      }, initial);
    }
    const structuredCount = [...this.#contexts.values()]
      .filter((context) => ['ruflo', 'aqe'].includes(context.adapter)).length;
    const nativeCapacity = Math.max(0, this.#options.maxFiles - structuredCount);
    const claudeLimit = Math.ceil(nativeCapacity / 2);
    const codexLimit = nativeCapacity - claudeLimit;
    // Depth 3 reaches `<project>/<session>/subagents/agent-*.jsonl`; a session
    // delegating to workers stays observable while its own transcript is idle.
    const claudeDiscovery = discoverJsonlDetailed(this.#options.roots.claude, {
      maxDepth: 3, maxFiles: claudeLimit, accept: () => true,
    });
    const codexDiscovery = discoverJsonlDetailed(this.#options.roots.codex, {
      maxDepth: 4, maxFiles: codexLimit, accept: (name) => name.startsWith('rollout-'),
    });
    // Keep what the bound left out, so coverage can say the window is capped
    // instead of implying that no other session exists.
    this.#discovery = {
      claude: liveDiscoveryCoverage(claudeDiscovery, claudeLimit),
      codex: liveDiscoveryCoverage(codexDiscovery, codexLimit),
    };
    const claude = claudeDiscovery.files;
    const codex = codexDiscovery.files;
    // The bounded set is a moving window, not a startup-only choice. Replace
    // native tailers that fell out of the newest-file budget so an active
    // session created after the dashboard started can become observable.
    const desiredNative = new Set([...claude, ...codex]);
    for (const [file, context] of this.#contexts) {
      if (!['claude', 'codex'].includes(context.adapter) || desiredNative.has(file)) continue;
      this.#tailers.get(file)?.close();
      this.#tailers.delete(file);
      this.#contexts.delete(file);
    }
    for (const file of claude) {
      this.#add(file, {
        adapter: 'claude', sessionId: path.basename(file, '.jsonl'),
        project: 'unknown',
      }, initial);
    }
    for (const file of codex) {
      this.#add(file, {
        adapter: 'codex', sessionId: codexTranscriptId(file), meta: {},
      }, initial);
    }
  }

  #add(file, context, initial) {
    if (this.#tailers.has(file) || this.#tailers.size >= this.#options.maxFiles) return;
    if (initial && ['claude', 'codex'].includes(context.adapter)) {
      // One shared bootstrap context so metadata learned early (codex
      // session_meta id/meta, project, model, provider) persists across the
      // replayed records and into live tailing below.
      const bootstrap = { ...context, bootstrap: true };
      for (const record of bootstrapRecords(file, context.adapter)) {
        this.#ingestRecord(record, bootstrap, file);
      }
      Object.assign(context, bootstrap, { bootstrap: false });
      // The working directory was noted on the bootstrap copy; carry it over,
      // since later records (a Codex tool call, say) do not repeat it.
      const source = this.#sourceCwds.get(bootstrap);
      if (source) this.#sourceCwds.set(context, source);
    }
    const onRecord = (record) => this.#ingestRecord(record, context, file);
    const onError = (error) => {
      // An I/O failure is carried by the tailer's presence and clears when the
      // file becomes readable again. A bad record stays a fault until a later
      // record from the same file is accepted.
      if (tailer.presence !== 'unreadable') context.fault = true;
      this.#error(context.adapter, error);
    };
    const tailer = new JsonlTailer(file, {
      onRecord, onError, startAtEnd: initial,
      onCoverage: (coverage) => { context.acquisitionCoverage = coverage; },
    });
    this.#tailers.set(file, tailer);
    this.#contexts.set(file, context);
  }

  /** Pure record → LiveEvent[] transformation, shared by the live tailer
   *  (#record, below) and historySnapshot()'s one-shot scan. Mutates `context`
   *  in place (identity/provider/model learned as records stream by) but
   *  touches no instance state beyond the read-only #claudeProvider cache. */
  #buildEvents(record, context, file) {
    const explicitCwd = record?.cwd
      ?? (['session_meta', 'turn_context'].includes(record?.type) ? record.payload?.cwd : null);
    if (explicitCwd) {
      const identity = resolveProjectIdentity(explicitCwd);
      context.project = identity.label;
      context.projectKey = identity.key;
      this.#noteSourceCwd(context, explicitCwd, identity.canonical);
      context.workspace = workspaceFromSource({
        cwd: explicitCwd,
        branch: record?.gitBranch ?? record?.payload?.git_branch ?? context.workspace?.branchLabel,
        project: identity.label,
        capturedAt: record?.timestamp ?? this.#options.now(),
        source: `${context.adapter}-source`,
      });
    }
    if (context.adapter === 'claude' && explicitCwd && !context.provider) {
      const resolved = this.#claudeProvider(explicitCwd);
      if (resolved?.provider) {
        context.provider = resolved.provider;
        context.providerProvenance = resolved.provenance;
      }
    }
    const explicitModel = record?.message?.model
      ?? (['session_meta', 'turn_context'].includes(record?.type) ? record.payload?.model : null);
    if (typeof explicitModel === 'string') context.model = explicitModel;
    const common = {
      ...context, artifact: file, observedAt: this.#options.now(),
    };
    if (context.adapter === 'claude') return adaptClaudeRecord(record, common);
    if (context.adapter === 'codex') {
      if (record?.type === 'session_meta' && record.payload?.id) {
        context.sessionId = record.payload.id;
        context.meta = record.payload;
      }
      return adaptCodexRecord(record, common);
    }
    return adaptStructuredEvent(record, {
      ...common, artifact: path.basename(file),
      surface: context.surface, adapter: `${context.surface}-jsonl`,
    });
  }

  #record(record, context, file) {
    const events = this.#buildEvents(record, context, file);
    const folder = this.#transcriptFolder(context);
    for (const event of events) {
      this.#publish(event, context.adapter);
      // undefined: this source has named no folder yet, so leave what is known.
      if (folder) this.#sessionFolders.set(event.sessionKey, folder);
      else if (folder === null) this.#sessionFolders.delete(event.sessionKey);
    }
    return events.length;
  }

  /** Remember a source's latest working directory without putting it on the context. */
  #noteSourceCwd(context, cwd, canonical) {
    if (this.#sourceCwds.get(context)?.cwd === cwd) return;
    this.#sourceCwds.set(context, { cwd, canonical, folder: undefined });
  }

  /**
   * The exact-folder correlator of a live transcript in a non-Git folder;
   * null for a Git repository or a folder that no longer exists; undefined
   * while the source has not named a folder. Computed once per working
   * directory, only on the live path (History scans never need it).
   */
  #transcriptFolder(context) {
    const source = this.#sourceCwds.get(context);
    if (!source) return undefined;
    if (source.canonical) return null;
    if (source.folder === undefined) source.folder = this.#folderOf(source.cwd);
    return source.folder;
  }

  /**
   * Publish one parsed record and account for it in source health. A record
   * that yields an event is accepted. A structured (ruflo/AQE) record that
   * yields none is rejected with a fixed reason code, never its content. A
   * native transcript record the adapter does not map is ignored by design.
   */
  #ingestRecord(record, context, file) {
    const published = this.#record(record, context, file);
    const current = this.#health.get(context.adapter) ?? {};
    if (published > 0) {
      context.fault = false;
      this.#mark(context.adapter, {
        accepted: (current.accepted ?? 0) + 1, lastAcceptedAt: this.#options.now(),
      });
    } else if (STRUCTURED_ADAPTERS.includes(context.adapter)) {
      context.fault = true;
      this.#mark(context.adapter, {
        rejected: (current.rejected ?? 0) + 1,
        lastRejection: structuredRecordRejection(record, {
          surface: context.surface, sessionId: context.sessionId,
        }) ?? 'not-an-event',
      });
    } else {
      context.fault = false;
    }
  }

  /**
   * Recompute tailed-adapter health from the files themselves: how many are
   * readable, missing or unreadable, and whether any file's latest record was
   * bad. Precedence: degraded > awaiting-file > no-events > ok. A configured
   * source whose file is absent is awaiting it (late creation is legitimate),
   * never "ok".
   */
  #refreshSourceHealth() {
    const tally = new Map(TAILED_ADAPTERS.map((name) => [name, {
      sources: 0, readable: 0, missing: 0, unreadable: 0, faulted: 0,
    }]));
    for (const [file, context] of this.#contexts) {
      const counts = tally.get(context.adapter);
      if (!counts) continue;
      counts.sources += 1;
      const presence = this.#tailers.get(file)?.presence;
      if (presence === 'readable') counts.readable += 1;
      else if (presence === 'absent') counts.missing += 1;
      else if (presence === 'unreadable') counts.unreadable += 1;
      if (context.fault) counts.faulted += 1;
    }
    for (const [adapter, counts] of tally) {
      const accepted = this.#health.get(adapter)?.accepted ?? 0;
      let status = 'ok';
      if (!counts.sources) status = 'idle';
      else if (counts.unreadable || counts.faulted) status = 'degraded';
      else if (counts.missing) status = 'awaiting-file';
      else if (!accepted) status = 'no-events';
      // `files` is a gauge of the files tailed right now, recounted every
      // pass; incrementing it drifted upward on each idle stop and restart.
      const discovered = this.#discovery[adapter];
      this.#mark(adapter, {
        status, files: counts.sources,
        readable: counts.readable, missing: counts.missing, unreadable: counts.unreadable,
        ...(discovered ? { candidateFiles: discovered.candidateFiles } : {}),
      });
    }
  }

  /**
   * On-demand, date-windowed scan for the Observability "History" browser.
   * Independent of the live tailer: builds and discards its own projection,
   * so it never touches #projection/#workspaceStore/#health and can never
   * evict or otherwise disturb the live in-memory state. Reuses the exact
   * same discovery/bootstrap/adapter pipeline as the live path so a session
   * renders identically whichever scope produced it.
   * @param {{ sinceMs?: number|null }} [options] sinceMs is an epoch-ms
   *   cutoff on file mtime; omit/null scans "all time".
   * @returns {ReturnType<typeof serializeLiveProjection> & {coverage: object}}
   */
  historySnapshot({ sinceMs = null } = {}) {
    return this.#scanHistory({ sinceMs });
  }

  /**
   * Return one stable, project-scoped page from a retained history snapshot.
   * The snapshot is cached briefly so scrolling does not rescan or reorder the
   * same history set between requests. pageToken is intentionally opaque to
   * callers and contains no filesystem identity.
   * @param {{ sinceMs?: number|null, projectKey?: string|null,
   *   limit?: number, pageToken?: string|null }} [options]
   */
  historyPage({ sinceMs = null, projectKey = null, limit = HISTORY_DEFAULT_PAGE_SIZE,
    pageToken = null } = {}) {
    const pageSize = Math.min(HISTORY_MAX_PAGE_SIZE, Math.max(1,
      Number.parseInt(String(limit), 10) || HISTORY_DEFAULT_PAGE_SIZE));
    let entry;
    let offset = 0;
    if (pageToken) {
      const token = decodeHistoryPageToken(pageToken);
      entry = this.#historyPages.get(token.snapshotId);
      if (!entry || Date.now() - entry.createdAt > HISTORY_PAGE_TTL_MS
        || entry.projectKey !== (projectKey ?? null)) {
        throw invalidHistoryPageToken();
      }
      offset = Number.isInteger(token.offset) && token.offset >= 0
        && token.offset <= entry.sessions.length ? token.offset : -1;
      if (offset < 0) throw invalidHistoryPageToken();
    } else {
      const snapshot = this.#scanHistory({ sinceMs });
      const sessions = snapshot.sessions
        .filter((session) => !projectKey || session.projectKey === projectKey)
        .sort(compareHistorySessions);
      entry = { snapshot, sessions, projectKey: projectKey ?? null, sinceMs: sinceMs ?? null,
        snapshotId: randomUUID(), createdAt: Date.now() };
      this.#historyPages.set(entry.snapshotId, entry);
      while (this.#historyPages.size > HISTORY_PAGE_CACHE_SIZE) {
        this.#historyPages.delete(this.#historyPages.keys().next().value);
      }
    }

    const sessions = entry.sessions.slice(offset, offset + pageSize);
    const nextOffset = offset + sessions.length;
    const hasMore = nextOffset < entry.sessions.length;
    return {
      ...entry.snapshot,
      sessions,
      pagination: {
        pageSize, offset, returned: sessions.length,
        total: entry.sessions.length,
        totalExact: entry.snapshot.coverage.complete,
        hasMore,
        nextPageToken: hasMore
          ? encodeHistoryPageToken({ snapshotId: entry.snapshotId, offset: nextOffset }) : null,
      },
    };
  }

  #scanHistory({ sinceMs = null } = {}) {
    const claude = discoverJsonlDetailed(this.#options.roots.claude, {
      maxDepth: 3, maxFiles: HISTORY_MAX_FILES, sinceMs, accept: () => true,
    });
    const codex = discoverJsonlDetailed(this.#options.roots.codex, {
      maxDepth: 4, maxFiles: HISTORY_MAX_FILES, sinceMs,
      accept: (name) => name.startsWith('rollout-'),
    });
    let projection = emptyLiveProjection();
    const ingest = (file, adapter, context) => {
      for (const record of bootstrapRecords(file, adapter)) {
        for (const event of this.#buildEvents(record, context, file)) {
          projection = reduceLiveEvent(projection, event, {
            maxSessions: HISTORY_MAX_SESSIONS, maxNodesPerSession: this.#options.maxNodesPerSession,
          });
        }
      }
    };
    for (const file of claude.files) {
      ingest(file, 'claude', { adapter: 'claude', sessionId: path.basename(file, '.jsonl'), project: 'unknown' });
    }
    for (const file of codex.files) {
      ingest(file, 'codex', { adapter: 'codex', sessionId: codexTranscriptId(file), meta: {} });
    }
    // A one-shot scan never observes the process ending, so the reducer's
    // last-known state for an unterminated session defaults to lifecycle
    // 'active'/status 'running' — correct for the live tailer (which sweeps
    // continuously as time passes) but wrong here: it would read as a LIVE
    // session and get excluded from the History browser's session list
    // (which explicitly filters OUT anything isLiveSession() still calls
    // live). All-zero windows force every non-terminal session to read as
    // stale immediately, which is the only honest answer for retained
    // evidence being browsed well after the fact.
    projection = sweepLiveProjection(projection, {
      now: this.#options.now(), quiescentMs: 0, expiryMs: 0, pendingExpiryMs: 0,
    });
    const snapshot = serializeLiveProjection(projection);
    return {
      ...snapshot,
      coverage: {
        complete: !claude.truncated && !codex.truncated,
        timeBasis: 'file-mtime',
        scannedAt: this.#options.now(),
        sources: {
          claude: historyDiscoveryCoverage(claude),
          codex: historyDiscoveryCoverage(codex),
        },
      },
    };
  }

  /** Configuration reads are per-project, so memoize by session cwd. */
  #claudeProvider(cwd) {
    if (!this.#claudeProviders.has(cwd)) {
      let resolved = null;
      try { resolved = this.#options.resolveClaudeProvider({ cwd }); } catch { /* stays unresolved */ }
      this.#claudeProviders.set(cwd, resolved);
    }
    return this.#claudeProviders.get(cwd);
  }

  #publish(event, adapter) {
    const published = this.#stream.publish(event);
    this.#projection = reduceLiveEvent(this.#projection, published, {
      maxSessions: this.#options.maxSessions,
      maxNodesPerSession: this.#options.maxNodesPerSession,
    });
    if (published.workspace && this.#workspaceStore) {
      this.#workspaceStore.remember({
        sessionKey: published.sessionKey, sessionId: published.sessionId,
        parentSessionId: published.parentSessionId, host: published.host,
        project: published.project, projectKey: published.projectKey,
        workspace: published.workspace,
      });
    }
    // Status is not set here: tailed adapters recompute it once per pass, and
    // the ledger and runtime adapters mark their own outcome after ingesting.
    const current = this.#health.get(adapter);
    this.#mark(adapter, { events: (current?.events ?? 0) + 1 });
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

  #scheduleRuntimeSessions() {
    const observedAt = this.#options.now();
    const observedMs = Date.parse(observedAt);
    if (this.#lastRuntimeScan
      && observedMs - this.#lastRuntimeScan < this.#options.runtimeScanMs) return;
    if (this.#runtimeSurvey) return;
    this.#lastRuntimeScan = observedMs;
    let result;
    try { result = this.#options.readActiveSessions(); } catch (error) {
      this.#error('runtime', error);
      this.#ingestRuntimeObservation([], observedAt, false);
      return;
    }
    if (Array.isArray(result)) {
      this.#ingestRuntimeObservation(result, observedAt);
      return;
    }
    this.#runtimeSurvey = Promise.resolve(result)
      .then((active) => {
        if (this.#started) this.#ingestRuntimeObservation(active, observedAt);
      })
      .catch((error) => {
        this.#error('runtime', error);
        if (this.#started) this.#ingestRuntimeObservation([], observedAt, false);
      })
      .finally(() => { this.#runtimeSurvey = null; });
  }

  #ingestRuntimeObservation(active, observedAt, surveyHealthy = true) {
    if (!Array.isArray(active)) active = [];
    const observedMs = Date.parse(observedAt);
    const seen = new Set();
    const claimed = new Set([...this.#runtimeBindings.values()]
      .map((binding) => binding.sessionKey));
    const terminal = new Set(['completed', 'failed', 'cancelled']);
    for (const item of active) {
      if (!item || !Number.isInteger(item.pid)
        || !['claude', 'codex', 'opencode'].includes(item.host)) continue;
      const identity = resolveProjectIdentity(item.cwd);
      const folder = this.#leaseFolder(item.cwd, identity);
      if (folder === undefined) continue;
      const sameFolder = (key) => folder === null || this.#sessionFolders.get(key) === folder;
      const runtimeKey = `${item.host}:${item.pid}:${item.startedAt ?? 'unreported'}`;
      seen.add(runtimeKey);
      const priorBinding = this.#runtimeBindings.get(runtimeKey);
      let sessionKey = priorBinding?.sessionKey;
      let session = sessionKey ? this.#projection.sessions.get(sessionKey) : null;
      const synthetic = session?.id?.startsWith('runtime-');
      let rebound = false;
      if (!session || session.host !== item.host || session.projectKey !== identity.key
        || terminal.has(session.status) || synthetic || !sameFolder(sessionKey)) {
        const processStarted = Date.parse(item.startedAt ?? '');
        const candidateCutoff = Number.isFinite(processStarted)
          ? processStarted - 30_000
          : observedMs - this.#options.expiryMs;
        const candidates = [...this.#projection.sessions.values()]
          .filter((candidate) => candidate.host === item.host
            && candidate.projectKey === identity.key
            && sameFolder(candidate.key)
            && !candidate.parentSessionId
            && !candidate.id.startsWith('runtime-')
            && !terminal.has(candidate.status)
            && Number.isFinite(Date.parse(candidate.updatedAt ?? ''))
            && Date.parse(candidate.updatedAt) >= candidateCutoff
            && (!claimed.has(candidate.key) || candidate.key === sessionKey))
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
        // A process and transcript share no native correlation ID. Bind only
        // when one candidate is uniquely plausible; ambiguity stays as an
        // honest runtime-only session rather than a convincing false join.
        const candidate = candidates.length === 1 ? candidates[0] : null;
        if (candidate) {
          if (synthetic && sessionKey !== candidate.key) this.#dropRuntimeSynthetic(sessionKey);
          claimed.delete(sessionKey);
          session = candidate;
          sessionKey = candidate.key;
          rebound = synthetic;
        } else if (folder !== null) {
          // No unique same-folder transcript: no lease. A prior binding
          // misses and quiesces like a vanished process.
          seen.delete(runtimeKey);
          continue;
        } else if (!session || terminal.has(session.status) || !synthetic) {
          session = null;
          const started = Date.parse(item.startedAt ?? '');
          const generation = Number.isFinite(started) ? started.toString(36) : 'unreported';
          sessionKey = canonicalSessionKey(item.host, `runtime-${item.pid}-${generation}`);
        }
      }
      this.#runtimeBindings.set(runtimeKey, {
        sessionKey, misses: 0, host: item.host, pid: item.pid, identity,
      });
      claimed.add(sessionKey);
      const sessionId = session?.id ?? sessionKey.slice(item.host.length + 1);
      // A process lease proves the execution host. Claude additionally has a
      // documented, locally inspectable provider-selection surface, so carry
      // that configured/inferred identity even before a transcript appears.
      // Codex and OpenCode remain unknown until their own evidence reports a
      // provider; host identity must never be used as a provider fallback.
      const resolvedProvider = item.host === 'claude'
        ? this.#claudeProvider(item.cwd) : null;
      this.#publish(createLiveEvent({
        sessionId, host: item.host, surface: 'native',
        project: identity.label, projectKey: identity.key, observedAt,
        workspace: item.workspace ? {
          ...item.workspace,
          confidence: session ? 'correlated' : item.workspace.confidence,
        } : null,
        actor: {
          id: sessionId, kind: 'session', role: 'primary',
          provider: resolvedProvider?.provider,
        },
        action: rebound ? 'session.rebound' : 'session.heartbeat',
        status: 'running',
        source: {
          adapter: 'runtime-process', confidence: 'observed',
          fields: {
            host: 'observed', project: 'observed', status: 'observed',
            provider: resolvedProvider?.provenance,
          },
        },
      }), 'runtime');
    }
    for (const [key, prior] of this.#runtimeBindings) {
      if (seen.has(key)) continue;
      const misses = prior.misses + 1;
      if (misses < Math.max(1, this.#options.runtimeMisses)) {
        this.#runtimeBindings.set(key, { ...prior, misses });
        continue;
      }
      const session = this.#projection.sessions.get(prior.sessionKey);
      if (session && !terminal.has(session.status)) {
        this.#publish(createLiveEvent({
          sessionId: session.id, host: prior.host, surface: 'native',
          project: prior.identity.label, projectKey: prior.identity.key, observedAt,
          actor: { id: session.id, kind: 'session', role: 'primary' },
          action: 'session.heartbeat', status: 'quiescent',
          source: {
            adapter: 'runtime-process', confidence: surveyHealthy ? 'observed' : 'unknown',
            fields: {
              host: 'observed', project: 'observed',
              status: surveyHealthy ? 'observed' : 'unknown',
            },
          },
        }), 'runtime');
      }
      this.#runtimeBindings.delete(key);
    }
    this.#mark('runtime', { status: surveyHealthy ? 'ok' : 'degraded', files: active.length });
  }

  /**
   * What a runtime process may lease. A Git repository's key hashes its
   * canonical root, so any same-key session may bind (null). A plain folder's
   * key hashes only its name, so its process may lease a session only through
   * an exact-folder match with that session's transcript, and never gets a
   * runtime-only session keyed by a name: the folder's correlator. undefined
   * means no lease is possible (unknown label, or the folder is gone).
   */
  #leaseFolder(cwd, identity) {
    if (identity.label === 'unknown') return undefined;
    if (identity.canonical) return null;
    return this.#folderOf(cwd) ?? undefined;
  }

  #dropRuntimeSynthetic(sessionKey) {
    if (!sessionKey || !this.#projection.sessions.has(sessionKey)) return;
    const sessions = new Map(this.#projection.sessions);
    sessions.delete(sessionKey);
    this.#projection = { ...this.#projection, sessions };
    this.#workspaceStore?.forget?.(sessionKey);
  }

  #restoreWorkspaceHistory() {
    for (const record of this.#workspaceStore?.records?.() ?? []) {
      if (!record?.host || !record.sessionId || !record.workspace) continue;
      const event = createLiveEvent({
        sessionId: record.sessionId, parentSessionId: record.parentSessionId,
        host: record.host, surface: 'native', project: record.project,
        projectKey: record.projectKey, observedAt: this.#options.now(),
        sourceTimestamp: record.workspace.capturedAt, workspace: record.workspace,
        actor: { id: record.sessionId, kind: 'session', role: 'primary' },
        action: 'session.metadata', status: 'unknown',
        source: {
          adapter: 'workspace-history', confidence: 'observed',
          fields: { workspace: 'observed', project: record.project ? 'observed' : null },
        },
      });
      this.#projection = reduceLiveEvent(this.#projection, event, {
        maxSessions: this.#options.maxSessions,
        maxNodesPerSession: this.#options.maxNodesPerSession,
      });
    }
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

function compareHistorySessions(left, right) {
  return Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0)
    || String(left.host ?? '').localeCompare(String(right.host ?? ''))
    || String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

/** The live window's discovery bound per host; fileLimit is that host's share. */
function liveDiscoveryCoverage(discovery, fileLimit) {
  return {
    candidateFiles: discovery.candidateCount,
    returnedFiles: discovery.returnedCount,
    fileLimit,
    truncated: discovery.truncated,
  };
}

function historyDiscoveryCoverage(discovery) {
  return {
    candidateFiles: discovery.candidateCount,
    returnedFiles: discovery.returnedCount,
    fileLimit: HISTORY_MAX_FILES,
    truncated: discovery.truncated,
  };
}

function encodeHistoryPageToken(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeHistoryPageToken(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.snapshotId !== 'string'
      || !Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error('invalid');
    return parsed;
  } catch {
    throw invalidHistoryPageToken();
  }
}

function invalidHistoryPageToken() {
  return Object.assign(new Error('invalid history page token'), {
    code: 'INVALID_HISTORY_PAGE_TOKEN',
  });
}
