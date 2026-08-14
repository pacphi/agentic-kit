export const LIVE_SCHEMA_VERSION = 2;

const HOSTS = new Set(['claude', 'codex', 'opencode', 'internal']);
// `internal` is read-only historical vocabulary. Live-source registration still
// admits only ruflo/aqe, and no current writer emits the retired dual-run label.
// A host id outside this closed set is not folded into `internal` — that would
// misrecord a real, novel assistant as ak-internal activity. A safely-shaped
// unknown id (see SAFE_HOST_ID) passes through verbatim so per-id truth is
// preserved; anything unsafe or non-string becomes the explicit 'unknown-host'
// bucket, which can never collide with 'internal' or a real host.
const SAFE_HOST_ID = /^[a-z][a-z0-9-]{0,31}$/;
const SURFACES = new Set(['native', 'ruflo', 'aqe', 'plugin', 'skill', 'internal']);
const CONFIDENCE = new Set(['observed', 'configured', 'correlated', 'inferred', 'unknown', 'assumed', 'planned']);
const PROVIDER_PROVENANCE = new Set(['observed', 'configured', 'inferred', 'unknown']);
const EVIDENCE_FIELDS = ['host', 'project', 'provider', 'model', 'status', 'hierarchy', 'workspace'];
const STATUS = new Set([
  'queued', 'running', 'quiescent', 'expired', 'blocked',
  'completed', 'failed', 'cancelled', 'unknown',
]);
const SIGNAL_KINDS = new Set([
  'presence', 'activity', 'operation', 'relationship', 'metadata',
]);
const SIGNAL_PHASES = new Set([
  'observed', 'started', 'updated', 'quiescent',
  'completed', 'failed', 'cancelled', 'planned',
]);
const ACTOR_KINDS = new Set([
  'session', 'agent', 'subagent', 'tool', 'skill', 'plugin', 'mcp', 'gate',
]);
const SECRET_SHAPE = /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:secret|token|password|api[_-]?key)[=:][^/\s]{8,})/gi;

function text(value, max = 256) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function workspaceText(value, max, { pathLike = false, leaf = false } = {}) {
  if (typeof value !== 'string') return null;
  const clean = [...value].filter((character) => {
    const code = character.codePointAt(0);
    return code != null && code > 31 && code !== 127;
  }).join('').replace(SECRET_SHAPE, '…redacted').trim();
  if (!clean) return null;
  if (leaf && /[/\\]/.test(clean)) return null;
  if (pathLike && (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(clean)
    || clean.split(/[/\\]/).includes('..'))) return null;
  return clean.slice(0, max);
}

function timestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function count(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

// 'unknown-host' is itself SAFE_HOST_ID-shaped, so a host literally named
// 'unknown-host' is indistinguishable from the bucket. Accepted: no consumer
// branches on bucketed-vs-declared, and inventing an out-of-grammar sentinel
// risks its own key-syntax interactions downstream.
export function resolveHost(value) {
  if (HOSTS.has(value)) return value;
  return typeof value === 'string' && SAFE_HOST_ID.test(value) ? value : 'unknown-host';
}

function safeWorkspace(value) {
  if (!value || typeof value !== 'object') return null;
  const capturedAt = timestamp(value.capturedAt);
  if (!capturedAt) return null;
  const changes = value.changes && typeof value.changes === 'object' ? {
    additions: count(value.changes.additions), deletions: count(value.changes.deletions),
    files: count(value.changes.files), binaryFiles: count(value.changes.binaryFiles),
    basis: value.changes.basis === 'tracked-vs-head' ? value.changes.basis : null,
    completeness: text(value.changes.completeness, 80),
    capturedAt: timestamp(value.changes.capturedAt) ?? capturedAt,
  } : null;
  return {
    key: /^workspace:[a-f0-9]{16}$/.test(value.key ?? '') ? value.key : null,
    repositoryLabel: workspaceText(value.repositoryLabel, 96, { leaf: true }),
    directoryLabel: workspaceText(value.directoryLabel, 180, { pathLike: true }),
    branchLabel: workspaceText(value.branchLabel, 160, { pathLike: true }),
    branchState: ['attached', 'detached', 'unborn', 'unknown'].includes(value.branchState)
      ? value.branchState : 'unknown',
    changes, capturedAt,
    source: text(value.source, 48),
    confidence: CONFIDENCE.has(value.confidence) ? value.confidence : 'unknown',
  };
}

function inferredSignal(action, status) {
  if (action === 'session.heartbeat' || action === 'session.rebound') {
    return { kind: 'presence', phase: status === 'quiescent' ? 'quiescent' : 'observed' };
  }
  if (action.startsWith('tool.')) {
    const phase = action.endsWith('.started') ? 'started'
      : (status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed');
    return { kind: 'operation', phase };
  }
  if (action === 'agent.spawned' || action === 'agent.planned') {
    return { kind: 'relationship', phase: action === 'agent.planned' ? 'planned' : 'observed' };
  }
  if (['session.input', 'agent.output', 'session.started'].includes(action)) {
    return { kind: 'activity', phase: action === 'session.started' ? 'started' : 'updated' };
  }
  return { kind: 'metadata', phase: 'observed' };
}

/**
 * Construct the public telemetry DTO field-by-field. Raw transcript objects are
 * intentionally never spread into the result: prompts, arguments and output
 * therefore cannot escape merely because an upstream schema adds a field.
 */
export function createLiveEvent(input, { now = () => new Date().toISOString() } = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('live event must be an object');
  const sessionId = text(input.sessionId);
  const action = text(input.action, 96);
  const actorId = text(input.actor?.id);
  if (!sessionId || !action || !actorId) {
    throw new TypeError('live event requires sessionId, action and actor.id');
  }
  const host = resolveHost(input.host);
  // Preserve the historical actor-level identity accepted from adapters while
  // exposing the axes at the event level. Provider intentionally has no host
  // fallback: a transcript proves its host, not which provider served it.
  const provider = text(input.provider, 96) ?? text(input.actor?.provider, 96);
  const model = text(input.model, 128) ?? text(input.actor?.model, 128);
  const providerProvenance = PROVIDER_PROVENANCE.has(input.providerProvenance)
    ? input.providerProvenance
    : (PROVIDER_PROVENANCE.has(input.source?.fields?.provider)
        ? input.source.fields.provider : 'unknown');
  const project = safeProjectLabel(input.project);
  // Preserve the fact that a pre-GA compatibility record was internally
  // synthesized; relabeling it "native" would overstate its provenance.
  const surface = input.surface === 'dual-run'
    ? 'internal'
    : (SURFACES.has(input.surface) ? input.surface : 'native');
  const actorKind = ACTOR_KINDS.has(input.actor?.kind) ? input.actor.kind : 'agent';
  const observedAt = timestamp(input.observedAt) ?? timestamp(now());
  if (!observedAt) throw new TypeError('live event requires a valid observedAt');
  const inferred = inferredSignal(action, STATUS.has(input.status) ? input.status : 'unknown');
  const signalKind = SIGNAL_KINDS.has(input.signal?.kind) ? input.signal.kind : inferred.kind;
  const signalPhase = SIGNAL_PHASES.has(input.signal?.phase) ? input.signal.phase : inferred.phase;

  const out = {
    schemaVersion: LIVE_SCHEMA_VERSION,
    observedAt,
    sourceTimestamp: timestamp(input.sourceTimestamp),
    sessionId,
    sessionKey: canonicalSessionKey(host, sessionId),
    parentSessionId: text(input.parentSessionId),
    traceId: text(input.traceId, 128),
    spanId: text(input.spanId, 128),
    parentSpanId: text(input.parentSpanId, 128),
    host,
    provider,
    model,
    providerProvenance,
    surface,
    project,
    projectKey: safeProjectKey(input.projectKey, project),
    workspace: safeWorkspace(input.workspace),
    actor: {
      id: actorId,
      kind: actorKind,
      label: text(input.actor?.label, 96),
      role: text(input.actor?.role, 96),
      // No declared host is a legitimate inference (the actor ran in the
      // session's host); a declared-but-unrecognized host is not the same
      // thing and must run through the same resolution as the event-level
      // host, or it would silently misattribute a novel actor to whichever
      // host the session happened to be.
      host: input.actor?.host == null ? host : resolveHost(input.actor.host),
      provider,
      model,
    },
    action,
    target: input.target?.id ? {
      id: text(input.target.id),
      kind: ACTOR_KINDS.has(input.target.kind) ? input.target.kind : 'agent',
      label: text(input.target.label, 96),
      role: text(input.target.role, 96),
      host: input.target.host == null ? host : resolveHost(input.target.host),
    } : null,
    status: STATUS.has(input.status) ? input.status : 'unknown',
    signal: {
      kind: signalKind,
      phase: signalPhase,
      correlationId: text(input.signal?.correlationId, 128),
    },
    source: {
      adapter: text(input.source?.adapter, 96) ?? 'unknown',
      artifact: text(input.source?.artifact),
      confidence: CONFIDENCE.has(input.source?.confidence)
        ? input.source.confidence : 'observed',
      fields: Object.fromEntries(EVIDENCE_FIELDS.map((field) => [
        field,
        CONFIDENCE.has(input.source?.fields?.[field]) ? input.source.fields[field] : null,
      ])),
    },
    attributes: {
      durationMs: Number.isFinite(input.attributes?.durationMs)
        ? Math.max(0, input.attributes.durationMs) : null,
      tokenUsage: Number.isFinite(input.attributes?.tokenUsage)
        ? Math.max(0, input.attributes.tokenUsage) : null,
      toolCategory: text(input.attributes?.toolCategory, 96),
      toolName: text(input.attributes?.toolName, 96),
    },
  };
  return out;
}
import {
  canonicalSessionKey, safeProjectKey, safeProjectLabel,
} from './project-label.mjs';
