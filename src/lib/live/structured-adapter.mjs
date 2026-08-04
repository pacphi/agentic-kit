import { createLiveEvent } from './event-schema.mjs';

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
  if (!['ruflo', 'aqe'].includes(surface) || !record || typeof record !== 'object') return [];
  const sid = record.sessionId ?? record.session_id ?? sessionId;
  const actorId = record.agentId ?? record.agent_id ?? record.workerId ?? record.worker_id;
  const action = record.action ?? record.event ?? record.type;
  if (![sid, actorId, action].every((value) => typeof value === 'string' && value)) return [];
  return [createLiveEvent({
    sessionId: sid, host: record.host === 'claude' || record.host === 'codex'
      ? record.host : 'internal',
    surface, project: project ?? record.project,
    // The configured source owns repository attribution. A structured record
    // cannot supply an arbitrary opaque key that collides with another repo.
    projectKey, observedAt,
    sourceTimestamp: record.timestamp ?? record.at,
    actor: {
      id: actorId,
      kind: record.kind === 'gate' ? 'gate' : (record.kind === 'subagent' ? 'subagent' : 'agent'),
      role: record.role, provider: record.provider, model: record.model,
    },
    action, target: record.targetId
      ? { id: record.targetId, kind: record.targetKind } : null,
    status: record.status,
    source: { adapter, artifact, confidence: 'observed' },
    attributes: { durationMs: record.durationMs },
  })];
}
