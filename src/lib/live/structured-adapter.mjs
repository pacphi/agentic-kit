import { createLiveEvent } from './event-schema.mjs';

/** Conservative adapter for structured ruflo/AQE hook events. */
/**
 * @param {Record<string, any>} record
 * @param {{
 *   surface?: string, adapter?: string, sessionId?: string,
 *   observedAt?: string, artifact?: string
 * }} [options]
 */
export function adaptStructuredEvent(record, {
  surface, adapter, sessionId, observedAt, artifact,
} = {}) {
  if (!['ruflo', 'aqe'].includes(surface) || !record || typeof record !== 'object') return [];
  const sid = record.sessionId ?? record.session_id ?? sessionId;
  const actorId = record.agentId ?? record.agent_id ?? record.workerId ?? record.worker_id;
  const action = record.action ?? record.event ?? record.type;
  if (![sid, actorId, action].every((value) => typeof value === 'string' && value)) return [];
  return [createLiveEvent({
    sessionId: sid, host: record.host === 'claude' || record.host === 'codex'
      ? record.host : 'internal',
    surface, project: record.project, observedAt,
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

/** Planned nodes exist only when emitted by an explicit materialized dual run. */
/**
 * @param {Record<string, any>} record
 * @param {{ observedAt?: string, artifact?: string }} [options]
 */
export function adaptDualRunRecord(record, { observedAt, artifact } = {}) {
  if (record?.type !== 'dual-run.plan' || typeof record.runId !== 'string'
    || !Array.isArray(record.steps)) return [];
  const out = [];
  for (const step of record.steps) {
    if (typeof step?.id !== 'string') continue;
    out.push(createLiveEvent({
      sessionId: record.runId, host: ['claude', 'codex'].includes(step.host)
        ? step.host : 'internal',
      surface: 'dual-run', project: record.project, observedAt,
      sourceTimestamp: record.timestamp,
      actor: {
        id: record.runId, kind: 'session', role: 'orchestrator',
        provider: null, model: null,
      },
      action: 'agent.planned', target: { id: step.id, kind: 'agent' },
      status: 'queued',
      source: { adapter: 'dual-run-plan', artifact, confidence: 'planned' },
    }));
  }
  return out;
}
