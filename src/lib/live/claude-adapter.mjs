import { createLiveEvent } from './event-schema.mjs';
import { classifyToolName } from './tool-classify.mjs';

const artifact = (value) => typeof value === 'string'
  ? value.replaceAll('\\', '/').split('/').pop()?.slice(0, 256) ?? null : null;

/** Translate one Claude transcript record into privacy-safe metadata events. */
export function adaptClaudeRecord(record, context = {}) {
  if (!record || typeof record !== 'object') return [];
  const sessionId = record.sessionId ?? context.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return [];
  const actorId = record.agentId ?? context.agentId ?? sessionId;
  const isSidechain = record.isSidechain === true || actorId !== sessionId;
  const base = {
    sessionId, host: 'claude', surface: 'native',
    project: context.project, observedAt: context.observedAt,
    sourceTimestamp: record.timestamp,
    actor: {
      id: actorId, kind: isSidechain ? 'subagent' : 'session',
      role: isSidechain ? 'worker' : 'primary',
      provider: record.provider ?? context.provider,
      model: record.message?.model ?? context.model,
    },
    source: {
      adapter: 'claude-transcript', artifact: artifact(context.artifact),
      confidence: isSidechain && !record.agentId ? 'inferred' : 'observed',
      fields: {
        project: context.project ? 'observed' : null,
        // A provider on the record itself is observed evidence; one resolved
        // from the host's configuration surface carries that resolution's own
        // provenance (configured/inferred) and must not be upgraded.
        provider: record.provider ? 'observed'
          : (context.provider ? context.providerProvenance ?? 'configured' : null),
        model: record.message?.model || context.model ? 'observed' : null,
        status: 'observed',
        hierarchy: isSidechain ? (record.agentId ? 'observed' : 'inferred') : 'observed',
      },
    },
  };
  const out = [];
  if (context.bootstrap && (record.type === 'user' || record.type === 'assistant')) {
    out.push(createLiveEvent({ ...base, action: 'session.discovered', status: 'unknown' }));
    return out;
  } else if (record.type === 'user' || record.type === 'assistant') {
    out.push(createLiveEvent({
      ...base, action: record.type === 'user' ? 'session.input' : 'agent.output',
      status: 'running',
    }));
  }
  const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
  for (const block of blocks) {
    if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
    const typed = classifyToolName(block.name);
    out.push(createLiveEvent({
      ...base, action: 'tool.started', status: 'running',
      target: { id: block.id, kind: typed.kind, label: typed.category },
      attributes: { toolCategory: typed.category, toolName: block.name },
    }));
  }
  for (const block of blocks) {
    if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    out.push(createLiveEvent({
      ...base, action: 'tool.completed',
      status: block.is_error === true ? 'failed' : 'completed',
      target: { id: block.tool_use_id, kind: 'tool' },
    }));
  }
  return out;
}
