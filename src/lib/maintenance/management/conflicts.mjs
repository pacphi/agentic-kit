// ADR-0048 conflict classification (domain-model.md "ConflictSet"). Every
// classification explains a relationship the evidence establishes; none of
// them grants ownership or deletion authority (invariant 6). Pure over an
// already-assembled inventory — no filesystem or process access, and no new
// evidence is invented here: a conflict fires only from fields the inventory
// already carries as verified.
import { CONFLICT_EXPLANATIONS } from './model.mjs';
import { conflictIdentity } from './identity.mjs';

function makeConflict(kind, placementIds, installationKey, extra = {}) {
  const explanation = CONFLICT_EXPLANATIONS[kind];
  const unique = [...new Set(placementIds)];
  return {
    conflictId: conflictIdentity({ kind, placementIds: unique, artifactIds: extra.artifactIds ?? null }, installationKey),
    kind,
    placementIds: unique,
    ...extra,
    proves: explanation.proves,
    doesNotProve: explanation.doesNotProve,
  };
}

/**
 * One artifactId referenced by 2+ CONSUMER BINDINGS — the J2 contract: "one
 * artifact, one placement, two bindings" IS a shared-artifact set (one
 * placement, both its bindings on that one artifact), and so is one artifact
 * reached by two separate placements' bindings. Never keyed on placement
 * count alone (a single placement's two bindings on its own one artifact is
 * not "two placements", but it is still two consumers of one carrier) and
 * never on digest (that is `duplicate-placement`'s signal, not this one's).
 * `artifactIds` names exactly that one artifact; `consumerBindingIds` names
 * every binding counted, so the set's own evidence is inspectable.
 */
function sharedArtifactGroups(consumerBindings) {
  const byArtifact = new Map();
  for (const binding of consumerBindings) {
    if (!binding.artifactId) continue;
    if (!byArtifact.has(binding.artifactId)) {
      byArtifact.set(binding.artifactId, { placementIds: new Set(), bindingIds: new Set() });
    }
    const entry = byArtifact.get(binding.artifactId);
    if (binding.placementId) entry.placementIds.add(binding.placementId);
    if (binding.bindingId) entry.bindingIds.add(binding.bindingId);
  }
  const groups = [];
  for (const [artifactId, entry] of byArtifact) {
    if (entry.bindingIds.size < 2) continue;
    groups.push({
      artifactId, placementIds: [...entry.placementIds], consumerBindingIds: [...entry.bindingIds],
    });
  }
  return groups;
}

/**
 * Two or more placements of the same kind whose verified content digest is
 * equal AND which are backed by at least two DISTINCT artifacts — a group
 * whose members all reduce to one single physical artifact is
 * `shared-artifact`'s evidence, not a duplicate (there is no second copy to
 * be a duplicate OF). Placements already named in a `shared-artifact` set
 * are NOT excluded here: a user-scope skill can be both shared by two hosts
 * (one artifact, one placement) and separately duplicated into a project
 * (a second, different artifact, equal content) — those are two different
 * member lists describing two different facts, and both are stated.
 * `classifyConflicts` still guarantees no two DIFFERENT kinds ever share one
 * EXACT member list.
 */
function duplicatePlacementGroups(placements) {
  const byDigest = new Map();
  for (const placement of placements) {
    const digest = placement.versions?.contentDigest;
    if (!digest) continue;
    const key = `${placement.kind} ${digest}`;
    if (!byDigest.has(key)) byDigest.set(key, []);
    byDigest.get(key).push(placement);
  }
  const groups = [];
  for (const members of byDigest.values()) {
    if (members.length < 2) continue;
    const distinctArtifacts = new Set(members.flatMap((p) => p.artifactIds ?? []));
    if (distinctArtifacts.size < 2) continue;
    groups.push(members.map((p) => p.placementId));
  }
  return groups;
}

function sameNameDifferentDefinitionGroups(placements) {
  const groups = new Map();
  for (const placement of placements) {
    const digest = placement.versions?.contentDigest;
    if (!digest || !placement.displayName) continue;
    const key = `${placement.kind} ${placement.displayName.trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(placement);
  }
  return [...groups.values()].filter((group) => (
    group.length > 1 && new Set(group.map((p) => p.versions.contentDigest)).size > 1
  ));
}

/** Precedence known to hold for exactly one verified host: a project-scope
 *  placement resolves before a user-scope one, which resolves before a
 *  machine- or system-scope one, for the kinds a host resolves by nearest
 *  scope. Cross-host precedence is never inferred. */
const SCOPE_RANK = Object.freeze({ system: 0, machine: 1, user: 2, project: 3 });
const SHADOW_ELIGIBLE_KINDS = new Set([
  'skill', 'instruction-context-file', 'mcp-registration', 'hook', 'command-prompt', 'agent',
]);

function shadowGroups(placements) {
  const groups = new Map();
  for (const placement of placements) {
    if (!SHADOW_ELIGIBLE_KINDS.has(placement.kind) || placement.consumerHosts?.length !== 1) continue;
    const key = `${placement.kind} ${placement.consumerHosts[0]} ${placement.displayName.trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(placement);
  }
  return [...groups.values()].filter((group) => (
    group.length > 1 && new Set(group.map((p) => p.administrativeScope)).size > 1
  ));
}

const TRANSPORT_ELIGIBLE_KIND = 'mcp-registration';

function transportGroups(placements) {
  const groups = new Map();
  for (const placement of placements) {
    if (placement.kind !== TRANSPORT_ELIGIBLE_KIND || !placement.transportKey) continue;
    if (!groups.has(placement.transportKey)) groups.set(placement.transportKey, []);
    groups.get(placement.transportKey).push(placement.placementId);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

const REQUIREMENT_DEPENDENCY_KINDS = new Set(['requires-runtime', 'requires-executable', 'requires-provider']);

function versionDivergenceGroups(edges) {
  const byTarget = new Map();
  for (const edge of edges) {
    if (!REQUIREMENT_DEPENDENCY_KINDS.has(edge.kind) || !edge.requirement) continue;
    if (!byTarget.has(edge.toId)) byTarget.set(edge.toId, new Map());
    const byRequirement = byTarget.get(edge.toId);
    if (!byRequirement.has(edge.requirement)) byRequirement.set(edge.requirement, []);
    byRequirement.get(edge.requirement).push(edge.fromPlacementId);
  }
  const groups = [];
  for (const byRequirement of byTarget.values()) {
    if (byRequirement.size < 2) continue;
    const placementIds = [...new Set([...byRequirement.values()].flat())];
    if (placementIds.length > 1) groups.push(placementIds);
  }
  return groups;
}

function collisionPairs(edges, placementIds) {
  const pairs = [];
  for (const edge of edges) {
    if (!edge.declaredToId || edge.declaredToId === edge.toId) continue;
    if (!placementIds.has(edge.toId) || !placementIds.has(edge.fromPlacementId)) continue;
    pairs.push([edge.fromPlacementId, edge.toId]);
  }
  return pairs;
}

/** A member-list key independent of ordering, so two groups naming the same
 *  placements compare equal regardless of how each classifier produced them. */
function memberKey(placementIds) {
  return [...new Set(placementIds)].sort().join(',');
}

/**
 * Classify every conflict the evidence in `inventory` establishes. Returns a
 * `ConflictSet[]` covering all seven ADR-0048 conflict kinds; a kind with no
 * qualifying evidence simply contributes no rows. No two DIFFERENT kinds
 * ever share one EXACT member list — the second classifier to reach an
 * already-claimed member list is skipped rather than emitting a redundant
 * set — though the SAME placement may legitimately appear across several
 * conflicts with DIFFERENT member lists (a shared skill's placement can be
 * both `shared-artifact` on its own and part of a larger `duplicate-placement`
 * set with a project copy).
 *
 * @param {{ placements?: Array<*>, dependencyEdges?: Array<*>, consumerBindings?: Array<*> }} inventory
 *   a ManagementInventory (or an equivalent partial shape carrying
 *   `placements`, `dependencyEdges`, and `consumerBindings`)
 * @param {{ installationKey: string }} options
 */
export function classifyConflicts(inventory, { installationKey }) {
  const placements = inventory?.placements ?? [];
  const edges = inventory?.dependencyEdges ?? [];
  const consumerBindings = inventory?.consumerBindings ?? [];
  const placementIds = new Set(placements.map((p) => p.placementId));
  const conflicts = [];
  const claimed = new Map();
  const emit = (kind, memberPlacementIds, extra) => {
    const key = memberKey(memberPlacementIds);
    const existingKind = claimed.get(key);
    if (existingKind && existingKind !== kind) return;
    claimed.set(key, kind);
    conflicts.push(makeConflict(kind, memberPlacementIds, installationKey, extra));
  };

  for (const group of sharedArtifactGroups(consumerBindings)) {
    emit('shared-artifact', group.placementIds, {
      artifactIds: [group.artifactId], consumerBindingIds: group.consumerBindingIds,
    });
  }
  for (const group of duplicatePlacementGroups(placements)) {
    emit('duplicate-placement', group);
  }
  for (const group of sameNameDifferentDefinitionGroups(placements)) {
    emit('same-name-different-definition', group.map((p) => p.placementId));
  }
  for (const group of transportGroups(placements)) {
    emit('equivalent-transport-registration', group);
  }
  for (const group of shadowGroups(placements)) {
    const sorted = [...group].sort((a, b) => SCOPE_RANK[b.administrativeScope] - SCOPE_RANK[a.administrativeScope]);
    emit('shadowed-override', sorted.map((p) => p.placementId));
  }
  for (const group of versionDivergenceGroups(edges)) {
    emit('version-requirement-divergence', group);
  }
  for (const [fromId, toId] of collisionPairs(edges, placementIds)) {
    emit('dependency-resolution-collision', [fromId, toId]);
  }
  return conflicts;
}
