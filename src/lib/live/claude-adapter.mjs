import { createLiveEvent } from './event-schema.mjs';
import { classifyToolName } from './tool-classify.mjs';
import { artifactName, decodeClaudeRecord } from '../telemetry-records.mjs';

/** The `actor` half of a Claude record's live-event base. */
function buildClaudeRecordActor({ actorId, isSidechain, record, context, decoded }) {
  return {
    id: actorId, kind: isSidechain ? 'subagent' : 'session',
    role: isSidechain ? 'worker' : 'primary',
    provider: record.provider ?? context.provider,
    model: decoded.model ?? context.model,
  };
}

/** The `source.fields` half of a Claude record's live-event base. */
function buildClaudeRecordSourceFields({ context, record, decoded, isSidechain }) {
  return {
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
  };
}

/** Fields shared by every live event derived from one decoded Claude record. */
function buildClaudeRecordBase({ sessionId, actorId, isSidechain, record, context, decoded }) {
  return {
    sessionId, host: 'claude', surface: 'native',
    project: context.project, projectKey: context.projectKey, observedAt: context.observedAt,
    sourceTimestamp: record.timestamp,
    workspace: context.workspace,
    actor: buildClaudeRecordActor({ actorId, isSidechain, record, context, decoded }),
    source: {
      adapter: 'claude-transcript', artifact: artifactName(context.artifact),
      confidence: isSidechain && !decoded.agentId ? 'inferred' : 'observed',
      fields: buildClaudeRecordSourceFields({ context, record, decoded, isSidechain }),
    },
  };
}

/** The "primary contains subagent" edge event for a newly-seen sidechain actor. */
function buildClaudeContainmentEvent({ base, sessionId, actorId, decoded, record, context }) {
  return createLiveEvent({
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

/** The containment edge to emit for this record, or null when the actor was
 *  already announced once. `context.containedActors` is mutated as a side
 *  effect (created on first use), the same seen-set used across records. */
function resolveClaudeContainment({ base, sessionId, actorId, isSidechain, decoded, record, context }) {
  const containedActors = context.containedActors instanceof Set
    ? context.containedActors : (context.containedActors = new Set());
  if (!isSidechain || actorId === sessionId || containedActors.has(actorId)) return null;
  containedActors.add(actorId);
  return buildClaudeContainmentEvent({ base, sessionId, actorId, decoded, record, context });
}

/** tool_use/tool_result blocks → their tool.started/tool.completed events. */
function claudeToolEvents(base, decoded) {
  const out = [];
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
  return out;
}

/** Translate one Claude transcript record into privacy-safe metadata events. */
export function adaptClaudeRecord(record, context = {}) {
  if (!record || typeof record !== 'object') return [];
  const decoded = decodeClaudeRecord(record);
  const sessionId = decoded.sessionId ?? context.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return [];
  const actorId = decoded.agentId ?? context.agentId ?? sessionId;
  const isSidechain = decoded.isSidechain || actorId !== sessionId;
  const base = buildClaudeRecordBase({ sessionId, actorId, isSidechain, record, context, decoded });
  const containment = resolveClaudeContainment({ base, sessionId, actorId, isSidechain, decoded, record, context });

  const out = [];
  const isTurn = decoded.role === 'user' || decoded.role === 'assistant';
  if (context.bootstrap && isTurn) {
    out.push(createLiveEvent({ ...base, action: 'session.discovered', status: 'unknown' }));
    if (containment) out.push(containment);
    return out;
  }
  if (isTurn) {
    out.push(createLiveEvent({
      ...base, action: decoded.role === 'user' ? 'session.input' : 'agent.output',
      status: 'running',
    }));
  }
  out.push(...claudeToolEvents(base, decoded));
  if (containment) out.push(containment);
  return out;
}
