function nodeFrom(actor, event) {
  return {
    id: actor.id, kind: actor.kind, label: actor.label, role: actor.role, provider: actor.provider,
    providerProvenance: actor.provider ? event.providerProvenance : 'unknown',
    model: actor.model, host: actor.host ?? event.host, surface: event.surface,
    status: event.status, lastEventId: event.eventId ?? null,
    observedAt: event.observedAt, confidence: event.source.confidence,
    sourceAdapter: event.source.adapter, lastAction: event.action,
    durationMs: event.attributes.durationMs, toolName: event.attributes.toolName,
    evidence: event.source.fields, lastSignal: event.signal ?? null,
  };
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const PROVIDER_EVIDENCE_RANK = new Map([
  ['unknown', 0], ['inferred', 1], ['configured', 2], ['observed', 3],
]);
const MAX_SEEN_EVENT_IDS = 10_000;
const RESOURCE_KINDS = new Set(['tool', 'skill', 'plugin', 'mcp']);

// Falls back to the SAME inference createLiveEvent uses to stamp signal.kind
// in the first place (event-schema.mjs's inferredSignal) — not a second,
// independently-maintained guess. createLiveEvent always stamps signal.kind
// today, so this fallback is a defensive no-op in practice; it exists so an
// event that somehow arrives unstamped still gets the right answer instead of
// a hardcoded 'metadata'.
const signalKind = (event) => event.signal?.kind ?? inferredSignal(event.action, event.status).kind;

function presenceFrom(event) {
  if (signalKind(event) !== 'presence') return null;
  return {
    state: event.status === 'quiescent' ? 'absent' : 'present',
    lastObservedAt: event.observedAt,
    evidence: event.source?.confidence ?? 'unknown',
  };
}

function activityFrom(event) {
  if (!['activity', 'operation'].includes(signalKind(event))) return null;
  const phase = event.signal?.phase;
  const working = event.status === 'running'
    && !['completed', 'failed', 'cancelled'].includes(phase);
  return {
    state: working ? 'working' : 'idle',
    lastActivityAt: event.observedAt,
    currentOperationId: working && signalKind(event) === 'operation'
      ? event.target?.id ?? null : null,
    evidence: event.source?.confidence ?? 'unknown',
  };
}

function mergeWorkspace(prior, incoming) {
  if (!incoming) return prior ?? null;
  if (!prior) return incoming;
  const priorRank = PROVIDER_EVIDENCE_RANK.get(prior.confidence) ?? 0;
  const incomingRank = PROVIDER_EVIDENCE_RANK.get(incoming.confidence) ?? 0;
  const priorAt = Date.parse(prior.capturedAt ?? '');
  const incomingAt = Date.parse(incoming.capturedAt ?? '');
  const preferred = incomingRank > priorRank
    || (incomingRank === priorRank && incomingAt >= priorAt);
  const next = { ...prior };
  for (const field of [
    'key', 'repositoryLabel', 'directoryLabel', 'branchLabel', 'branchState',
    'changes', 'source', 'confidence',
  ]) {
    if (incoming[field] != null && (preferred || next[field] == null)) next[field] = incoming[field];
  }
  if (!Number.isFinite(priorAt) || incomingAt >= priorAt) next.capturedAt = incoming.capturedAt;
  return next;
}

export function emptyLiveProjection() {
  return { schemaVersion: 2, cursor: null, sessions: new Map(), seenEventIds: new Set() };
}

/** Get the session this event belongs to — a deep-enough clone of the prior
 *  one (nodes/edges get their own Map so snapshot readers never observe a
 *  half-applied event), or a fresh one seeded from the event itself. */
function cloneOrCreateSession(prior, sessionKey, event) {
  if (prior) return { ...prior, nodes: new Map(prior.nodes), edges: new Map(prior.edges) };
  const metadataOnly = ['session.discovered', 'session.metadata'].includes(event.action);
  const initialUpdatedAt = metadataOnly
    ? event.sourceTimestamp ?? '1970-01-01T00:00:00.000Z' : event.observedAt;
  return {
    id: event.sessionId, key: sessionKey, parentSessionId: event.parentSessionId,
    project: event.project, projectKey: event.projectKey ?? stableProjectKey(event.project),
    host: event.host, status: 'unknown',
    presence: { state: 'unknown', lastObservedAt: null, evidence: 'unknown' },
    activity: {
      state: 'unknown', lastActivityAt: null, currentOperationId: null, evidence: 'unknown',
    },
    workspace: null,
    nodes: new Map(), edges: new Map(), updatedAt: initialUpdatedAt,
  };
}

/** Merge this event's actor into the session's node map: preserve identity
 *  evidence (label/role/provider/model) a later event doesn't repeat, refuse
 *  to let a heartbeat masquerade as semantic work, and never let a target
 *  completion, an unknown-status event, or a state ledger regress a node out
 *  of its terminal status. Mutates session.nodes. */
function mergeActorNode(session, event) {
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
    } else if (actorNode.provider && priorNode.provider
      && (PROVIDER_EVIDENCE_RANK.get(priorNode.providerProvenance) ?? 0)
        > (PROVIDER_EVIDENCE_RANK.get(actorNode.providerProvenance) ?? 0)) {
      // Presence polling may add configured/inferred identity, but it must not
      // overwrite a stronger provider claim already observed in source data.
      actorNode.provider = priorNode.provider;
      actorNode.providerProvenance = priorNode.providerProvenance;
    }
    actorNode.model ??= priorNode.model;
    if (signalKind(event) === 'presence') {
      // A controller lease proves existence, not semantic work. Preserve the
      // actor's last real activity so a heartbeat cannot masquerade as work.
      actorNode.status = priorNode.status;
      actorNode.lastAction = priorNode.lastAction;
      actorNode.observedAt = priorNode.observedAt;
      actorNode.lastEventId = priorNode.lastEventId;
      actorNode.sourceAdapter = priorNode.sourceAdapter;
      actorNode.confidence = priorNode.confidence;
      actorNode.lastSignal = priorNode.lastSignal;
    }
  }
  if (event.target && event.action.endsWith('.completed')) {
    actorNode.status = priorNode?.status ?? 'running';
  }
  if (priorNode && event.status === 'unknown') actorNode.status = priorNode.status;
  if (priorNode && TERMINAL.has(priorNode.status) && !TERMINAL.has(actorNode.status)) {
    actorNode.status = priorNode.status;
  }
  session.nodes.set(event.actor.id, actorNode);
}

/** Update session-level status evidence: presence, activity, workspace,
 *  project identity, accumulated field-evidence, and session status. Reads
 *  only `event` and the session's own prior status — independent of
 *  mergeActorNode/applyTarget, which own nodes/edges, so their relative
 *  order does not affect the result. */
function applyStatus(session, event) {
  const presence = presenceFrom(event);
  if (presence) session.presence = presence;
  const activity = activityFrom(event);
  if (activity && event.source.adapter !== 'codex-state') session.activity = activity;
  session.workspace = mergeWorkspace(session.workspace, event.workspace);
  if (event.project && event.project !== 'unknown') {
    session.project = event.project;
    session.projectKey = event.projectKey ?? stableProjectKey(event.project);
  }
  session.evidence = {
    ...(session.evidence ?? {}),
    ...Object.fromEntries(Object.entries(event.source.fields ?? {}).filter(([, value]) => value)),
  };
  if (signalKind(event) !== 'presence' && event.actor.kind === 'session'
    && event.action.startsWith('session.')
    && !(TERMINAL.has(session.status) && !TERMINAL.has(event.status))) {
    session.status = event.status;
  }
}

/** Create or update the event's target node (a tool/skill/subagent/etc.) and
 *  the actor->target relationship edge it implies. No-op when the event
 *  carries no target. Runs after mergeActorNode: a target lookup that
 *  happens to collide with the actor's own id sees the node mergeActorNode
 *  just wrote, matching the original inline ordering. */
function applyTarget(session, event) {
  if (!event.target) return;
  const targetPrior = session.nodes.get(event.target.id);
  if (!targetPrior) {
    session.nodes.set(event.target.id, nodeFrom({
      id: event.target.id, kind: event.target.kind,
      label: event.target.label ?? event.attributes.toolCategory,
      role: event.target.role, host: event.target.host, provider: null, model: null,
    }, {
      ...event,
      status: event.action.endsWith('.completed') ? event.status
        : (event.signal?.kind === 'operation' && event.signal.phase === 'started'
            ? 'running' : 'unknown'),
    }));
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
      lastSignal: event.signal ?? targetPrior.lastSignal,
      durationMs: event.attributes.durationMs ?? targetPrior.durationMs,
      toolName: event.attributes.toolName ?? targetPrior.toolName,
    });
  }
  const edgeId = `${event.actor.id}|${event.action}|${event.target.id}`;
  session.edges.set(edgeId, {
    id: edgeId, source: event.actor.id, target: event.target.id,
    action: event.action, confidence: event.source.confidence,
    lastEventId: event.eventId ?? null, observedAt: event.observedAt,
    signal: event.signal ?? null, status: event.status,
  });
}

/** A source-timed event (a state ledger, or metadata/relationship/discovery
 *  evidence) is dated by ITS OWN evidence, not by when this process observed
 *  it — a replayed or backfilled record must not appear newer than a
 *  session's real last activity. Everything else is dated by observedAt.
 *  Never regresses: a later-arriving but older-dated event keeps the
 *  session's existing updatedAt. `prior` is the session BEFORE cloning —
 *  identical to session.updatedAt at this point, but named for clarity. */
function resolveUpdatedAt(session, event, prior) {
  const sourceTimed = event.source.adapter === 'codex-state'
    || ['metadata', 'relationship'].includes(signalKind(event))
    || ['session.discovered', 'session.metadata'].includes(event.action);
  const candidateUpdatedAt = sourceTimed
    ? event.sourceTimestamp ?? prior?.updatedAt ?? session.updatedAt
    : event.observedAt;
  session.updatedAt = prior && Date.parse(prior.updatedAt) > Date.parse(candidateUpdatedAt)
    ? prior.updatedAt : candidateUpdatedAt;
}

/** A state ledger proves identity/topology, but not that a process is live
 *  now. Only fresh execution evidence with an explicit running status may
 *  activate a session. Unknown/bootstrap evidence remains reviewable history. */
function applyLifecycle(session, event) {
  if (event.status === 'running' && event.source.adapter !== 'codex-state') {
    session.lifecycle = 'active';
  } else if (event.status === 'quiescent') {
    session.lifecycle = 'quiescent';
  } else {
    session.lifecycle ??= 'historical';
  }
}

/** Immutable reducer so snapshot readers never observe a half-applied event.
 *  Each phase below owns a disjoint slice of the session it mutates — actor
 *  nodes, session-level status, the target node/edge, updatedAt, lifecycle —
 *  so their order matters only where a later phase reads an earlier one's
 *  output (applyTarget after mergeActorNode; resolveUpdatedAt/applyLifecycle
 *  last, since both read status/timestamps the earlier phases finalize). */
export function reduceLiveEvent(projection, event, {
  maxSessions = 100, maxNodesPerSession = 1000,
} = {}) {
  if (event.eventId && projection.seenEventIds?.has(event.eventId)) return projection;
  const sessions = new Map(projection.sessions);
  const sessionKey = event.sessionKey ?? canonicalSessionKey(event.host, event.sessionId);
  const prior = sessions.get(sessionKey);
  const session = cloneOrCreateSession(prior, sessionKey, event);
  // Discovery sources can observe a thread before the authoritative state
  // ledger exposes its parent. Reconcile that later evidence instead of
  // leaving the thread permanently presented as a top-level session.
  if (event.parentSessionId) session.parentSessionId = event.parentSessionId;

  mergeActorNode(session, event);
  applyStatus(session, event);
  applyTarget(session, event);
  resolveUpdatedAt(session, event, prior);
  applyLifecycle(session, event);

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
    const entries = [...sessions.entries()].filter(([id]) => id !== currentId)
      .sort((left, right) => Date.parse(left[1].updatedAt ?? 0)
        - Date.parse(right[1].updatedAt ?? 0));
    const removable = entries.find(([, session]) => TERMINAL.has(session.status))
      ?? entries.find(([, session]) => session.lifecycle === 'expired')
      ?? entries.find(([, session]) => session.presence?.state !== 'present'
        && session.activity?.state !== 'working')
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
    const lifecycle = prior.presence?.state === 'absent' || prior.status === 'quiescent'
      ? 'quiescent'
      : age < pendingExpiryMs && hasPendingResource(prior) ? 'active'
        : age >= expiryMs ? 'expired'
          : (age >= quiescentMs ? 'quiescent' : 'active');
    const lastActivity = Date.parse(prior.activity?.lastActivityAt ?? '');
    const activityState = lifecycle === 'active' && (hasPendingResource(prior)
      || (Number.isFinite(lastActivity) && current - lastActivity < quiescentMs))
      ? 'working' : (prior.activity?.state === 'unknown' ? 'unknown' : 'idle');
    if (prior.lifecycle !== lifecycle || prior.activity?.state !== activityState) {
      sessions.set(id, {
        ...prior,
        lifecycle,
        activity: {
          ...(prior.activity ?? {}),
          state: activityState,
          currentOperationId: activityState === 'working'
            ? prior.activity?.currentOperationId ?? null : null,
        },
      });
      changed = true;
    }
  }
  return changed ? { ...projection, sessions } : projection;
}

export function serializeLiveProjection(projection) {
  const hierarchy = withSessionHierarchy([...projection.sessions.values()].map((session) => ({
    ...session, nodes: [...session.nodes.values()], edges: [...session.edges.values()],
  })));
  const childParents = new Set(hierarchy.filter((session) => session.parentSessionKey)
    .map((session) => session.parentSessionKey));
  const sessions = hierarchy.map((session) => withCoverage(session, childParents));
  return {
    schemaVersion: projection.schemaVersion,
    cursor: projection.cursor,
    sessions,
    projects: projectCatalog(sessions),
  };
}

function withCoverage(session, childParents) {
  const adapters = new Set(session.nodes.map((node) => node.sourceAdapter).filter(Boolean));
  const detailed = adapters.has('claude-transcript') || adapters.has('codex-rollout');
  const embeddedActors = session.nodes.some((node) => ['agent', 'subagent'].includes(node.kind)
    && node.id !== session.id);
  const childSessions = childParents.has(session.key) || Boolean(session.parentSessionId);
  const hierarchyConfidence = session.edges
    .filter((edge) => ['agent.spawned', 'agent.delegated', 'contains'].includes(edge.action))
    .map((edge) => edge.confidence).find(Boolean);
  const providerNode = session.nodes.find((node) => node.provider);
  const limitations = [];
  if (!detailed) limitations.push('detailed-activity-not-reported');
  if (!childSessions && !embeddedActors) limitations.push('worker-hierarchy-not-reported');
  if (embeddedActors && !childSessions) limitations.push('workers-embedded-in-parent-session');
  return {
    ...session,
    coverage: {
      presence: session.presence?.state !== 'unknown' ? 'observed' : 'unavailable',
      activity: detailed ? 'events' : (session.presence?.state !== 'unknown'
        ? 'presence-only' : 'unavailable'),
      actors: childSessions ? 'child-sessions'
        : (embeddedActors ? 'embedded-actors' : 'unavailable'),
      resources: detailed ? 'lifecycle' : 'unavailable',
      hierarchy: childSessions ? (hierarchyConfidence ?? 'observed')
        : (embeddedActors ? (hierarchyConfidence ?? 'correlated') : 'unavailable'),
      transcript: detailed ? 'session' : 'unavailable',
      playback: detailed ? 'session' : 'unavailable',
      providerIdentity: providerNode?.providerProvenance ?? 'unavailable',
      workspaceIdentity: session.workspace?.directoryLabel ? 'available' : 'unavailable',
      gitBranch: session.workspace?.branchLabel ? 'available' : 'unavailable',
      gitChanges: session.workspace?.changes ? 'available' : 'unavailable',
    },
    limitations,
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
      childSessionCount: 0, liveCount: 0, presentCount: 0, workingCount: 0,
      completedCount: 0,
      hosts: {}, providers: {}, updatedAt: session.updatedAt,
    };
    project.sessions.push(session.key);
    project.sessionCount++;
    const present = session.presence?.state === 'present';
    const working = session.activity?.state === 'working';
    if (TERMINAL.has(session.status)) project.completedCount++;
    else if (present || working) project.liveCount++;
    if (present) project.presentCount++;
    if (working) project.workingCount++;
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
      const leftLive = left.presence?.state === 'present' || left.activity?.state === 'working';
      const rightLive = right.presence?.state === 'present' || right.activity?.state === 'working';
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
import { inferredSignal } from './event-schema.mjs';
