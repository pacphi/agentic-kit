// ADR-0048 project identity, breadcrumb, worktree/repository grouping, and
// instruction-context-file mapping — split out of projection.mjs purely to
// keep that file under the repository's max-lines budget. Not a public
// contract of its own; `projection.mjs`'s `buildManagementInventory` is the
// only supported entry point. See that file's header for the accepted
// `footprint.projects`/`discovery.projects`/`discovery.instructionFiles`
// shapes.
import { PROJECT_KINDS } from '../../footprint/project-kind.mjs';
import { artifactIdentity, bindingIdentity, placementIdentity, projectIdentity, resourceIdentity } from './identity.mjs';
import { assertion, scorecardFor } from './evidence.mjs';
import { finalizePlacement, hostLabel } from './projection-builder.mjs';

function segmentsOf(rawPath) {
  return String(rawPath ?? '').split(/[\\/]+/).filter(Boolean);
}

/** Each project's shortest tail of path segments that no other known project
 *  shares at that same length (MNT-INV-010). Independent per project: two
 *  colliding projects may end up with different breadcrumb lengths. */
function computeBreadcrumbs(rows) {
  const entries = rows.map((row) => ({ row, segments: segmentsOf(row.path) }));
  const breadcrumbs = new Map();
  for (const entry of entries) {
    let n = 1;
    const maxN = Math.max(1, entry.segments.length);
    while (n < maxN) {
      const tail = entry.segments.slice(-n).join(' ');
      const collides = entries.some((other) => (
        other !== entry && other.segments.slice(-n).join(' ') === tail
      ));
      if (!collides) break;
      n += 1;
    }
    breadcrumbs.set(entry.row, entry.segments.slice(-n));
  }
  return breadcrumbs;
}

function repositoryKeyFor(row) {
  if (row.repositoryRoot) return `root:${row.repositoryRoot}`;
  if (row.remote?.status === 'linked' && row.remote.webUrl) return `remote:${row.remote.webUrl}`;
  return null;
}

/** A placement-less `related-storage` resource id per repository key that
 *  groups two or more members — a lone member has no group to join. Shared
 *  between the lexical (footprint.projects) and authoritative
 *  (discovery.projects) registries so both use one resource-shaping rule. */
function repositoryResourceIdsForGroups(builder, groups, installationKey, labelFor) {
  const resourceIdForKey = new Map();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const resourceId = resourceIdentity({ kind: 'related-storage', sourceSelector: `repository:${key}` }, installationKey);
    builder.upsertResource(resourceId, { kind: 'related-storage', displayName: `${labelFor(members[0])} repository` });
    resourceIdForKey.set(key, resourceId);
  }
  return resourceIdForKey;
}

/**
 * Build the LEXICAL project registry from footprint.projects rows: identity,
 * breadcrumb, and (when two or more known projects share a repository) a
 * placement-less `related-storage` resource id that groups their worktrees.
 * This registry is what catalog/instruction-file mapping looks projects up
 * by path in — it always runs, whether or not `discovery.projects` is also
 * supplied.
 *
 * @returns {Map<string, { projectId: string, breadcrumb: string[],
 *            repositoryResourceId: string|null }>} keyed by project path
 */
function mapLexicalProjects(builder, rows, { installationKey }) {
  const breadcrumbs = computeBreadcrumbs(rows);
  const byRepositoryKey = new Map();
  for (const row of rows) {
    const key = repositoryKeyFor(row);
    if (!key) continue;
    if (!byRepositoryKey.has(key)) byRepositoryKey.set(key, []);
    byRepositoryKey.get(key).push(row);
  }
  const repositoryResourceIdFor = repositoryResourceIdsForGroups(
    builder, byRepositoryKey, installationKey,
    (row) => row.label ?? segmentsOf(row.path).at(-1) ?? 'repository',
  );
  const registry = new Map();
  for (const row of rows) {
    const verifiedRemote = row.remote?.status === 'linked' ? row.remote.webUrl : null;
    const projectId = projectIdentity({ verifiedRemote, worktreeRoot: row.path }, installationKey);
    const key = repositoryKeyFor(row);
    registry.set(row.path, {
      projectId,
      projectKind: PROJECT_KINDS.includes(row.projectKind) ? row.projectKind : row.isGitRepo === true || verifiedRemote ? 'git' : 'unknown',
      breadcrumb: breadcrumbs.get(row) ?? segmentsOf(row.path),
      repositoryResourceId: key ? repositoryResourceIdFor.get(key) ?? null : null,
    });
  }
  return registry;
}

/**
 * Merge in the AUTHORITATIVE `discovery.projects` registry, when a caller
 * (agent D's discovery scan) supplies one. Its facts win over the lexical
 * ones above for any path/projectId they both name: `breadcrumb` and
 * `repositoryKey` replace path-derived guesses, and `nested` keeps a nested
 * repository out of its parent's worktree group (MNT-INV-011) even when a
 * `repositoryKey` is present. Entries are matched into the path-keyed
 * registry only when they carry a `path`; entries without one still
 * participate in `byProjectId` (for instruction files and submodule-of
 * edges below), just not in path-based catalog lookups.
 *
 * @param {Array<{ projectId: string, breadcrumb?: string[], projectKind?: string, worktree?: string|boolean,
 *           repositoryKey?: string, nested?: boolean, submoduleOfProjectId?: string,
 *           path?: string, instructionFiles?: Array<{ name: string, host: string, digest?: string }> }>} entries
 * @returns {{ byProjectId: Map<string, object> }}
 */
function mergeDiscoveryProjects(builder, registry, entries, { installationKey }) {
  const byProjectId = new Map();
  if (!entries?.length) return { byProjectId };
  const groups = new Map();
  for (const entry of entries) {
    if (entry.nested || !entry.repositoryKey) continue;
    if (!groups.has(entry.repositoryKey)) groups.set(entry.repositoryKey, []);
    groups.get(entry.repositoryKey).push(entry);
  }
  const repositoryResourceIdFor = repositoryResourceIdsForGroups(
    builder, groups, installationKey, (entry) => entry.breadcrumb?.at(-1) ?? 'repository',
  );
  for (const entry of entries) {
    const projectEntry = {
      projectId: entry.projectId,
      projectKind: PROJECT_KINDS.includes(entry.projectKind) ? entry.projectKind : entry.worktree === true ? 'worktree' : entry.repositoryKey || entry.submoduleOfProjectId ? 'git' : 'unknown',
      breadcrumb: entry.breadcrumb ?? [],
      repositoryResourceId: (!entry.nested && entry.repositoryKey)
        ? repositoryResourceIdFor.get(entry.repositoryKey) ?? null : null,
      worktree: entry.worktree ?? null,
    };
    byProjectId.set(entry.projectId, projectEntry);
    if (entry.path) registry.set(entry.path, projectEntry);
  }
  return { byProjectId };
}

/**
 * Merge the lexical (`legacyRows`, from footprint.projects) and authoritative
 * (`discoveryProjects`, from `discovery.projects`) project registries.
 *
 * @returns {{ registry: Map<string, object>, byProjectId: Map<string, object> }}
 */
export function mapProjects(builder, { legacyRows, discoveryProjects }, { installationKey }) {
  const registry = mapLexicalProjects(builder, legacyRows, { installationKey });
  const { byProjectId } = mergeDiscoveryProjects(builder, registry, discoveryProjects, { installationKey });
  return { registry, byProjectId };
}

/**
 * Guarantee every project-scoped placement has a registry entry: a
 * `ManagementInventory` project placement is NEVER allowed `projectId: null`
 * (model.mjs's own contract), so a project path that neither the lexical
 * census nor `discovery.projects` ever discovered — an agent-managed
 * worktree the scan does not walk, for example — still gets a verified,
 * opaque identity derived from its own lexical root. It never joins a
 * repository group: no verified remote or `repositoryKey` evidence exists
 * for a path nothing actually discovered as a project.
 *
 * @param {Map<string, object>} registry mutated in place
 * @param {string[]} paths candidate project paths (already-registered ones
 *   are filtered out; safe to pass duplicates or a mixed list)
 */
export function registerFallbackProjectPaths(registry, paths, { installationKey }) {
  const unregistered = [...new Set(paths)].filter((path) => path && !registry.has(path));
  if (!unregistered.length) return;
  const breadcrumbs = computeBreadcrumbs(unregistered.map((path) => ({ path })));
  for (const [row, breadcrumb] of breadcrumbs) {
    registry.set(row.path, {
      projectId: projectIdentity({ lexicalRoot: row.path }, installationKey),
      breadcrumb, repositoryResourceId: null, projectKind: 'unknown',
    });
  }
}

/** Emit one instruction-context-file placement. Shared by the flat
 *  `discovery.instructionFiles` list (looked up by path) and the nested
 *  `discovery.projects[].instructionFiles` shape (already holding its
 *  project's resolved identity) so both close MNT-INV-006's
 *  instruction-context-file coverage the same way. Returns the placementId
 *  so a caller (submodule-of edge derivation) can use it as the project's
 *  representative placement. */
function emitInstructionFilePlacement(builder, ctx, { file, projectEntry, locatorKey, technicalDetails = [] }) {
  const { installationKey, now, environmentId } = ctx;
  // Logical identity is kind + name + host + a bounded definition digest
  // WHERE VERIFIED — never the project. Every project's CLAUDE.md is a
  // separate PLACEMENT of "the CLAUDE.md a person recognizes"; only a
  // verified content digest, not the project boundary, proves two copies are
  // actually different definitions (see catalogResourceId in projection.mjs
  // for the identical rule applied to catalog capability kinds).
  const resourceId = resourceIdentity({
    kind: 'instruction-context-file', hostNamespace: file.host, sourceSelector: file.name,
    definitionDigest: file.digest ?? null,
  }, installationKey);
  builder.upsertResource(resourceId, { kind: 'instruction-context-file', displayName: file.name, namespace: file.host });
  const administrativeScope = projectEntry ? 'project' : (file.scope ?? 'user');
  const placementId = placementIdentity({
    resourceId, environmentId, administrativeScope, projectId: projectEntry?.projectId ?? null, locationSelector: locatorKey,
  }, installationKey);
  const artifactId = artifactIdentity({ carrier: 'file', locator: locatorKey }, installationKey);
  builder.upsertArtifact(artifactId, {
    carrier: 'file', label: 'Project instruction file', ...(file.digest ? { digest: file.digest } : {}),
  });
  const bindingId = bindingIdentity({
    placementId, artifactId, consumerKind: 'host', consumerLabel: hostLabel(file.host),
  }, installationKey);
  builder.addBinding({
    bindingId, placementId, artifactId, consumerKind: 'host', consumerLabel: hostLabel(file.host),
    mechanism: `${file.host}-instruction-file`, enabled: true, effectiveScope: administrativeScope,
    grade: 'verified', affectedByProposedAction: false,
  });
  const breadcrumb = projectEntry ? [...projectEntry.breadcrumb] : [hostLabel(file.host), 'Instructions'];
  finalizePlacement(builder, {
    placementId, resourceId, environmentId, administrativeScope, projectId: projectEntry?.projectId ?? null,
    locationBreadcrumb: breadcrumb, artifactIds: [artifactId], consumerBindingIds: [bindingId],
    conditions: ['healthy'],
    evidenceScorecard: scorecardFor([
      assertion({
        subjectId: placementId, field: 'identity', value: true, grade: 'verified', authority: 'project scan',
        sourceRef: 'projects', capturedAt: new Date(now()).toISOString(),
      }),
      assertion({
        subjectId: placementId, field: 'placement', value: true, grade: 'verified', authority: 'project scan',
        sourceRef: 'projects', capturedAt: new Date(now()).toISOString(),
      }),
    ]),
    displayName: file.name, kind: 'instruction-context-file', consumerHosts: [file.host], technicalDetails,
    versions: file.digest ? { contentDigest: file.digest } : {},
    extra: { projectKind: projectEntry?.projectKind ?? 'unknown', ...(projectEntry?.repositoryResourceId ? { repositoryId: projectEntry.repositoryResourceId } : {}) },
  });
  return placementId;
}

export function mapInstructionFiles(builder, files, ctx) {
  for (const file of files ?? []) {
    const projectEntry = file.projectPath ? ctx.projects.get(file.projectPath) ?? null : null;
    emitInstructionFilePlacement(builder, ctx, { file, projectEntry, locatorKey: `${file.projectPath ?? 'user'}:${file.name}` });
  }
}

/** `Worktree: <label>` (a string label) or the generic `Linked worktree`
 *  (a bare `true`) — informational only; it never drives a condition. */
function worktreeTechnicalDetail(projectEntry) {
  if (!projectEntry?.worktree) return [];
  return [typeof projectEntry.worktree === 'string' ? `Worktree: ${projectEntry.worktree}` : 'Linked worktree'];
}

/**
 * Instruction files nested under `discovery.projects[]` entries — the
 * authoritative shape agent D's discovery scan emits (closing gap 1: no
 * upstream collector otherwise inventories CLAUDE.md/AGENTS.md). Returns
 * each project's first instruction-file placementId as its representative,
 * for `deriveSubmoduleEdges` below.
 *
 * @returns {Map<string, string>} projectId -> representative placementId
 */
export function mapDiscoveryProjectInstructionFiles(builder, discoveryProjects, ctx, byProjectId) {
  const representative = new Map();
  for (const entry of discoveryProjects ?? []) {
    const projectEntry = byProjectId.get(entry.projectId) ?? null;
    for (const file of entry.instructionFiles ?? []) {
      const placementId = emitInstructionFilePlacement(builder, ctx, {
        file, projectEntry, locatorKey: `${entry.projectId}:${file.host}:${file.name}`,
        technicalDetails: worktreeTechnicalDetail(projectEntry),
      });
      if (!representative.has(entry.projectId)) representative.set(entry.projectId, placementId);
    }
  }
  return representative;
}

/**
 * `submodule-of` edges (MNT-INV-011) between two projects' representative
 * placements. Never invents one: when either side has no instruction-file
 * placement to anchor to, the relationship is omitted rather than guessed.
 */
export function deriveSubmoduleEdges(builder, discoveryProjects, representative) {
  for (const entry of discoveryProjects ?? []) {
    if (!entry.submoduleOfProjectId) continue;
    const fromPlacementId = representative.get(entry.projectId);
    const toPlacementId = representative.get(entry.submoduleOfProjectId);
    if (!fromPlacementId || !toPlacementId) continue;
    builder.addEdge({
      fromPlacementId, toId: toPlacementId, kind: 'submodule-of', grade: 'verified', authority: 'project discovery',
    });
  }
}
