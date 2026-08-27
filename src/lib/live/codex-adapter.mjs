import { createLiveEvent } from './event-schema.mjs';
import { classifyToolName } from './tool-classify.mjs';
import { artifactName, decodeCodexRecord, resolveCodexProvider } from '../telemetry-records.mjs';

/** The `actor` half of a decoded-record's live-event base. */
function buildCodexRecordActor({ sessionId, subagent, meta, metaProvider, context, decoded, record }) {
  return {
    id: sessionId, kind: subagent ? 'subagent' : 'session',
    label: meta.agent_nickname ?? context.agentNickname,
    role: meta.agent_role ?? context.agentRole ?? (subagent ? 'worker' : 'primary'),
    provider: metaProvider ?? context.provider,
    model: record.type === 'turn_context'
      ? decoded.model ?? context.model : meta.model ?? context.model,
  };
}

/** The `source.fields` half of a decoded-record's live-event base. */
function buildCodexRecordSourceFields({ context, metaProvider, record, decoded, meta, subagent }) {
  return {
    project: context.project ? 'observed' : null,
    provider: metaProvider || context.provider ? 'observed' : null,
    model: (record.type === 'turn_context' ? decoded.model : meta.model) || context.model
      ? 'observed' : null,
    status: 'observed',
    hierarchy: subagent ? (meta.thread_source === 'subagent' ? 'observed' : 'correlated') : 'observed',
    workspace: context.workspace ? context.workspace.confidence ?? 'observed' : null,
  };
}

/** Fields shared by every live event derived from one decoded rollout record. */
function buildCodexRecordBase({ record, context, decoded, meta, metaProvider, sessionId, subagent }) {
  return {
    sessionId, parentSessionId: context.parentSessionId,
    host: 'codex', surface: 'native', project: context.project,
    projectKey: context.projectKey,
    observedAt: context.observedAt, sourceTimestamp: record.timestamp,
    workspace: context.workspace,
    actor: buildCodexRecordActor({ sessionId, subagent, meta, metaProvider, context, decoded, record }),
    source: {
      adapter: 'codex-rollout', artifact: artifactName(context.artifact),
      confidence: subagent && meta.thread_source !== 'subagent' ? 'correlated' : 'observed',
      fields: buildCodexRecordSourceFields({ context, metaProvider, record, decoded, meta, subagent }),
    },
  };
}

/** One decoded record → zero or one live events, dispatched on decoded.type. */
function codexRecordEvents(decoded, base, context) {
  if (decoded.type === 'meta') {
    return [createLiveEvent({
      ...base,
      action: context.bootstrap ? 'session.discovered' : 'session.started',
      status: context.bootstrap ? 'unknown' : 'running',
    })];
  }
  if (decoded.type === 'turnContext' && (decoded.model || decoded.cwd)) {
    return [createLiveEvent({
      ...base, action: 'session.metadata',
      status: context.bootstrap ? 'unknown' : 'running',
    })];
  }
  if (decoded.type === 'message') {
    return [createLiveEvent({
      ...base, action: decoded.role === 'user' ? 'session.input' : 'agent.output',
      status: 'running',
    })];
  }
  if (decoded.type === 'toolCall') {
    if (typeof decoded.callId !== 'string') return [];
    const typed = classifyToolName(decoded.toolName);
    return [createLiveEvent({
      ...base, action: 'tool.started', status: 'running',
      target: { id: decoded.callId, kind: typed.kind, label: typed.category },
      attributes: { toolCategory: typed.category, toolName: decoded.toolName },
    })];
  }
  if (decoded.type === 'toolResult') {
    if (typeof decoded.callId !== 'string') return [];
    return [createLiveEvent({
      ...base, action: 'tool.completed', status: 'completed',
      target: { id: decoded.callId, kind: 'tool' },
    })];
  }
  if (decoded.type === 'lifecycle') {
    return [createLiveEvent({
      ...base, action: 'session.completed', status: decoded.status,
    })];
  }
  return [];
}

export function adaptCodexRecord(record, context = {}) {
  if (!record || typeof record !== 'object') return [];
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const decoded = decodeCodexRecord(record);
  const meta = record.type === 'session_meta' ? payload : context.meta ?? {};
  // codex spells this model_provider in rollout session_meta; bare provider is
  // legacy tolerance only. `decoded.provider` already applies that same
  // lookup (resolveCodexProvider) to THIS record; a carried-forward meta from
  // an earlier session_meta needs the identical lookup applied directly,
  // since decodeCodexRecord only ever sees one record at a time.
  const metaProvider = decoded.type === 'meta' ? decoded.provider : resolveCodexProvider(meta);
  const sessionId = meta.id ?? context.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return [];
  const subagent = meta.thread_source === 'subagent' || context.threadSource === 'subagent';
  const base = buildCodexRecordBase({ record, context, decoded, meta, metaProvider, sessionId, subagent });
  return codexRecordEvents(decoded, base, context);
}

/** The ledger's own status enum, else `'unknown'` for anything it doesn't name. */
function codexThreadStatus(thread) {
  return ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(thread?.status)
    ? thread.status : 'unknown';
}

/** The `actor` half of a ledger thread's discovered event. */
function ledgerThreadActor(id, thread, subagent) {
  return {
    id, kind: subagent ? 'subagent' : 'session',
    label: thread?.agentNickname,
    role: thread?.agentRole ?? (subagent ? 'worker' : 'primary'),
    provider: thread?.provider, model: thread?.model,
  };
}

/** The `source.fields` half of a ledger thread's discovered event. */
function ledgerThreadSourceFields(thread, subagent) {
  return {
    project: thread?.project ? 'observed' : null,
    provider: thread?.provider ? 'observed' : null,
    model: thread?.model ? 'observed' : null,
    status: thread?.status ? 'observed' : null,
    hierarchy: subagent ? 'observed' : null,
    workspace: thread?.workspace ? 'observed' : null,
  };
}

/** One ledger thread → its `session.discovered` live event. */
function buildLedgerThreadEvent(id, thread, ledger, context) {
  const subagent = thread?.threadSource === 'subagent' || ledger.parents?.has(id);
  return createLiveEvent({
    sessionId: id, parentSessionId: ledger.parents?.get(id),
    host: 'codex', surface: 'native', project: thread?.project,
    projectKey: thread?.projectKey,
    observedAt: context.observedAt,
    sourceTimestamp: thread?.updatedAt ?? thread?.recencyAt ?? thread?.createdAt,
    workspace: thread?.workspace,
    actor: ledgerThreadActor(id, thread, subagent),
    action: 'session.discovered',
    status: codexThreadStatus(thread),
    source: {
      adapter: 'codex-state', confidence: 'observed',
      fields: ledgerThreadSourceFields(thread, subagent),
    },
    attributes: { tokenUsage: thread?.tokensUsed },
  });
}

/** The `source.fields` half of a spawn-edge event. */
function ledgerSpawnSourceFields(project, parent) {
  return {
    project: project && project !== 'unknown' ? 'observed' : null,
    provider: parent?.provider ? 'observed' : null,
    model: parent?.model ? 'observed' : null,
    status: 'observed', hierarchy: 'observed',
  };
}

/** One ledger parent/child edge → its `agent.spawned` live event. The ledger
 *  proves hierarchy, not that either thread is currently running — fresh
 *  rollout evidence owns lifecycle, so status is always 'unknown' here. */
function buildLedgerSpawnEdgeEvent(childId, parentId, ledger, context) {
  const child = ledger.threads instanceof Map ? ledger.threads.get(childId) : null;
  const parent = ledger.threads instanceof Map ? ledger.threads.get(parentId) : null;
  const project = parent?.project ?? context.project;
  const projectKey = parent?.projectKey ?? context.projectKey;
  return createLiveEvent({
    sessionId: parentId, host: 'codex', surface: 'native',
    project, projectKey, observedAt: context.observedAt,
    sourceTimestamp: parent?.updatedAt ?? parent?.recencyAt ?? parent?.createdAt,
    actor: {
      id: parentId, kind: 'session', label: parent?.agentNickname,
      role: parent?.agentRole ?? 'primary',
      provider: parent?.provider, model: parent?.model,
    },
    action: 'agent.spawned', status: 'unknown',
    target: {
      id: childId, kind: 'subagent',
      label: child?.agentNickname, role: child?.agentRole,
    },
    source: {
      adapter: 'codex-state', artifact: artifactName(context.artifact),
      confidence: 'observed',
      fields: ledgerSpawnSourceFields(project, parent),
    },
    attributes: { tokenUsage: child?.tokensUsed },
  });
}

/** Authoritative parent/child edges from readCodexState(). */
export function adaptCodexLedger(ledger, context = {}) {
  if (!(ledger?.threads instanceof Map)) return [];
  const out = [];
  for (const [id, thread] of ledger.threads) out.push(buildLedgerThreadEvent(id, thread, ledger, context));
  if (!(ledger.parents instanceof Map)) return out;
  for (const [childId, parentId] of ledger.parents) out.push(buildLedgerSpawnEdgeEvent(childId, parentId, ledger, context));
  return out;
}
