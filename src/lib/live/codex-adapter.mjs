import { createLiveEvent } from './event-schema.mjs';
import { classifyToolName } from './tool-classify.mjs';

const artifact = (value) => typeof value === 'string'
  ? value.replaceAll('\\', '/').split('/').pop()?.slice(0, 256) ?? null : null;

export function adaptCodexRecord(record, context = {}) {
  if (!record || typeof record !== 'object') return [];
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const meta = record.type === 'session_meta' ? payload : context.meta ?? {};
  const sessionId = meta.id ?? context.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return [];
  const subagent = meta.thread_source === 'subagent' || context.threadSource === 'subagent';
  const base = {
    sessionId, parentSessionId: context.parentSessionId,
    host: 'codex', surface: 'native', project: context.project,
    observedAt: context.observedAt, sourceTimestamp: record.timestamp,
      actor: {
        id: sessionId, kind: subagent ? 'subagent' : 'session',
      label: meta.agent_nickname ?? context.agentNickname,
      role: meta.agent_role ?? context.agentRole ?? (subagent ? 'worker' : 'primary'),
      provider: meta.provider ?? context.provider,
      model: record.type === 'turn_context'
        ? payload.model ?? context.model : meta.model ?? context.model,
    },
    source: {
      adapter: 'codex-rollout', artifact: artifact(context.artifact),
      confidence: subagent && meta.thread_source !== 'subagent' ? 'correlated' : 'observed',
      fields: {
        project: context.project ? 'observed' : null,
        provider: meta.provider || context.provider ? 'observed' : null,
        model: (record.type === 'turn_context' ? payload.model : meta.model) || context.model
          ? 'observed' : null,
        status: 'observed',
        hierarchy: subagent ? (meta.thread_source === 'subagent' ? 'observed' : 'correlated') : 'observed',
      },
    },
  };
  if (record.type === 'session_meta') {
    return [createLiveEvent({
      ...base,
      action: context.bootstrap ? 'session.discovered' : 'session.started',
      status: context.bootstrap ? 'unknown' : 'running',
    })];
  }
  if (record.type === 'turn_context' && (payload.model || payload.cwd)) {
    return [createLiveEvent({
      ...base, action: 'session.metadata',
      status: context.bootstrap ? 'unknown' : 'running',
    })];
  }
  if (record.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) {
    return [createLiveEvent({
      ...base, action: payload.type === 'user_message' ? 'session.input' : 'agent.output',
      status: 'running',
    })];
  }
  if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(payload.type)) {
    const callId = payload.call_id ?? payload.id;
    if (typeof callId !== 'string') return [];
    const typed = classifyToolName(payload.name);
    return [createLiveEvent({
      ...base, action: 'tool.started', status: 'running',
      target: { id: callId, kind: typed.kind, label: typed.category },
      attributes: { toolCategory: typed.category, toolName: payload.name },
    })];
  }
  if (record.type === 'response_item'
    && ['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
    const callId = payload.call_id ?? payload.id;
    if (typeof callId !== 'string') return [];
    return [createLiveEvent({
      ...base, action: 'tool.completed', status: 'completed',
      target: { id: callId, kind: 'tool' },
    })];
  }
  if (record.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(payload.type)) {
    return [createLiveEvent({
      ...base, action: 'session.completed',
      status: payload.type === 'turn_aborted' ? 'cancelled' : 'completed',
    })];
  }
  return [];
}

/** Authoritative parent/child edges from readCodexState(). */
export function adaptCodexLedger(ledger, context = {}) {
  if (!(ledger?.threads instanceof Map)) return [];
  const out = [];
  for (const [id, thread] of ledger.threads) {
    const subagent = thread?.threadSource === 'subagent' || ledger.parents?.has(id);
    out.push(createLiveEvent({
      sessionId: id, parentSessionId: ledger.parents?.get(id),
      host: 'codex', surface: 'native', project: thread?.project,
      observedAt: context.observedAt,
      actor: {
        id, kind: subagent ? 'subagent' : 'session',
        label: thread?.agentNickname,
        role: thread?.agentRole ?? (subagent ? 'worker' : 'primary'),
        provider: thread?.provider, model: thread?.model,
      },
      action: 'session.discovered',
      status: ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(thread?.status)
        ? thread.status : 'unknown',
      source: {
        adapter: 'codex-state', confidence: 'observed',
        fields: {
          project: thread?.project ? 'observed' : null,
          provider: thread?.provider ? 'observed' : null,
          model: thread?.model ? 'observed' : null,
          status: thread?.status ? 'observed' : null,
          hierarchy: subagent ? 'observed' : null,
        },
      },
      attributes: { tokenUsage: thread?.tokensUsed },
    }));
  }
  if (!(ledger.parents instanceof Map)) return out;
  for (const [childId, parentId] of ledger.parents) {
    const child = ledger.threads instanceof Map ? ledger.threads.get(childId) : null;
    const parent = ledger.threads instanceof Map ? ledger.threads.get(parentId) : null;
    out.push(createLiveEvent({
      sessionId: parentId, host: 'codex', surface: 'native',
      project: context.project, observedAt: context.observedAt,
      actor: {
        id: parentId, kind: 'session', label: parent?.agentNickname,
        role: parent?.agentRole ?? 'primary',
        provider: parent?.provider, model: parent?.model,
      },
      // The ledger proves hierarchy, not that either thread is currently
      // running. Fresh rollout evidence owns lifecycle.
      action: 'agent.spawned', status: 'unknown',
      target: {
        id: childId, kind: 'subagent',
        label: child?.agentNickname, role: child?.agentRole,
      },
      source: {
        adapter: 'codex-state', artifact: artifact(context.artifact),
        confidence: 'observed',
        fields: {
          project: parent?.project ? 'observed' : null,
          provider: parent?.provider ? 'observed' : null,
          model: parent?.model ? 'observed' : null,
          status: 'observed', hierarchy: 'observed',
        },
      },
      attributes: { tokenUsage: child?.tokensUsed },
    }));
  }
  return out;
}
