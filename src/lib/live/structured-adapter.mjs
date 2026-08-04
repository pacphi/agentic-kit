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
  const actorHost = record.actorHost ?? record.actor_host
    ?? record.executionHost ?? record.execution_host ?? record.host;
  const sessionHost = record.sessionHost ?? record.session_host ?? record.host;
  if (![sid, actorId, action].every((value) => typeof value === 'string' && value)) return [];
  return [createLiveEvent({
    sessionId: sid, host: ['claude', 'codex', 'opencode'].includes(sessionHost)
      ? sessionHost : 'internal',
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
      host: ['claude', 'codex', 'opencode'].includes(actorHost) ? actorHost : 'internal',
      provider: record.provider, model: record.model,
    },
    action, target: record.targetId
      ? {
          id: record.targetId, kind: record.targetKind,
          role: record.targetRole ?? record.target_role,
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
