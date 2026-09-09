// ADR-0048 dependency graph (domain-model.md "DependencyEdge"). Pure over an
// already-assembled inventory or edge descriptor list — no filesystem or
// process access. Traversal is cycle-safe by visited-node bounds (invariant
// 12 / MNT non-negotiable #9): a cycle is rendered as a fact, never expanded
// into a recursive action.
import { DEPENDENCY_KINDS } from './model.mjs';
import { edgeIdentity } from './identity.mjs';

/**
 * Turn bounded edge descriptors into validated, identified DependencyEdge
 * rows. Identical descriptors (same fromPlacementId/toId/kind/requirement)
 * collapse to one edge, so a mapping helper may describe the same
 * relationship more than once without producing duplicates.
 *
 * @param {{ descriptors: Array<{ fromPlacementId: string, toId: string, kind: string,
 *           requirement?: string|null, environmentRelation?: string|null,
 *           grade?: string, authority?: string|null, satisfied?: boolean,
 *           declaredToId?: string|null }>, installationKey: string }} input
 *   `declaredToId`, when supplied and different from `toId`, records that the
 *   placement declared one target while resolution actually selected another
 *   — the raw signal `conflicts.mjs` turns into a dependency-resolution-collision.
 */
export function deriveDependencyEdges({ descriptors = [], installationKey }) {
  const seen = new Set();
  const edges = [];
  for (const descriptor of descriptors) {
    if (!DEPENDENCY_KINDS.includes(descriptor.kind)) {
      throw new TypeError(`deriveDependencyEdges: unknown dependency kind ${String(descriptor.kind)}`);
    }
    if (!descriptor.fromPlacementId || !descriptor.toId) {
      throw new TypeError('deriveDependencyEdges: fromPlacementId and toId are required');
    }
    const edgeId = edgeIdentity({
      fromPlacementId: descriptor.fromPlacementId, toId: descriptor.toId, kind: descriptor.kind,
      requirement: descriptor.requirement ?? null,
    }, installationKey);
    if (seen.has(edgeId)) continue;
    seen.add(edgeId);
    edges.push({
      edgeId,
      fromPlacementId: descriptor.fromPlacementId,
      toId: descriptor.toId,
      kind: descriptor.kind,
      grade: descriptor.grade ?? 'verified',
      authority: descriptor.authority ?? null,
      ...(descriptor.requirement != null ? { requirement: descriptor.requirement } : {}),
      ...(descriptor.environmentRelation != null ? { environmentRelation: descriptor.environmentRelation } : {}),
      ...(typeof descriptor.satisfied === 'boolean' ? { satisfied: descriptor.satisfied } : {}),
      ...(descriptor.declaredToId != null ? { declaredToId: descriptor.declaredToId } : {}),
    });
  }
  return edges;
}

/** Edges whose `toId` names this id — the reverse-dependency view. */
export function reverseDependencies(inventory, id) {
  return (inventory?.dependencyEdges ?? []).filter((edge) => edge.toId === id);
}

function edgeIndex(edges) {
  const byFrom = new Map();
  const byTo = new Map();
  for (const edge of edges) {
    if (!byFrom.has(edge.fromPlacementId)) byFrom.set(edge.fromPlacementId, []);
    byFrom.get(edge.fromPlacementId).push(edge);
    if (!byTo.has(edge.toId)) byTo.set(edge.toId, []);
    byTo.get(edge.toId).push(edge);
  }
  return { byFrom, byTo };
}

/**
 * Bounded breadth-first traversal from `startId` over an inventory's
 * dependency edges. `direction: 'forward'` follows what the start depends on;
 * `'backward'` follows what depends on the start. Stops at `maxVisited`
 * edges and reports `truncated: true` rather than growing without bound; a
 * revisited node is reported once in `cycles` and not re-expanded.
 *
 * @returns {{ visited: Array<{ edge: *, from: string, to: string }>,
 *             cycles: Array<{ edgeId: string, at: string }>, truncated: boolean }}
 */
export function traverseDependencies(inventory, startId, {
  maxVisited = 10_000, direction = 'forward',
} = {}) {
  const { byFrom, byTo } = edgeIndex(inventory?.dependencyEdges ?? []);
  const neighborsOf = (id) => (direction === 'forward' ? byFrom.get(id) : byTo.get(id)) ?? [];
  const visited = [];
  const cycles = [];
  const seen = new Set([startId]);
  const queue = [startId];
  let truncated = false;
  while (queue.length) {
    if (visited.length >= maxVisited) { truncated = true; break; }
    const current = queue.shift();
    for (const edge of neighborsOf(current)) {
      if (visited.length >= maxVisited) { truncated = true; break; }
      const nextId = direction === 'forward' ? edge.toId : edge.fromPlacementId;
      visited.push({ edge, from: current, to: nextId });
      if (seen.has(nextId)) { cycles.push({ edgeId: edge.edgeId, at: nextId }); continue; }
      seen.add(nextId);
      queue.push(nextId);
    }
  }
  return { visited, cycles, truncated };
}

/** A structured dependency list for one placement, suitable for a
 *  disclosure-style UI list (MNT-UX-011) rather than a rendered graph. */
export function dependencyGraphList(inventory, placementId, { maxVisited = 10_000 } = {}) {
  const forward = traverseDependencies(inventory, placementId, { direction: 'forward', maxVisited });
  const backward = traverseDependencies(inventory, placementId, { direction: 'backward', maxVisited });
  return {
    placementId,
    dependsOn: forward.visited.map(({ edge, to }) => ({ edgeId: edge.edgeId, kind: edge.kind, toId: to })),
    dependedOnBy: backward.visited.map(({ edge, to }) => ({ edgeId: edge.edgeId, kind: edge.kind, fromPlacementId: to })),
    cycles: [...forward.cycles, ...backward.cycles],
    truncated: forward.truncated || backward.truncated,
  };
}
