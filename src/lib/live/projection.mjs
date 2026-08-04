function nodeFrom(actor, event) {
  return {
    id: actor.id, kind: actor.kind, label: actor.label, role: actor.role, provider: actor.provider,
    providerProvenance: actor.provider ? event.providerProvenance : 'unknown',
    model: actor.model, host: event.host, surface: event.surface,
    status: event.status, lastEventId: event.eventId ?? null,
    observedAt: event.observedAt, confidence: event.source.confidence,
    sourceAdapter: event.source.adapter, lastAction: event.action,
    durationMs: event.attributes.durationMs, toolName: event.attributes.toolName,
    evidence: event.source.fields,
  };
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_SEEN_EVENT_IDS = 10_000;
const RESOURCE_KINDS = new Set(['tool', 'skill', 'plugin', 'mcp']);

export function emptyLiveProjection() {
  return { schemaVersion: 1, cursor: null, sessions: new Map(), seenEventIds: new Set() };
}

/** Immutable reducer so snapshot readers never observe a half-applied event. */
export function reduceLiveEvent(projection, event, {
  maxSessions = 100, maxNodesPerSession = 1000,
} = {}) {
  if (event.eventId && projection.seenEventIds?.has(event.eventId)) return projection;
  const sessions = new Map(projection.sessions);
  const sessionKey = event.sessionKey ?? canonicalSessionKey(event.host, event.sessionId);
  const prior = sessions.get(sessionKey);
  const session = prior
    ? { ...prior, nodes: new Map(prior.nodes), edges: new Map(prior.edges) }
    : {
        id: event.sessionId, key: sessionKey, parentSessionId: event.parentSessionId,
        project: event.project, projectKey: event.projectKey ?? stableProjectKey(event.project),
        host: event.host, status: 'unknown',
        nodes: new Map(), edges: new Map(), updatedAt: event.observedAt,
      };
  // Discovery sources can observe a thread before the authoritative state
  // ledger exposes its parent. Reconcile that later evidence instead of
  // leaving the thread permanently presented as a top-level session.
  if (event.parentSessionId) session.parentSessionId = event.parentSessionId;
  const priorNode = session.nodes.get(event.actor.id);
  const actorNode = nodeFrom(event.actor, event);
  if (priorNode) {
    actorNode.label ??= priorNode.label;
    if (!actorNode.role || (actorNode.role === 'worker' && priorNode.role !== 'worker')) {
      actorNode.role = priorNode.role;
    }
    // Identity evidence is retained: an event that carries no provider/model
    // claim is absence of evidence, not evidence the earlier claim is gone.
    if (!actorNode.provider && priorNode.provider) {
      actorNode.provider = priorNode.provider;
      actorNode.providerProvenance = priorNode.providerProvenance;
    }
    actorNode.model ??= priorNode.model;
  }
  if (event.target && event.action.endsWith('.completed')) {
    actorNode.status = priorNode?.status ?? 'running';
  }
  if (priorNode && event.status === 'unknown') actorNode.status = priorNode.status;
  if (priorNode && TERMINAL.has(priorNode.status) && !TERMINAL.has(actorNode.status)) {
    actorNode.status = priorNode.status;
  }
  session.nodes.set(event.actor.id, actorNode);
  if (event.project && event.project !== 'unknown') {
    session.project = event.project;
    session.projectKey = event.projectKey ?? stableProjectKey(event.project);
  }
  session.evidence = {
    ...(session.evidence ?? {}),
    ...Object.fromEntries(Object.entries(event.source.fields ?? {}).filter(([, value]) => value)),
  };
  if (event.actor.kind === 'session' && event.action.startsWith('session.')
    && !(TERMINAL.has(session.status) && !TERMINAL.has(event.status))) {
    session.status = event.status;
  }
  if (event.target) {
    const targetPrior = session.nodes.get(event.target.id);
    if (!targetPrior) {
      session.nodes.set(event.target.id, nodeFrom({
        id: event.target.id, kind: event.target.kind,
        label: event.target.label ?? event.attributes.toolCategory,
        role: event.target.role, provider: null, model: null,
      }, { ...event, status: event.action.endsWith('.completed') ? event.status : 'unknown' }));
    } else if (event.action.endsWith('.completed')) {
      session.nodes.set(event.target.id, {
        ...targetPrior,
        label: event.target.label ?? event.attributes.toolCategory ?? targetPrior.label,
        role: event.target.role ?? targetPrior.role,
        status: event.status,
        observedAt: event.observedAt,
        lastEventId: event.eventId ?? targetPrior.lastEventId,
        lastAction: event.action,
        sourceAdapter: event.source.adapter,
        confidence: event.source.confidence,
        durationMs: event.attributes.durationMs ?? targetPrior.durationMs,
        toolName: event.attributes.toolName ?? targetPrior.toolName,
      });
    }
    const edgeId = `${event.actor.id}|${event.action}|${event.target.id}`;
    session.edges.set(edgeId, {
      id: edgeId, source: event.actor.id, target: event.target.id,
      action: event.action, confidence: event.source.confidence,
      lastEventId: event.eventId ?? null,
    });
  }
  session.updatedAt = ['session.discovered', 'session.metadata'].includes(event.action)
    ? event.sourceTimestamp ?? prior?.updatedAt ?? event.observedAt
    : event.observedAt;
  // A state ledger proves identity/topology, but not that a process is live
  // now. Only fresh execution evidence with an explicit running status may
  // activate a session. Unknown/bootstrap evidence remains reviewable history.
  if (event.status === 'running' && event.source.adapter !== 'codex-state') {
    session.lifecycle = 'active';
  } else if (event.status === 'quiescent') {
    session.lifecycle = 'quiescent';
  } else {
    session.lifecycle ??= 'historical';
  }
  boundNodes(session, Math.max(1, maxNodesPerSession));
  sessions.set(sessionKey, session);
  boundSessions(sessions, Math.max(1, maxSessions), sessionKey);
  const seenEventIds = new Set(projection.seenEventIds);
  if (event.eventId) seenEventIds.add(event.eventId);
  while (seenEventIds.size > MAX_SEEN_EVENT_IDS) {
    seenEventIds.delete(seenEventIds.values().next().value);
  }
  return {
    schemaVersion: projection.schemaVersion,
    cursor: event.eventId ?? projection.cursor,
    sessions,
    seenEventIds,
  };
}

function boundNodes(session, limit) {
  while (session.nodes.size > limit) {
    const entries = [...session.nodes.entries()];
    const removable = entries.find(([, node]) => (
      RESOURCE_KINDS.has(node.kind) && TERMINAL.has(node.status)
    )) ?? entries.find(([, node]) => RESOURCE_KINDS.has(node.kind))
      ?? entries.find(([id, node]) => id !== session.id && node.kind !== 'gate');
    if (!removable) break;
    const [id] = removable;
    session.nodes.delete(id);
    for (const [edgeId, edge] of session.edges) {
      if (edge.source === id || edge.target === id) session.edges.delete(edgeId);
    }
  }
}

function boundSessions(sessions, limit, currentId) {
  while (sessions.size > limit) {
    const entries = [...sessions.entries()].filter(([id]) => id !== currentId);
    const removable = entries.find(([, session]) => TERMINAL.has(session.status))
      ?? entries.find(([, session]) => session.lifecycle === 'expired')
      ?? entries[0];
    if (!removable) break;
    sessions.delete(removable[0]);
  }
}

/** A started-but-unfinished resource means work is executing right now. */
function hasPendingResource(session) {
  for (const node of session.nodes.values()) {
    if (RESOURCE_KINDS.has(node.kind) && node.lastAction === 'tool.started'
      && !TERMINAL.has(node.status)) return true;
  }
  return false;
}

/** Mark inactivity without claiming that work completed. */
export function sweepLiveProjection(projection, {
  now = Date.now(), quiescentMs = 30_000, expiryMs = 300_000, pendingExpiryMs = 1_800_000,
} = {}) {
  const current = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(current)) return projection;
  let changed = false;
  const sessions = new Map(projection.sessions);
  for (const [id, prior] of sessions) {
    if (TERMINAL.has(prior.status) || prior.lifecycle === 'historical') continue;
    const age = Math.max(0, current - Date.parse(prior.updatedAt));
    // Transcripts only append when a tool call finishes, so a long-running
    // tool produces no events while it is the strongest liveness evidence
    // available. Hold such sessions active for a bounded pending window.
    const lifecycle = prior.status === 'quiescent' ? 'quiescent'
      : age < pendingExpiryMs && hasPendingResource(prior) ? 'active'
        : age >= expiryMs ? 'expired'
          : (age >= quiescentMs ? 'quiescent' : 'active');
    if (prior.lifecycle !== lifecycle) {
      sessions.set(id, { ...prior, lifecycle });
      changed = true;
    }
  }
  return changed ? { ...projection, sessions } : projection;
}

export function serializeLiveProjection(projection) {
  const sessions = withSessionHierarchy([...projection.sessions.values()].map((session) => ({
    ...session, nodes: [...session.nodes.values()], edges: [...session.edges.values()],
  })));
  return {
    schemaVersion: projection.schemaVersion,
    cursor: projection.cursor,
    sessions,
    projects: projectCatalog(sessions),
  };
}

function withSessionHierarchy(sessions) {
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  return sessions.map((session) => {
    const path = [];
    const seen = new Map();
    let current = session;
    let rootSessionKey = session.key;
    let hierarchyState = 'root';
    while (current.parentSessionId) {
      if (seen.has(current.key)) {
        const cycle = path.slice(seen.get(current.key)).sort();
        rootSessionKey = cycle[0] ?? session.key;
        hierarchyState = cycle.includes(session.key) ? 'cycle' : 'child';
        break;
      }
      seen.set(current.key, path.length);
      path.push(current.key);
      const parentKey = canonicalSessionKey(current.host, current.parentSessionId);
      const parent = byKey.get(parentKey);
      if (!parent) {
        rootSessionKey = current.key;
        hierarchyState = current.key === session.key ? 'orphan' : 'child';
        break;
      }
      current = parent;
      rootSessionKey = current.key;
      hierarchyState = 'child';
    }
    return {
      ...session,
      parentSessionKey: session.parentSessionId
        ? canonicalSessionKey(session.host, session.parentSessionId) : null,
      rootSessionKey,
      hierarchyState,
      navigationRoot: session.key === rootSessionKey,
    };
  });
}

function projectCatalog(sessions) {
  const projects = new Map();
  const sessionByKey = new Map(sessions.map((session) => [session.key, session]));
  const rootSessions = sessions.filter((session) => session.navigationRoot);
  for (const session of rootSessions) {
    const key = session.projectKey ?? stableProjectKey(session.project);
    const project = projects.get(key) ?? {
      id: key, label: session.project, sessions: [], sessionCount: 0,
      childSessionCount: 0, liveCount: 0, completedCount: 0,
      hosts: {}, providers: {}, updatedAt: session.updatedAt,
    };
    project.sessions.push(session.key);
    project.sessionCount++;
    if (TERMINAL.has(session.status)) project.completedCount++;
    else if (session.status === 'running' && session.lifecycle === 'active') project.liveCount++;
    project.hosts[session.host] = (project.hosts[session.host] ?? 0) + 1;
    const providers = new Set(session.nodes.map((node) => node.provider).filter(Boolean));
    if (providers.size === 0) providers.add('unknown');
    for (const provider of providers) {
      project.providers[provider] = (project.providers[provider] ?? 0) + 1;
    }
    if (Date.parse(session.updatedAt) > Date.parse(project.updatedAt)) {
      project.updatedAt = session.updatedAt;
    }
    projects.set(key, project);
  }
  for (const child of sessions.filter((session) => !session.navigationRoot)) {
    const key = child.projectKey ?? stableProjectKey(child.project);
    const project = projects.get(key);
    if (project) project.childSessionCount++;
  }
  for (const project of projects.values()) {
    project.sessions.sort((a, b) => {
      const left = sessionByKey.get(a);
      const right = sessionByKey.get(b);
      const leftLive = left.status === 'running' && left.lifecycle === 'active';
      const rightLive = right.status === 'running' && right.lifecycle === 'active';
      return Number(rightLive) - Number(leftLive)
        || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        || a.localeCompare(b);
    });
    project.hosts = Object.fromEntries(Object.entries(project.hosts).sort());
    project.providers = Object.fromEntries(Object.entries(project.providers).sort());
  }
  return [...projects.values()].sort((a, b) => (
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)
  ));
}
import { canonicalSessionKey, stableProjectKey } from './project-label.mjs';
