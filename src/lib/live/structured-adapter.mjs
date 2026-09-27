import { createLiveEvent } from './event-schema.mjs';

const present = (value) => typeof value === 'string' && value !== '';
const sessionIdOf = (record, sessionId) => record.sessionId ?? record.session_id ?? sessionId;
const actorIdOf = (record) => record.agentId ?? record.agent_id ?? record.workerId ?? record.worker_id;
const actionOf = (record) => record.action ?? record.event ?? record.type;

/**
 * Why a structured record cannot become a live event, as a fixed code, or
 * null when it can. The code names the missing field and never echoes record
 * content, so it is safe to show in adapter health. adaptStructuredEvent uses
 * the same rule, so the diagnostic and the adapter cannot drift apart.
 * @param {unknown} record
 * @param {{ surface?: string, sessionId?: string }} [options]
 * @returns {null | 'unsupported-surface' | 'not-an-object' | 'missing-session-id'
 *   | 'missing-actor-id' | 'missing-action'}
 */
export function structuredRecordRejection(record, { surface, sessionId } = {}) {
  if (!['ruflo', 'aqe'].includes(surface)) return 'unsupported-surface';
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not-an-object';
  const fields = /** @type {Record<string, any>} */ (record);
  if (!present(sessionIdOf(fields, sessionId))) return 'missing-session-id';
  if (!present(actorIdOf(fields))) return 'missing-actor-id';
  if (!present(actionOf(fields))) return 'missing-action';
  return null;
}

/** Conservative adapter for structured ruflo/AQE hook events. */
/**
 * @param {Record<string, any>} record
 * @param {{
 *   surface?: string, adapter?: string, sessionId?: string,
 *   observedAt?: string, artifact?: string, project?: string, projectKey?: string
 * }} [options]
 */
export function adaptStructuredEvent(record, {
  surface, adapter, sessionId, observedAt, artifact, project, projectKey,
} = {}) {
  if (structuredRecordRejection(record, { surface, sessionId })) return [];
  const sid = sessionIdOf(record, sessionId);
  const actorId = actorIdOf(record);
  const action = actionOf(record);
  const actorHost = record.actorHost ?? record.actor_host
    ?? record.executionHost ?? record.execution_host ?? record.host;
  const sessionHost = record.sessionHost ?? record.session_host ?? record.host;
  return [createLiveEvent({
    // createLiveEvent already resolves input.host through the same policy
    // (known host, safely-shaped novel id, or 'unknown-host'); passing the
    // raw value through avoids resolving it here a second time.
    sessionId: sid, host: sessionHost,
    surface, project: project ?? record.project,
    // The configured source owns repository attribution. A structured record
    // cannot supply an arbitrary opaque key that collides with another repo.
    projectKey, observedAt,
    sourceTimestamp: record.timestamp ?? record.at,
    workspace: record.workspace,
    actor: {
      id: actorId,
      kind: record.kind === 'gate' ? 'gate' : (record.kind === 'subagent' ? 'subagent' : 'agent'),
      role: record.role,
      // createLiveEvent resolves a *declared* actor host through the same
      // policy as the session host (known id, safe novel id, or
      // 'unknown-host'), and only inherits the session host when it's
      // undefined here — so raw passthrough already gets full per-id truth;
      // pre-resolving would just run the same regex twice.
      host: actorHost,
      provider: record.provider, model: record.model,
    },
    action, target: record.targetId
      ? {
          id: record.targetId, kind: record.targetKind,
          role: record.targetRole ?? record.target_role,
          // Same resolution contract as actor.host above: declared values
          // are resolved, undefined inherits the session host.
          host: record.targetHost ?? record.target_host,
        } : null,
    status: record.status,
    signal: {
      kind: record.signalKind ?? record.signal_kind
        ?? (record.targetId ? 'relationship' : 'activity'),
      phase: record.signalPhase ?? record.signal_phase ?? 'observed',
      correlationId: record.correlationId ?? record.correlation_id,
    },
    source: { adapter, artifact, confidence: 'observed' },
    attributes: { durationMs: record.durationMs },
  })];
}
