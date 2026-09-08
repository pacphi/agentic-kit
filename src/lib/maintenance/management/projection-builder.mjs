// Shared inventory-assembly primitives for projection.mjs and
// projection-projects.mjs. Split out purely to avoid a circular import
// between those two files (projection.mjs calls the project/instruction-file
// mapping functions; those functions need the same placement-finalization and
// host-label helpers projection.mjs's other mapping stages use). Not a public
// contract of its own — everything here is an implementation detail of
// `buildManagementInventory`.
export const HOST_LABELS = Object.freeze({
  claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', hermes: 'Hermes', 'agentic-kit': 'Agentic Kit',
});

export const hostLabel = (host) => HOST_LABELS[host] ?? (host ? String(host) : 'Host');

// Mirrors model.mjs's own `LOCAL_PATH` check verbatim (that module does not
// export it — it is a structural-validation internal, not a public helper).
// Kept here so every technicalDetails line can be checked BEFORE it ever
// reaches assertManagementInventory, not just at the final gate.
const LOCAL_PATH = /(?:^|[\s"'([{=:])(?:file:\/\/\/?|~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?!\/))/u;

/** Drop any technical-detail line that would put a local path in the
 *  inventory. A source collector's free-text note (a storage
 *  `accountingNote`, for example) may legitimately mention a path — but a
 *  partial in-place redaction risks leaving a recognizable fragment behind,
 *  so an unpresentable line is omitted outright rather than rewritten.
 *  Missing evidence omits the field (ADR-0048 §5); this is the same rule
 *  applied to one free-text line instead of a whole claim. */
function scrubTechnicalDetails(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.filter((line) => typeof line === 'string' && !LOCAL_PATH.test(line));
}

/** Accumulates a ManagementInventory's flat collections while a projection
 *  runs. `upsertResource`/`upsertArtifact` are idempotent (first write wins
 *  for kind/displayName); `linkPlacement` keeps a resource's `placementIds`
 *  deduplicated. */
export function createBuilder() {
  const resources = new Map();
  const placements = [];
  const artifacts = new Map();
  const bindings = [];
  const provenanceAssertions = [];
  const versionObservations = [];
  const edgeDescriptors = [];
  const privateLocators = new Map();

  return {
    resources, placements, artifacts, bindings,
    provenanceAssertions, versionObservations, edgeDescriptors, privateLocators,
    upsertResource(resourceId, fields) {
      if (!resources.has(resourceId)) {
        resources.set(resourceId, {
          resourceId, kind: fields.kind, displayName: fields.displayName, placementIds: [],
          ...(fields.presentationFamilyId ? { presentationFamilyId: fields.presentationFamilyId } : {}),
          ...(fields.namespace != null ? { namespace: fields.namespace } : {}),
          ...(fields.publisher != null ? { publisher: fields.publisher } : {}),
        });
      }
      return resources.get(resourceId);
    },
    linkPlacement(resourceId, placementId) {
      const resource = resources.get(resourceId);
      if (resource && !resource.placementIds.includes(placementId)) resource.placementIds.push(placementId);
    },
    upsertArtifact(artifactId, fields) {
      if (!artifacts.has(artifactId)) artifacts.set(artifactId, { artifactId, ...fields });
      return artifacts.get(artifactId);
    },
    addBinding(binding) { bindings.push(binding); },
    addPlacement(placement) { placements.push(placement); },
    addProvenance(entry) { provenanceAssertions.push(entry); },
    addVersion(entry) { versionObservations.push(entry); },
    addEdge(descriptor) { edgeDescriptors.push(descriptor); },
    locate(placementId, locator) { privateLocators.set(placementId, locator); },
  };
}

/** Finalize and record one placement: links it to its resource and pushes
 *  the fully-shaped ManagementInventory placement row. Every mapping stage
 *  (catalog, hooks, install, storage, daemons, models, providers, projects)
 *  funnels through this one function so the placement shape cannot drift
 *  between stages. */
export function finalizePlacement(builder, {
  placementId, resourceId, environmentId, administrativeScope, projectId = null,
  locationBreadcrumb, artifactIds, consumerBindingIds, conditions, evidenceScorecard,
  displayName, kind, hostNamespace = undefined, consumerHosts, versions = {}, guidanceLane = null,
  technicalDetails = [], recentlyChangedAt = null, extra = {},
}) {
  builder.linkPlacement(resourceId, placementId);
  builder.addPlacement({
    placementId, resourceId, environmentId, administrativeScope,
    ...(projectId != null ? { projectId } : {}),
    locationBreadcrumb, artifactIds, consumerBindingIds, conditions, evidenceScorecard,
    displayName, kind, ...(hostNamespace != null ? { hostNamespace } : {}),
    consumerHosts, versions, guidanceLane, technicalDetails: scrubTechnicalDetails(technicalDetails),
    recentlyChangedAt, ...extra,
  });
}
