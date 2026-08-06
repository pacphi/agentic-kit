import path from 'node:path';
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
import { adaptStructuredEvent } from './structured-adapter.mjs';
import { canonicalSessionKey, resolveProjectIdentity } from './project-label.mjs';
import { workspaceFromSource } from './git-workspace.mjs';
import { WorkspaceSnapshotStore } from './workspace-store.mjs';
import {
  bootstrapRecords, codexTranscriptId, discoverJsonl,
} from './native-transcript-discovery.mjs';

// historySnapshot() is a one-shot on-demand scan, not a continuously-tailed
// live feed, so it can afford limits well above the live path's maxFiles(256)
// /maxSessions(100) defaults — those stay small purely to keep the always-on
// tailer set cheap. discoverJsonl's own hard 4096-file safety cap is the real
// backstop for the "all time" window on a machine with a large corpus.
const HISTORY_MAX_FILES = 2048;
const HISTORY_MAX_SESSIONS = 1000;

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
    for (const name of ['claude', 'codex', 'ruflo', 'aqe', 'codex-state']) {
      this.#health.set(name, { status: 'idle', files: 0, events: 0, errors: 0, lastError: null });
    }
    for (const name of ['opencode', 'runtime']) {
      this.#health.set(name, { status: 'idle', files: 0, events: 0, errors: 0, lastError: null });
    }
  }

  start() {
    if (this.#started) return this;
    this.#started = true;
    this.#restoreWorkspaceHistory();
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
    this.#runtimeBindings.clear();
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
    this.#scheduleRuntimeSessions();
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
    const claude = discoverJsonl(this.#options.roots.claude, {
      maxDepth: 3, maxFiles: claudeLimit, accept: () => true,
    });
    const codex = discoverJsonl(this.#options.roots.codex, {
      maxDepth: 4, maxFiles: codexLimit, accept: (name) => name.startsWith('rollout-'),
    });
    // The bounded set is a moving window, not a startup-only choice. Replace
    // native tailers that fell out of the newest-file budget so an active
    // session created after the dashboard started can become observable.
    const desiredNative = new Set([...claude, ...codex]);
    for (const [file, context] of this.#contexts) {
      if (!['claude', 'codex'].includes(context.adapter) || desiredNative.has(file)) continue;
      this.#tailers.get(file)?.close();
      this.#tailers.delete(file);
      this.#contexts.delete(file);
      const current = this.#health.get(context.adapter);
      this.#mark(context.adapter, { files: Math.max(0, (current?.files ?? 1) - 1) });
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
        this.#record(record, bootstrap, file);
      }
      Object.assign(context, bootstrap, { bootstrap: false });
    }
    const onRecord = (record) => this.#record(record, context, file);
    const onError = (error) => this.#error(context.adapter, error);
    const tailer = new JsonlTailer(file, { onRecord, onError, startAtEnd: initial });
    this.#tailers.set(file, tailer);
    this.#contexts.set(file, context);
    this.#mark(context.adapter, { files: (this.#health.get(context.adapter)?.files ?? 0) + 1 });
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
    for (const event of events) this.#publish(event, context.adapter);
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
   * @returns {ReturnType<typeof serializeLiveProjection>}
   */
  historySnapshot({ sinceMs = null } = {}) {
    const claude = discoverJsonl(this.#options.roots.claude, {
      maxDepth: 3, maxFiles: HISTORY_MAX_FILES, sinceMs, accept: () => true,
    });
    const codex = discoverJsonl(this.#options.roots.codex, {
      maxDepth: 4, maxFiles: HISTORY_MAX_FILES, sinceMs, accept: (name) => name.startsWith('rollout-'),
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
    for (const file of claude) {
      ingest(file, 'claude', { adapter: 'claude', sessionId: path.basename(file, '.jsonl'), project: 'unknown' });
    }
    for (const file of codex) {
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
    return serializeLiveProjection(projection);
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
      if (!identity.canonical || identity.label === 'unknown') continue;
      const runtimeKey = `${item.host}:${item.pid}:${item.startedAt ?? 'unreported'}`;
      seen.add(runtimeKey);
      const priorBinding = this.#runtimeBindings.get(runtimeKey);
      let sessionKey = priorBinding?.sessionKey;
      let session = sessionKey ? this.#projection.sessions.get(sessionKey) : null;
      const synthetic = session?.id?.startsWith('runtime-');
      let rebound = false;
      if (!session || session.host !== item.host || session.projectKey !== identity.key
        || terminal.has(session.status) || synthetic) {
        const processStarted = Date.parse(item.startedAt ?? '');
        const candidateCutoff = Number.isFinite(processStarted)
          ? processStarted - 30_000
          : observedMs - this.#options.expiryMs;
        const candidates = [...this.#projection.sessions.values()]
          .filter((candidate) => candidate.host === item.host
            && candidate.projectKey === identity.key
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
