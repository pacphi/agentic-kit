// ADR-0048 Inventory query engine (MNT-UX-001/002/005, MNT-PERF-002/003).
//
// Pure, synchronous, and read-only: it never touches the filesystem, spawns a
// process, or grants mutation authority. It queries a fully privacy-projected
// `ManagementInventory` that already carries `guidanceEntries` and each
// placement's `guidanceLane` (set upstream by `guidance.mjs`). An index is
// built once per inventory object (cached in a WeakMap) so repeated queries
// against one snapshot stay fast even at 50,000 placements.
import { focusNavigation } from './focus-navigation.mjs';
import { PROJECT_KINDS } from '../../footprint/project-kind.mjs';
import { recommendationEntries, normalizeGuidanceInventory } from './guidance-purpose.mjs';
import {
  ADMINISTRATIVE_SCOPES, CARRIER_KINDS, CURATED_VIEWS, FACETS, GUIDANCE_LANE_LABELS,
  INVENTORY_GROUP_LABELS, INVENTORY_GROUP_ORDER, MANAGEMENT_QUERY_SCHEMA, RESOURCE_KIND_LABELS,
  SCOPE_LABELS, SCOPE_LENSES, SORT_ORDERS, canonicalJson,
} from './model.mjs';

const LOCAL_PATH_PATTERN = /(?:^|[\s"'([{=:])(?:file:\/\/\/?|~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?!\/))/u;

const SCOPE_ICON = Object.freeze({
  system: 'shield', machine: 'computer', user: 'person', project: 'folder', across: 'layers',
});
const CARRIER_LABEL = Object.freeze({
  file: 'File', 'config-selector': 'Configuration', 'directory-tree': 'Directory',
  'package-record': 'Package record', executable: 'Executable',
  'runtime-installation': 'Runtime installation', 'cache-object': 'Cache object',
  'model-revision': 'Model revision', 'storage-root': 'Storage root',
});
const CARRIER_ICON = Object.freeze({
  file: 'file', 'config-selector': 'settings', 'directory-tree': 'folder-tree',
  'package-record': 'package', executable: 'terminal', 'runtime-installation': 'cpu',
  'cache-object': 'database', 'model-revision': 'box', 'storage-root': 'hard-drive',
});
const VERB_LABEL = Object.freeze({
  update: 'Update', disable: 'Disable', remove: 'Remove', 'repair-registration': 'Repair registration',
  'relink-dependency': 'Relink dependency', reinstall: 'Reinstall', 'clean-cache': 'Clean cache',
  restore: 'Restore', snooze: 'Snooze', acknowledge: 'Acknowledge', archive: 'Archive',
  terminate: 'Terminate', 'apply-project-patch': 'Apply project patch',
});
// Verbs whose label is already a complete, self-contained imperative (the
// object is baked into the verb itself) — appending a ROW_NOUN would be
// redundant ("Apply project patch file").
const SELF_CONTAINED_VERBS = new Set(['apply-project-patch']);
const ROW_NOUN = Object.freeze({
  'mcp-registration': 'registration', plugin: 'plugin', hook: 'hook', skill: 'skill',
  'instruction-context-file': 'file', agent: 'agent', 'command-prompt': 'command',
  'host-adapter': 'adapter', executable: 'executable', runtime: 'runtime', model: 'model',
  'provider-configuration': 'provider configuration', cache: 'cache',
  'credential-readiness': 'credential', 'related-storage': 'storage',
});
const LANE_DEFAULT_ACTION = Object.freeze({
  steps: 'Open procedure', decision: 'Compare choices', update: 'Inspect candidate',
  recovery: 'Audit interruption',
});
const LANE_FOR_VIEW = Object.freeze({
  'can-apply': 'apply', steps: 'steps', decisions: 'decision', updates: 'update',
});
const KIND_SET_FOR_VIEW = Object.freeze({
  'credentials-providers': new Set(['credential-readiness', 'provider-configuration']),
  'models-runtimes': new Set(['model', 'runtime']),
  'storage-caches': new Set(['cache', 'related-storage']),
});

const INDEX_CACHE = new WeakMap();
function familyFor(placement, index) { return index.resourcesById.get(placement.resourceId)?.presentationFamilyId ?? placement.resourceId; }

// ── Index construction (built once per inventory instance) ────────────────

function pushInto(map, key, value) {
  const arr = map.get(key);
  if (arr) arr.push(value); else map.set(key, [value]);
}

function pushRole(map, key, role) {
  const set = map.get(key);
  if (set) set.add(role); else map.set(key, new Set([role]));
}

function groupByKey(list, keyFn) {
  const map = new Map();
  for (const item of list ?? []) pushInto(map, keyFn(item), item);
  return map;
}

function buildSearchText(placement, resourcesById) {
  const resource = resourcesById.get(placement.resourceId);
  const parts = [
    placement.displayName, ...(placement.locationBreadcrumb ?? []),
    RESOURCE_KIND_LABELS[placement.kind] ?? placement.kind,
    ...(placement.consumerHosts ?? []), resource?.displayName ?? '',
  ];
  return parts.join(' ').toLowerCase();
}

function buildDependencyRoles(inventory, placementsById) {
  const roles = new Map();
  for (const edge of inventory.dependencyEdges ?? []) {
    pushRole(roles, edge.fromPlacementId, 'depends-on');
    if (placementsById.has(edge.toId)) pushRole(roles, edge.toId, 'depended-on-by');
  }
  return roles;
}

function buildConflictsByPlacement(inventory) {
  const map = new Map();
  for (const conflict of inventory.conflictSets ?? []) {
    for (const placementId of conflict.placementIds) pushInto(map, placementId, conflict);
  }
  return map;
}

function buildIndex(inventory) {
  const placementsById = new Map((inventory.placements ?? []).map((p) => [p.placementId, p]));
  const resourcesById = new Map((inventory.resources ?? []).map((r) => [r.resourceId, r]));
  const artifactsById = new Map((inventory.artifacts ?? []).map((a) => [a.artifactId, a]));
  const environmentsById = new Map((inventory.environments ?? []).map((e) => [e.environmentId, e]));
  const searchText = new Map();
  for (const placement of inventory.placements ?? []) {
    searchText.set(placement.placementId, buildSearchText(placement, resourcesById));
  }
  const placementsByProjectId = groupByKey(
    (inventory.placements ?? []).filter((p) => p.projectId != null),
    (p) => p.projectId,
  );
  return {
    inventory, placementsById, resourcesById, artifactsById, environmentsById, searchText,
    guidanceByPlacement: groupByKey(recommendationEntries(inventory.guidanceEntries), (g) => g.placementId),
    conflictsByPlacement: buildConflictsByPlacement(inventory),
    provenanceByPlacement: groupByKey(inventory.provenanceAssertions, (a) => a.subjectId),
    versionObsByPlacement: groupByKey(inventory.versionObservations, (v) => v.subjectId),
    dependencyRoles: buildDependencyRoles(inventory, placementsById),
    placementsByProjectId,
    placementsByFamily: groupByKey(inventory.placements, (p) => resourcesById.get(p.resourceId)?.presentationFamilyId ?? p.resourceId),
    facetCache: new Map(),
  };
}

function getIndex(inventory) {
  let index = INDEX_CACHE.get(inventory);
  if (!index) {
    index = buildIndex(inventory);
    INDEX_CACHE.set(inventory, index);
  }
  return index;
}

// ── Group bucket (INVENTORY_GROUP_ORDER classification) ───────────────────

function groupBucket(placement) {
  if (placement.guidanceLane) return placement.guidanceLane;
  const conditions = placement.conditions ?? [];
  if (conditions.length === 0 || conditions.every((condition) => condition === 'healthy')) return 'healthy';
  return 'evidence-only';
}

// ── Scope / view / search matching ─────────────────────────────────────────

function matchesScope(placement, scope) {
  return scope === 'across' || placement.administrativeScope === scope;
}

function hasGuidanceInLane(placement, lane, index) {
  // A placement's `guidanceLane` names only the highest-priority admitted
  // lane shown as its badge (e.g. Lightpanda's badge is 'steps' even though
  // it also carries a 'decision' entry, per INVENTORY_GROUP_ORDER). The
  // per-lane curated views must still surface every admitted entry, so they
  // check the full guidance-entry list, not just the single badge field.
  return (index.guidanceByPlacement.get(placement.placementId) ?? [])
    .some((entry) => entry.lane === lane);
}

function matchesView(placement, view, index) {
  if (view === 'all') return true;
  if (LANE_FOR_VIEW[view]) return hasGuidanceInLane(placement, LANE_FOR_VIEW[view], index);
  if (KIND_SET_FOR_VIEW[view]) return KIND_SET_FOR_VIEW[view].has(placement.kind);
  if (view === 'dependencies') return index.dependencyRoles.has(placement.placementId);
  if (view === 'conflicts') return index.conflictsByPlacement.has(placement.placementId);
  if (view === 'duplicates') {
    return (index.conflictsByPlacement.get(placement.placementId) ?? [])
      .some((conflict) => conflict.kind === 'duplicate-placement');
  }
  if (view === 'disabled') return (placement.conditions ?? []).includes('disabled');
  if (view === 'recently-changed') return placement.recentlyChangedAt != null;
  if (view === 'host-alignment') return placement.conditions.includes('host-alignment-required');
  if (view === 'evidence-only') return groupBucket(placement) === 'evidence-only';
  return true;
}

function matchesSearch(placementId, search, index) {
  const trimmed = String(search ?? '').trim().toLowerCase();
  if (!trimmed) return true;
  return (index.searchText.get(placementId) ?? '').includes(trimmed);
}

function computeBaseMatches(index, { scope, view, search }) {
  const ids = [];
  for (const placement of index.inventory.placements ?? []) {
    if (!matchesScope(placement, scope)) continue;
    if (!matchesView(placement, view, index)) continue;
    if (!matchesSearch(placement.placementId, search, index)) continue;
    ids.push(placement.placementId);
  }
  return ids;
}

// ── Facet value extraction ─────────────────────────────────────────────────

const unique = (values) => [...new Set(values)];

function carrierValues(placement, index) {
  return unique((placement.artifactIds ?? [])
    .map((id) => index.artifactsById.get(id)?.carrier)
    .filter(Boolean));
}

function provenanceValues(placement, index) {
  return (index.provenanceByPlacement.get(placement.placementId) ?? [])
    .map((assertion) => assertion.value?.kind)
    .filter(Boolean);
}

function packageManagerValues(placement, index) {
  return (index.provenanceByPlacement.get(placement.placementId) ?? [])
    .filter((assertion) => assertion.value?.kind === 'package-manager')
    .map((assertion) => assertion.value?.manager)
    .filter(Boolean);
}

function hasCandidateObservation(placement, index) {
  return (index.versionObsByPlacement.get(placement.placementId) ?? [])
    .some((observation) => observation.axis === 'candidate');
}

function versionStateValues(placement, index) {
  const scorecard = placement.evidenceScorecard ?? {};
  const versions = placement.versions ?? {};
  const states = [];
  if (scorecard.installedVersion === 'verified' && versions.installed != null) states.push('installed-verified');
  if (scorecard.effectiveVersion === 'verified' && versions.effective != null) states.push('effective-verified');
  if (hasCandidateObservation(placement, index)) states.push('candidate-present');
  if (scorecard.compatibility === 'verified') states.push('compatible-candidate');
  if (scorecard.recommendationAuthority === 'verified') states.push('recommended-candidate');
  if (versions.pin != null) states.push('pinned');
  if (!states.some((state) => state === 'installed-verified' || state === 'effective-verified')) states.push('no-verified-version');
  return states;
}

function guidanceLaneValues(placement, index) {
  // Every lane the placement carries an admitted entry for, not only its
  // single primary badge (see `hasGuidanceInLane` above for why).
  return unique((index.guidanceByPlacement.get(placement.placementId) ?? []).map((entry) => entry.lane));
}

function dependencyRoleValues(placement, index) {
  const roles = index.dependencyRoles.get(placement.placementId);
  return roles ? [...roles] : ['none'];
}

function conflictValues(placement, index) {
  return (index.conflictsByPlacement.get(placement.placementId) ?? []).map((conflict) => conflict.kind);
}

function channelValues(placement, index) {
  const observed = (index.versionObsByPlacement.get(placement.placementId) ?? [])
    .find((observation) => observation.axis === 'channel');
  if (observed) return [observed.value];
  return placement.versions?.channel ? [placement.versions.channel] : [];
}

const FACET_EXTRACTORS = Object.freeze({
  family: (placement, index) => [familyFor(placement, index)],
  scope: (placement) => [placement.administrativeScope],
  environment: (placement) => [placement.environmentId],
  project: (placement) => (placement.projectId ? [placement.projectId] : []),
  projectType: (placement) => placement.projectId ? [PROJECT_KINDS.includes(placement.projectKind) ? placement.projectKind : 'unknown'] : [],
  sessionOrigin: (placement) => placement.projectId
    ? [...new Set(placement.sessionOrigins?.length ? placement.sessionOrigins.map((entry) => entry.origin) : ['unknown'])] : [],
  kind: (placement) => [placement.kind],
  consumer: (placement) => (placement.consumerHosts ?? []).filter((host) => ['claude', 'codex', 'opencode'].includes(host)),
  adapter: (placement) => [...new Set([...(placement.consumerHosts ?? []), ...(placement.kind === 'host-adapter' ? [placement.hostNamespace] : [])].filter((host) => typeof host === 'string' && host && !['claude', 'codex', 'opencode', 'agentic-kit'].includes(host)))],
  carrier: carrierValues,
  provenance: provenanceValues,
  packageManager: packageManagerValues,
  versionState: versionStateValues,
  guidance: guidanceLaneValues,
  dependencyRole: dependencyRoleValues,
  conflict: conflictValues,
  credentialReadiness: (placement) => (placement.credentialReadiness ? [placement.credentialReadiness] : []),
  channel: channelValues,
  evidenceFields: (placement) => Object.keys(placement.evidenceScorecard ?? {}),
  recentlyChanged: (placement) => (placement.recentlyChangedAt ? ['true'] : []),
});

function facetValuesFor(index, placementId, facet) {
  let perPlacement = index.facetCache.get(placementId);
  if (!perPlacement) { perPlacement = new Map(); index.facetCache.set(placementId, perPlacement); }
  if (perPlacement.has(facet)) return perPlacement.get(facet);
  const extractor = FACET_EXTRACTORS[facet];
  const placement = index.placementsById.get(placementId);
  const values = extractor ? extractor(placement, index) : [];
  perPlacement.set(facet, values);
  return values;
}

function matchesFacets(placementId, index, appliedFacets, exceptFacet) {
  for (const [facet, values] of Object.entries(appliedFacets)) {
    if (facet === exceptFacet) continue;
    const placementValues = facetValuesFor(index, placementId, facet);
    if (!values.some((value) => placementValues.includes(value))) return false;
  }
  return true;
}

function normalizeFacets(rawFacets) {
  const out = {};
  if (!rawFacets || typeof rawFacets !== 'object') return out;
  for (const facet of FACETS) {
    const values = rawFacets[facet];
    if (!Array.isArray(values) || !values.length) continue;
    const clean = unique(values.filter((value) => typeof value === 'string' && value));
    if (clean.length) out[facet] = clean;
  }
  return out;
}

function computeFacetCounts(baseIds, index, appliedFacets) {
  const tallies = new Map(FACETS.map((facet) => [facet, new Map()]));
  const selected = Object.entries(appliedFacets);
  for (const placementId of baseIds) {
    const failed = [];
    for (const [facet, values] of selected) {
      const placementValues = facetValuesFor(index, placementId, facet);
      if (!values.some((value) => placementValues.includes(value))) failed.push(facet);
      if (failed.length === 2) break;
    }
    // Counts ignore their own selection. A placement failing two other
    // selections cannot contribute; one failure contributes only to that facet.
    if (failed.length === 2) continue;
    for (const facet of failed.length ? failed : FACETS) {
      const tally = tallies.get(facet);
      for (const value of facetValuesFor(index, placementId, facet)) {
        tally.set(value, (tally.get(value) ?? 0) + 1);
      }
    }
  }
  return Object.fromEntries([...tallies].filter(([, tally]) => tally.size)
    .map(([facet, tally]) => [facet, Object.fromEntries(tally)]));
}

// ── Sorting ─────────────────────────────────────────────────────────────────

function sortRank(placementId, index, sort) {
  const placement = index.placementsById.get(placementId);
  if (sort === 'guidance-first') {
    return [INVENTORY_GROUP_ORDER.indexOf(groupBucket(placement)), placement.displayName, placementId];
  }
  if (sort === 'recently-changed') {
    const changed = placement.recentlyChangedAt;
    return [changed ? 0 : 1, changed ? -Date.parse(changed) : 0, placement.displayName, placementId];
  }
  if (sort === 'kind') return [placement.kind, placement.displayName, placementId];
  return [placement.displayName, placementId];
}

function compareRanks(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i]; const right = b[i];
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
  }
  return 0;
}

function sortPlacementIds(ids, index, sort) {
  return [...ids].sort((a, b) => compareRanks(sortRank(a, index, sort), sortRank(b, index, sort)));
}

// ── Row and group projection ────────────────────────────────────────────────

function primaryCarrier(placement, index) {
  const artifactId = placement.artifactIds?.[0];
  const artifact = artifactId ? index.artifactsById.get(artifactId) : null;
  if (!artifact) return null;
  return { value: artifact.carrier, label: CARRIER_LABEL[artifact.carrier], icon: CARRIER_ICON[artifact.carrier] };
}

function rowActionFor(placement, index) {
  if (!placement.guidanceLane) return { verb: null, label: 'Open details' };
  const entries = index.guidanceByPlacement.get(placement.placementId) ?? [];
  const primary = entries.find((entry) => entry.lane === placement.guidanceLane) ?? null;
  if (placement.guidanceLane === 'apply' && primary?.verb && VERB_LABEL[primary.verb]) {
    if (SELF_CONTAINED_VERBS.has(primary.verb)) return { verb: primary.verb, label: VERB_LABEL[primary.verb] };
    const noun = ROW_NOUN[placement.kind] ?? 'resource';
    return { verb: primary.verb, label: `${VERB_LABEL[primary.verb]} ${noun}` };
  }
  return { verb: primary?.verb ?? null, label: LANE_DEFAULT_ACTION[placement.guidanceLane] ?? 'Open details' };
}

function buildPlacementRow(placement, index) {
  const description = Object.hasOwn(placement, 'description') ? placement.description : index.resourcesById.get(placement.resourceId)?.description;
  return {
    placementId: placement.placementId,
    projectId: placement.projectId ?? null,
    ...(placement.projectId ? { projectKind: PROJECT_KINDS.includes(placement.projectKind) ? placement.projectKind : 'unknown' } : {}),
    ...(placement.projectId ? { repositoryId: placement.repositoryId ?? null, repositoryLabel: placement.repositoryLabel ?? null,
      repositoryEvidence: placement.repositoryEvidence ?? null, repositoryObservedAt: placement.repositoryObservedAt ?? null,
      sessionOrigins: placement.sessionOrigins ?? [] } : {}),
    displayName: placement.displayName,
    ...(index.resourcesById.get(placement.resourceId)?.installationSource ? { installationSource: index.resourcesById.get(placement.resourceId).installationSource } : {}),
    ...(description ? { description } : {}),
    kind: placement.kind,
    scope: {
      value: placement.administrativeScope,
      label: SCOPE_LABELS[placement.administrativeScope],
      icon: SCOPE_ICON[placement.administrativeScope],
    },
    breadcrumb: [...(placement.locationBreadcrumb ?? [])],
    versions: { ...(placement.versions ?? {}) },
    carrier: primaryCarrier(placement, index),
    consumerHosts: [...(placement.consumerHosts ?? [])],
    guidanceLane: placement.guidanceLane
      ? { value: placement.guidanceLane, label: GUIDANCE_LANE_LABELS[placement.guidanceLane] }
      : null,
    rowAction: rowActionFor(placement, index),
  };
}

function bestOutcome(placements, index) {
  let best = null;
  for (const placement of placements) {
    for (const entry of index.guidanceByPlacement.get(placement.placementId) ?? []) {
      const rank = INVENTORY_GROUP_ORDER.indexOf(entry.lane);
      if (rank < 0) continue;
      if (!best || rank < best.rank || (rank === best.rank && entry.guidanceId < best.entry.guidanceId)) {
        best = { rank, entry };
      }
    }
  }
  return best ? best.entry.outcome : undefined;
}

function buildGroup(resource, placements, index) {
  const familyId = resource.presentationFamilyId ?? resource.resourceId;
  const all = index.placementsByFamily.get(familyId) ?? placements;
  const bindingIds = new Set();
  for (const placement of placements) {
    for (const id of placement.consumerBindingIds ?? []) bindingIds.add(id);
  }
  const outcome = bestOutcome(placements, index);
  return {
    resourceId: resource.resourceId,
    presentationKey: familyId,
    knownPlacementCount: all.length,
    knownHosts: [...new Set(all.flatMap((p) => p.consumerHosts ?? []))],
    displayName: resource.displayName,
    kind: resource.kind,
    placementCount: placements.length,
    consumerCount: bindingIds.size,
    ...(outcome !== undefined ? { outcome } : {}),
    placements: placements.map((placement) => buildPlacementRow(placement, index)),
  };
}

function buildGroups(pageIds, index) {
  const order = [];
  const byResource = new Map();
  for (const placementId of pageIds) {
    const placement = index.placementsById.get(placementId);
    const familyId = familyFor(placement, index);
    let entry = byResource.get(familyId);
    if (!entry) {
      entry = { resource: index.resourcesById.get(placement.resourceId), placements: [] };
      byResource.set(familyId, entry);
      order.push(familyId);
    }
    entry.placements.push(placement);
  }
  return order.map((resourceId) => {
    const entry = byResource.get(resourceId);
    return buildGroup(entry.resource, entry.placements, index);
  });
}

function sortGroupSummary(finalMatches, index) {
  const counts = new Map();
  for (const placementId of finalMatches) {
    const bucket = groupBucket(index.placementsById.get(placementId));
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return INVENTORY_GROUP_ORDER
    .filter((bucket) => counts.has(bucket))
    .map((bucket) => ({ bucket, label: INVENTORY_GROUP_LABELS[bucket], count: counts.get(bucket) }));
}

// ── Facet display labels (environment/project chips need a name, not an id) ─

function environmentFacetLabels(index, environmentIds) {
  const labels = {};
  for (const environmentId of environmentIds) {
    const label = index.environmentsById.get(environmentId)?.displayLabel;
    if (label) labels[environmentId] = label;
  }
  return labels;
}

/** The longest shared prefix of several breadcrumbs — the project's own
 *  root, once per-placement subpath segments (".claude/skills", …) are
 *  stripped. A project with only one known placement keeps its full
 *  breadcrumb (nothing to strip against). Never a path — breadcrumb
 *  segments are already display text (MNT-INV-010). */
function longestCommonBreadcrumb(breadcrumbs) {
  if (!breadcrumbs.length) return [];
  let prefix = breadcrumbs[0];
  for (const crumb of breadcrumbs.slice(1)) {
    let matched = 0;
    while (matched < prefix.length && matched < crumb.length && prefix[matched] === crumb[matched]) matched += 1;
    prefix = prefix.slice(0, matched);
    if (!prefix.length) break;
  }
  return prefix;
}

function projectFacetLabels(index, projectIds) {
  const labels = {};
  for (const projectId of projectIds) {
    const placements = index.placementsByProjectId.get(projectId);
    if (!placements) continue;
    // A single installation's location cannot identify the project root.
    // Prefer measured project breadcrumbs; older snapshots keep the fallback.
    const projectBreadcrumbs = placements.map((placement) => placement.projectBreadcrumb).filter(Array.isArray);
    const breadcrumbs = projectBreadcrumbs.length ? projectBreadcrumbs : placements.map((placement) => placement.locationBreadcrumb ?? []);
    const label = longestCommonBreadcrumb(breadcrumbs).join(' › ');
    if (label) labels[projectId] = label;
  }
  return labels;
}

function buildFacetLabels(index, facetCounts, selectedFacets = {}) {
  const keys = (facet) => [...new Set([...(selectedFacets[facet] ?? []), ...Object.keys(facetCounts[facet] ?? {})])];
  return {
    family: Object.fromEntries(keys('family').map((id) => [id, index.placementsByFamily.get(id)?.[0]?.displayName ?? 'Resource'])),
    environment: environmentFacetLabels(index, keys('environment')),
    project: projectFacetLabels(index, keys('project')),
  };
}

// ── Cursor ──────────────────────────────────────────────────────────────────

/** @returns {Error & { code: string }} */
function cursorError(message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = 'inventory-generation-mismatch';
  return error;
}

function encodeCursor(inventoryId, offset) {
  return Buffer.from(JSON.stringify({ inventoryId, offset }), 'utf8').toString('base64url');
}

function resolveCursorOffset(cursor, inventoryId) {
  if (cursor == null || cursor === '') return 0;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw cursorError('invalid inventory query cursor');
  }
  if (!decoded || decoded.inventoryId !== inventoryId
      || !Number.isInteger(decoded.offset) || decoded.offset < 0) {
    throw cursorError('cursor does not match the current inventory generation');
  }
  return decoded.offset;
}

function clampLimit(limit) {
  const parsed = Number(limit);
  const value = Number.isFinite(parsed) ? Math.floor(parsed) : 50;
  return Math.min(200, Math.max(1, value));
}

// ── Public API ───────────────────────────────────────────────────────────────

function validateQueryOptions({ scope, view, sort, presentation, includeWorktrees }) {
  if (!SCOPE_LENSES.includes(scope)) throw new TypeError(`invalid inventory query scope: ${scope}`);
  if (!CURATED_VIEWS.includes(view)) throw new TypeError(`invalid inventory query view: ${view}`);
  if (!SORT_ORDERS.includes(sort)) throw new TypeError(`invalid inventory query sort: ${sort}`);

  if (!['flat', 'focus'].includes(presentation)) throw new TypeError('invalid inventory query presentation');
  if (typeof includeWorktrees !== 'boolean') throw new TypeError('includeWorktrees must be a boolean');
}

function projectKindsFor(index, facetCounts) {
  return Object.fromEntries(Object.keys(facetCounts.project ?? {}).map((id) => {
    const kinds = new Set((index.placementsByProjectId.get(id) ?? []).map((p) => PROJECT_KINDS.includes(p.projectKind) ? p.projectKind : 'unknown'));
    return [id, kinds.size === 1 ? [...kinds][0] : 'unknown'];
  }));
}

/**
 * Query a privacy-projected ManagementInventory. Pure and synchronous; never
 * mutates `inventory`. Throws `TypeError` for an invalid scope/view/sort and
 * an `Error` with `code: 'inventory-generation-mismatch'` for a cursor bound
 * to a different inventory generation (MNT-PERF-003).
 */
export function runInventoryQuery(inventory, params = {}) {
  inventory = normalizeGuidanceInventory(inventory);
  const {
    scope = 'across', view = 'all', facets: rawFacets = {}, search = '',
    sort = 'guidance-first', cursor = null, limit = 50, presentation = 'flat', includeWorktrees = false,
  } = params ?? {};
  validateQueryOptions({ scope, view, sort, presentation, includeWorktrees });
  const index = getIndex(inventory);
  const appliedFacets = normalizeFacets(rawFacets);
  const clampedLimit = clampLimit(limit);
  const offset = resolveCursorOffset(cursor, inventory.inventoryId);

  const baseMatches = computeBaseMatches(index, { scope, view, search });
  const facetCounts = computeFacetCounts(baseMatches, index, appliedFacets);
  const finalMatches = baseMatches.filter((id) => matchesFacets(id, index, appliedFacets, null));
  const ranked = sortPlacementIds(finalMatches, index, sort);
  // Keep families contiguous before bounded placement pagination. The client
  // merges continuation rows by this stable family key, retaining every row.
  const families = groupByKey(ranked, (id) => familyFor(index.placementsById.get(id), index));
  const ordered = [...families.values()].flat();
  const total = ordered.length;
  const pageIds = ordered.slice(offset, offset + clampedLimit);
  let nextCursor = offset + pageIds.length < total
    ? encodeCursor(inventory.inventoryId, offset + pageIds.length)
    : undefined;

  const facetLabels = buildFacetLabels(index, facetCounts, appliedFacets);
  const projectKinds = projectKindsFor(index, facetCounts);
  let navigation;
  if (presentation === 'focus') {
    navigation = focusNavigation({ scope, facets: appliedFacets,
      placements: ranked.map((id) => index.placementsById.get(id)), resourcesById: index.resourcesById,
      projectLabels: facetLabels.project, projectKinds, includeWorktrees,
      initial: scope === 'across' && view === 'all' && !search.trim() && !Object.keys(appliedFacets).length,
    });
    if (navigation.level !== 'installation') {
      const allNodes = navigation.nodes;
      navigation = { ...navigation, nodes: allNodes.slice(offset, offset + clampedLimit) };
      nextCursor = offset + navigation.nodes.length < allNodes.length
        ? encodeCursor(inventory.inventoryId, offset + navigation.nodes.length) : undefined;
    }
  }
  return {
    schema: MANAGEMENT_QUERY_SCHEMA,
    inventoryId: inventory.inventoryId,
    total,
    groups: navigation && navigation.level !== 'installation' ? [] : buildGroups(pageIds, index),
    ...(navigation ? { navigation } : {}),
    facetCounts,
    facetLabels, projectKinds,
    ...(nextCursor ? { nextCursor } : {}),
    sortGroups: sortGroupSummary(finalMatches, index),
    partialSources: partialSources(inventory),
    appliedFacets,
  };
}

function assertNoLocalPathValue(value, field) {
  if (typeof value === 'string' && LOCAL_PATH_PATTERN.test(value)) {
    throw new TypeError(`${field} must not carry a local path`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoLocalPathValue(entry, `${field}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertNoLocalPathValue(entry, `${field}.${key}`);
  }
}

/** Encode query state (scope/view/facets/search/sort/cursor/limit) as an
 *  opaque URL/hash-safe token. Only opaque identifiers and enum values may
 *  appear in `params`; anything shaped like a local path is rejected. */
export function encodeQueryState(params) {
  assertNoLocalPathValue(params, 'queryState');
  return Buffer.from(canonicalJson(params ?? {}), 'utf8').toString('base64url');
}

/** Decode a token produced by `encodeQueryState`. Returns `{}` for an empty
 *  value. Throws `TypeError` for a malformed token or one carrying a local
 *  path (defense in depth: such a token could not have come from
 *  `encodeQueryState`, but a hand-crafted URL might). */
export function decodeQueryState(value) {
  if (typeof value !== 'string' || !value) return {};
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('invalid maintenance query state');
  }
  assertNoLocalPathValue(decoded, 'queryState');
  return decoded;
}

// ── Partial-source disclosure (MNT-DSC-015/016) ────────────────────────────
// `state: 'not-scanned'` is the explicit never-run coverage state (a fresh
// install typically has several of these at once); `state: 'scanning'`
// means work is underway regardless of how many entries it has visited so
// far — a source that just started legitimately reports `visited: 0` too,
// so visited count is never used to infer "not scanned" (MNT-DSC-016).

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function limitReasonFor(entry) {
  return entry.ceiling ?? entry.limitingReason ?? null;
}

function summarizeBucket(entries) {
  return { count: entries.length, labels: entries.map((entry) => entry.label).filter(Boolean) };
}

function summarizeWithVisited(entries) {
  return {
    ...summarizeBucket(entries),
    visited: entries.reduce((sum, entry) => sum + (Number.isFinite(entry.visited) ? entry.visited : 0), 0),
  };
}

function summarizeWithReasons(entries) {
  return {
    ...summarizeBucket(entries),
    reasons: [...new Set(entries.map(limitReasonFor).filter(Boolean))],
  };
}

function partialSourcesNarrative({ notScanned, scanning, limited, completeCount, overallTotal }) {
  if (limited.length > 0) {
    const reasons = [...new Set(limited.map(limitReasonFor).filter(Boolean))];
    const suffix = reasons.length ? ` (${reasons.join(', ')})` : '';
    return {
      narrative: `${limited.length} ${pluralize(limited.length, 'source')} stopped at a limit${suffix}.`,
      action: 'discovery',
    };
  }
  if (notScanned.length > 0) {
    return {
      narrative: `${notScanned.length} ${pluralize(notScanned.length, 'source')} `
        + `${pluralize(notScanned.length, 'has', 'have')} not been scanned yet.`,
      action: 'remeasure',
    };
  }
  if (scanning.length > 0) {
    return {
      narrative: `${scanning.length} ${pluralize(scanning.length, 'source')} `
        + `${pluralize(scanning.length, 'is', 'are')} still scanning; ${completeCount} of ${overallTotal} complete.`,
      action: null,
    };
  }
  return { narrative: null, action: null };
}

/**
 * A structured summary of every source whose coverage is not yet `complete`,
 * for the Inventory disclosure banner (MNT-DSC-015/016). The banner renders
 * ONE short sentence (`narrative`) plus at most one action; it never
 * enumerates every source. Per-source detail stays available under
 * `entries[]` for the inspector's "What proves this?" section.
 */
export function partialSources(inventory) {
  const coverage = inventory.sourceCoverage ?? [];
  const entries = coverage
    .filter((entry) => entry.state !== 'complete')
    .map((entry) => ({
      sourceId: entry.sourceId,
      environmentId: entry.environmentId,
      state: entry.state,
      label: entry.label,
      visited: entry.visited,
      limitingReason: entry.limitingReason ?? null,
      ceiling: entry.ceiling ?? null,
      completedPartitions: entry.completedPartitions,
      pendingPartitions: entry.pendingPartitions,
    }));

  const notScanned = entries.filter((entry) => entry.state === 'not-scanned');
  const scanning = entries.filter((entry) => entry.state === 'scanning');
  const paused = entries.filter((entry) => entry.state === 'paused');
  const stopped = entries.filter((entry) => entry.state === 'stopped');
  const failed = entries.filter((entry) => entry.state === 'failed');
  const limited = [...paused, ...stopped, ...failed];

  const completeCount = coverage.filter((entry) => entry.state === 'complete').length;
  const { narrative, action } = partialSourcesNarrative({
    notScanned, scanning, limited, completeCount, overallTotal: coverage.length,
  });

  return {
    total: entries.length,
    notScanned: summarizeBucket(notScanned),
    scanning: summarizeWithVisited(scanning),
    paused: summarizeWithVisited(paused),
    stopped: summarizeWithReasons(stopped),
    failed: summarizeWithReasons(failed),
    action,
    narrative,
    entries,
  };
}

// Re-exported so the dashboard/CLI can validate a carrier value without
// importing model.mjs a second time for one constant.
export const KNOWN_CARRIER_KINDS = CARRIER_KINDS;
export const KNOWN_ADMINISTRATIVE_SCOPES = ADMINISTRATIVE_SCOPES;
