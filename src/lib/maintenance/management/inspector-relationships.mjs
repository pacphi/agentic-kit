// Path-free links over recorded inventory identities. A similar name, folder,
// or shared consumer never establishes ownership, a dependency, or precedence.
const LIMIT = 200;
const REQUIREMENT_KINDS = new Set(['requires-executable', 'requires-runtime', 'requires-provider', 'requires-credential']);

function target(placement) {
  return {
    placementId: placement.placementId, displayName: placement.displayName,
    kind: placement.kind, scope: placement.administrativeScope,
    ...(placement.projectId ? { projectId: placement.projectId } : {}),
    consumerHosts: [...(placement.consumerHosts ?? [])],
  };
}

function verifiedProvenance(entry) {
  return entry.field === 'provenance' && entry.grade === 'verified'
    && entry.freshness === 'fresh' && entry.completeness === 'complete';
}

function sameContext(a, b) {
  return a.environmentId === b.environmentId && a.administrativeScope === b.administrativeScope
    && (a.projectId ?? null) === (b.projectId ?? null)
    && (a.consumerHosts ?? []).some((host) => (b.consumerHosts ?? []).includes(host));
}

function pluginReference(plugin, namespace) {
  const name = plugin.displayName;
  if (!namespace || namespace === name || name.endsWith(`@${namespace}`)) return name;
  if (namespace.startsWith(`${name}@`)) return namespace;
  // A full reference naming a different plugin is not this plugin's identity.
  if (namespace.includes('@')) return null;
  return `${name}@${namespace}`;
}

function parentResolver(inventory, resources) {
  const refs = new Map();
  for (const plugin of inventory.placements.filter((row) => row.kind === 'plugin')) {
    const namespace = resources.get(plugin.resourceId)?.namespace;
    const ref = pluginReference(plugin, namespace);
    if (!ref) continue;
    if (!refs.has(ref)) refs.set(ref, []);
    refs.get(ref).push(plugin);
  }
  const proven = new Map();
  for (const entry of inventory.provenanceAssertions ?? []) {
    if (!verifiedProvenance(entry) || entry.value?.kind !== 'plugin-marketplace') continue;
    if (!proven.has(entry.subjectId)) proven.set(entry.subjectId, new Set());
    proven.get(entry.subjectId).add(entry.value.label);
  }
  return (placement) => {
    if (placement.kind === 'plugin') return [];
    const namespace = resources.get(placement.resourceId)?.namespace;
    if (!namespace || !proven.get(placement.placementId)?.has(namespace)) return [];
    const parents = (refs.get(namespace) ?? []).filter((candidate) => sameContext(candidate, placement));
    // Ambiguous placement resolution must not guess an exact installation.
    return parents.length === 1 ? parents : [];
  };
}

function edgeRow(edge, placements) {
  const exact = placements.get(edge.toId);
  return {
    edgeId: edge.edgeId, kind: edge.kind,
    ...(edge.requirement ? { requirement: edge.requirement } : {}),
    ...(typeof edge.satisfied === 'boolean' ? { satisfied: edge.satisfied } : {}),
    ...(exact ? { target: target(exact) } : {}),
  };
}

export function inspectorRelationships(inventory, placement) {
  const placements = new Map(inventory.placements.map((row) => [row.placementId, row]));
  const resources = new Map(inventory.resources.map((row) => [row.resourceId, row]));
  const pluginParents = parentResolver(inventory, resources);
  const family = (row) => resources.get(row.resourceId)?.presentationFamilyId ?? row.resourceId;
  const edges = (inventory.dependencyEdges ?? []).filter((edge) => edge.grade === 'verified' && REQUIREMENT_KINDS.has(edge.kind));
  const result = {
    consumers: (inventory.consumerBindings ?? []).filter((binding) => binding.placementId === placement.placementId
      && (placement.consumerBindingIds ?? []).includes(binding.bindingId) && binding.grade === 'verified')
      .map((binding) => ({ label: binding.consumerLabel, kind: binding.consumerKind, enabled: binding.enabled })),
    providedBy: pluginParents(placement).map(target),
    includes: placement.kind === 'plugin' ? inventory.placements.filter((row) =>
      pluginParents(row).some((parent) => parent.placementId === placement.placementId)).map(target) : [],
    dependencies: edges.filter((edge) => edge.fromPlacementId === placement.placementId).map((edge) => edgeRow(edge, placements)),
    dependents: edges.filter((edge) => edge.toId === placement.placementId && placements.has(edge.fromPlacementId))
      .map((edge) => ({ ...edgeRow(edge, placements), target: target(placements.get(edge.fromPlacementId)) })),
    otherInstallations: inventory.placements.filter((row) => row.placementId !== placement.placementId
      && row.kind === placement.kind && family(row) === family(placement)).map(target),
    originStatus: (inventory.provenanceAssertions ?? []).some((entry) => entry.subjectId === placement.placementId && verifiedProvenance(entry))
      ? 'recorded' : 'not-established',
  };
  const truncated = Object.values(result).some((value) => Array.isArray(value) && value.length > LIMIT);
  for (const key of Object.keys(result)) if (Array.isArray(result[key])) result[key] = result[key].slice(0, LIMIT);
  return { ...result, truncated };
}
