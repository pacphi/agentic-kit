export const LIVE_SCHEMA_VERSION = 1;

const HOSTS = new Set(['claude', 'codex', 'opencode', 'internal']);
// `internal` is read-only historical vocabulary. Live-source registration still
// admits only ruflo/aqe, and no current writer emits the retired dual-run label.
const SURFACES = new Set(['native', 'ruflo', 'aqe', 'plugin', 'skill', 'internal']);
const CONFIDENCE = new Set(['observed', 'configured', 'correlated', 'inferred', 'unknown', 'assumed', 'planned']);
const PROVIDER_PROVENANCE = new Set(['observed', 'configured', 'inferred', 'unknown']);
const EVIDENCE_FIELDS = ['host', 'project', 'provider', 'model', 'status', 'hierarchy'];
const STATUS = new Set([
  'queued', 'running', 'quiescent', 'expired', 'blocked',
  'completed', 'failed', 'cancelled', 'unknown',
]);
const ACTOR_KINDS = new Set([
  'session', 'agent', 'subagent', 'tool', 'skill', 'plugin', 'mcp', 'gate',
]);

function text(value, max = 256) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function timestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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
  const host = HOSTS.has(input.host) ? input.host : 'internal';
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
    actor: {
      id: actorId,
      kind: actorKind,
      label: text(input.actor?.label, 96),
      role: text(input.actor?.role, 96),
      provider,
      model,
    },
    action,
    target: input.target?.id ? {
      id: text(input.target.id),
      kind: ACTOR_KINDS.has(input.target.kind) ? input.target.kind : 'agent',
      label: text(input.target.label, 96),
      role: text(input.target.role, 96),
    } : null,
    status: STATUS.has(input.status) ? input.status : 'unknown',
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
