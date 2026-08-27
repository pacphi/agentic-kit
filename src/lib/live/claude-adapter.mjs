import { createLiveEvent } from './event-schema.mjs';
import { classifyToolName } from './tool-classify.mjs';
import { artifactName, decodeClaudeRecord } from '../telemetry-records.mjs';

/** Translate one Claude transcript record into privacy-safe metadata events. */
export function adaptClaudeRecord(record, context = {}) {
  if (!record || typeof record !== 'object') return [];
  const decoded = decodeClaudeRecord(record);
  const sessionId = decoded.sessionId ?? context.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return [];
  const actorId = decoded.agentId ?? context.agentId ?? sessionId;
  const isSidechain = decoded.isSidechain || actorId !== sessionId;
  const base = {
    sessionId, host: 'claude', surface: 'native',
    project: context.project, projectKey: context.projectKey, observedAt: context.observedAt,
    sourceTimestamp: record.timestamp,
    workspace: context.workspace,
    actor: {
      id: actorId, kind: isSidechain ? 'subagent' : 'session',
      role: isSidechain ? 'worker' : 'primary',
      provider: record.provider ?? context.provider,
      model: decoded.model ?? context.model,
    },
    source: {
      adapter: 'claude-transcript', artifact: artifactName(context.artifact),
      confidence: isSidechain && !decoded.agentId ? 'inferred' : 'observed',
      fields: {
        project: context.project ? 'observed' : null,
        // A provider on the record itself is observed evidence; one resolved
        // from the host's configuration surface carries that resolution's own
        // provenance (configured/inferred) and must not be upgraded.
        provider: record.provider ? 'observed'
          : (context.provider ? context.providerProvenance ?? 'configured' : null),
        model: decoded.model || context.model ? 'observed' : null,
        status: 'observed',
        hierarchy: isSidechain ? (decoded.agentId ? 'observed' : 'inferred') : 'observed',
        workspace: context.workspace ? context.workspace.confidence ?? 'observed' : null,
      },
    },
  };
  const out = [];
  const containedActors = context.containedActors instanceof Set
    ? context.containedActors : (context.containedActors = new Set());
  let containment = null;
  if (isSidechain && actorId !== sessionId && !containedActors.has(actorId)) {
    containedActors.add(actorId);
    containment = createLiveEvent({
      ...base,
      actor: {
        id: sessionId, kind: 'session', role: 'primary',
        provider: record.provider ?? context.provider,
        model: decoded.model ?? context.model,
      },
      action: 'contains', status: 'unknown',
      signal: { kind: 'relationship', phase: 'observed' },
      target: { id: actorId, kind: 'subagent', role: 'worker' },
      source: {
        ...base.source,
        confidence: decoded.agentId ? 'observed' : 'inferred',
        fields: { ...base.source.fields,
          hierarchy: decoded.agentId ? 'observed' : 'inferred' },
      },
    });
  }
  if (context.bootstrap && (decoded.role === 'user' || decoded.role === 'assistant')) {
    out.push(createLiveEvent({ ...base, action: 'session.discovered', status: 'unknown' }));
    if (containment) out.push(containment);
    return out;
  } else if (decoded.role === 'user' || decoded.role === 'assistant') {
    out.push(createLiveEvent({
      ...base, action: decoded.role === 'user' ? 'session.input' : 'agent.output',
      status: 'running',
    }));
  }
  for (const use of decoded.toolUses) {
    if (typeof use.id !== 'string') continue;
    const typed = classifyToolName(use.name);
    out.push(createLiveEvent({
      ...base, action: 'tool.started', status: 'running',
      target: { id: use.id, kind: typed.kind, label: typed.category },
      attributes: { toolCategory: typed.category, toolName: use.name },
    }));
  }
  for (const result of decoded.toolResults) {
    if (typeof result.id !== 'string') continue;
    out.push(createLiveEvent({
      ...base, action: 'tool.completed',
      status: result.isError ? 'failed' : 'completed',
      target: { id: result.id, kind: 'tool' },
    }));
  }
  if (containment) out.push(containment);
  return out;
}
