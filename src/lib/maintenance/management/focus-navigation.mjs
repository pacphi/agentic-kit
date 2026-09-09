// Focus navigation aggregates the complete filtered result before paging.
// A node count is a count of distinct placements, never relation occurrences.
import { RESOURCE_KIND_LABELS, SCOPE_LABELS } from './model.mjs';

function navigationLevel(scope, facets) {
  const effectiveScope = scope !== 'across' ? scope
    : facets.scope?.length === 1 ? facets.scope[0] : facets.project?.length === 1 ? 'project' : scope;
  return facets.family?.length === 1 ? 'installation'
    : effectiveScope === 'across' ? 'scope'
      : effectiveScope === 'project' && facets.project?.length !== 1 ? 'project'
        : facets.kind?.length !== 1 ? 'kind' : 'resource';
}

function descriptor(level, placement, resource, projectLabels, projectKinds) {
  const value = level === 'scope' ? placement.administrativeScope
    : level === 'project' ? placement.projectId
      : level === 'kind' ? placement.kind : resource?.presentationFamilyId ?? placement.resourceId;
  if (value == null) return null;
  const label = level === 'scope' ? SCOPE_LABELS[value]
    : level === 'project' ? projectLabels[value] ?? 'Project'
      : level === 'kind' ? RESOURCE_KIND_LABELS[value] : resource?.capabilityLabel ?? resource?.displayName ?? placement.displayName;
  return { value, label, count: 0,
    ...(level === 'resource' ? { kind: placement.kind, installationSource: resource?.installationSource ?? null, description: Object.hasOwn(placement, 'description') ? placement.description : resource?.description ?? null, descriptionSource: resource?.descriptionSource ?? null } : {}),
    ...(level === 'project' ? { projectKind: projectKinds[value] ?? 'unknown', languages: placement.projectLanguages ?? [] } : {}),
  };
}

export function focusNavigation({ scope, facets, placements, resourcesById, projectLabels, projectKinds, includeWorktrees = false, initial = false }) {
  const level = navigationLevel(scope, facets);
  if (level === 'installation') return { level, nodes: [] };
  const nodes = new Map();
  for (const placement of placements) {
    const candidate = descriptor(level, placement, resourcesById.get(placement.resourceId), projectLabels, projectKinds);
    if (!candidate) continue;
    if (!nodes.has(candidate.value)) nodes.set(candidate.value, candidate);
    const node = nodes.get(candidate.value);
    node.count += 1;
    if (level === 'project') node.languages = [...new Map([...(node.languages ?? []), ...(candidate.languages ?? [])].map(row => [row.id, row])).values()];
    if (node.description !== candidate.description) node.description = null;
  }
  if (level === 'scope') {
    const ordered = ['system', 'machine', 'user', 'project'];
    return { level, nodes: ordered.filter((value) => initial || nodes.has(value))
      .map((value) => nodes.get(value) ?? { value, label: SCOPE_LABELS[value], count: 0 }) };
  }
  return { level, nodes: [...nodes.values()].filter((node) => level !== 'project'
    || includeWorktrees || node.projectKind !== 'worktree' || facets.project?.includes(node.value)) };
}
