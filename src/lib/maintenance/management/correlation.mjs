// ADR-0048 placement <-> finding correlation (owned by the facade, agent I).
//
// `planAction` receives an opaque `placementId` from the UI/CLI/API layer,
// but the existing transaction engine (coordinator.mjs / planner.mjs /
// scanner.mjs) still addresses one exact action by the maintenance report's
// `finding.id`. This module bridges the two WITHOUT minting any new
// identity: it narrows findings to the ones whose VERIFIED resource fields
// correspond to one already-projected placement, and refuses admission
// (`code: 'PLACEMENT_FINDING_UNRESOLVED'`) unless exactly one finding
// qualifies (ADR-0048 non-negotiable #1: one exact placement, never a batch).
//
// KNOWN INTEGRATION GAP (reported to the swarm lead): the transaction
// engine's `finding.resource.id` is independently computed by scanner.mjs
// (see `catalogResource()` there) and is not guaranteed to equal the
// management projection's opaque `resourceId` for every resource kind (see
// projection.mjs's per-kind `resourceIdentity()` material, which folds in
// `hostNamespace`/`producer`/`projectId`/`definitionDigest` fields a raw
// finding does not always carry). Recomputing that HMAC bit-for-bit here
// would silently drift the moment either module's mapping changes, and
// would fail closed in a way that is very hard to diagnose. This module
// instead matches on the STRONGEST verified fields BOTH sides publish today
// — kind (mapped through `FINDING_KIND_TO_RESOURCE_KIND`), host,
// administrative scope, project scoping, and (when present) display name —
// and refuses ambiguity rather than guessing. A future change that exposes
// the finding's own opaque resourceId (or the placement's raw
// `finding.resource.id`) should replace this heuristic with an exact match.
import { ADMINISTRATIVE_SCOPES } from './model.mjs';
import { traverseDependencies } from './dependencies.mjs';

/** Maps a maintenance finding's `resource.kind` (scanner.mjs / provider
 *  vocabulary) onto the management projection's `RESOURCE_KINDS` vocabulary.
 *  An unmapped kind passes through unchanged (the two vocabularies already
 *  agree for most kinds — `skill`, `model`, `hook`, `agent`, `runtime`). */
export const FINDING_KIND_TO_RESOURCE_KIND = Object.freeze({
  plugin: 'plugin',
  skill: 'skill',
  mcpServer: 'mcp-registration',
  'mcp-registration': 'mcp-registration',
  hook: 'hook',
  agent: 'agent',
  command: 'command-prompt',
  model: 'model',
  daemon: 'executable',
  executable: 'executable',
  runtime: 'runtime',
  'stale-npx-env': 'cache',
  storage: 'cache',
  'project-file': 'instruction-context-file',
  'provider-configuration': 'provider-configuration',
  'credential-readiness': 'credential-readiness',
});

function mappedResourceKind(findingKind) {
  return FINDING_KIND_TO_RESOURCE_KIND[findingKind] ?? findingKind;
}

/** True when a finding's free-text `scope` ("user", "machine",
 *  "project + shared", ...) is compatible with a placement's stored
 *  `administrativeScope`. Tolerant of the scanner's compound scope strings;
 *  never widens a project-scoped finding into matching a non-project
 *  placement or vice versa. */
function scopeMatches(findingScope, administrativeScope) {
  if (!findingScope) return true;
  if (!ADMINISTRATIVE_SCOPES.includes(administrativeScope)) return false;
  const normalized = String(findingScope).toLowerCase();
  if (normalized.includes('project')) return administrativeScope === 'project';
  if (normalized === 'machine') return administrativeScope === 'machine' || administrativeScope === 'system';
  if (normalized === 'unknown') return true;
  return normalized === administrativeScope;
}

function hostMatches(findingHost, placement) {
  if (!findingHost) return true;
  if (placement.hostNamespace && placement.hostNamespace === findingHost) return true;
  return (placement.consumerHosts ?? []).includes(findingHost);
}

function nameMatches(findingName, placement) {
  if (!findingName) return true;
  return placement.displayName === findingName;
}

/** A finding naming a `projectRef` must correlate only to a project-scoped
 *  placement, and vice versa — this is the one project-identity signal both
 *  sides publish without decoding either one's opaque/hashed project id. */
function projectScopeMatches(finding, placement) {
  const projectish = Boolean(finding.resource?.projectRef);
  return projectish === (placement.administrativeScope === 'project');
}

/** True when a finding's resource is compatible with a guidance entry's own
 *  `findingResourceKey` (`{kind, id?, host?, scope?}`, Q's admitted-apply-lane
 *  hint — see guidance.mjs's `computeApplyEntries`). `key.scope` is an
 *  ADMINISTRATIVE_SCOPES value (Q's own vocabulary), unlike a finding's
 *  free-text `resource.scope`, so it goes through the same tolerant
 *  `scopeMatches` normalizer rather than a strict string compare. `key.id` is
 *  intentionally NOT checked here — some providers' `findingResourceKey.id`
 *  (codex-mcp's `mcp:codex:<name>`) does not equal the scanner's own finding
 *  id, so `id` is used only as a later disambiguating hint, never a filter. */
function resourceMatchesKey(resource, key) {
  if (!key) return true;
  if (key.kind && mappedResourceKind(key.kind) !== mappedResourceKind(resource.kind)) return false;
  if (key.host && resource.host !== key.host) return false;
  if (key.scope && !scopeMatches(resource.scope, key.scope)) return false;
  return true;
}

function findingCorrelatesWithPlacement(finding, placement, findingResourceKey) {
  const resource = finding?.resource;
  if (!resource) return false;
  if (mappedResourceKind(resource.kind) !== placement.kind) return false;
  if (!scopeMatches(resource.scope, placement.administrativeScope)) return false;
  if (!hostMatches(resource.host, placement)) return false;
  if (!nameMatches(resource.name, placement)) return false;
  if (!projectScopeMatches(finding, placement)) return false;
  if (!resourceMatchesKey(resource, findingResourceKey)) return false;
  return true;
}

function unresolved(message, extra = {}) {
  return Object.assign(new Error(message), { code: 'PLACEMENT_FINDING_UNRESOLVED', ...extra });
}

/**
 * Resolve the exact maintenance finding a placement corresponds to. Throws
 * `code: 'PLACEMENT_FINDING_UNRESOLVED'` for an unknown placement, zero
 * matches, or more than one match. `findingResourceKey` (an admitted
 * apply-lane guidance entry's own hint, when the caller supplied a
 * `guidanceId`) narrows by kind/host/scope directly and, when the narrowed
 * set is still ambiguous, disambiguates by an exact `resource.id` match —
 * but only when using it actually resolves to exactly one finding, so a
 * provider whose hint id does not equal the scanner's id (codex-mcp) still
 * resolves correctly from the placement-only match.
 * @param {{ inventory: any, findings?: any[], placementId: string,
 *           findingResourceKey?: { kind?: string, id?: string, host?: string, scope?: string } }} options
 * @returns {{ findingId: string, finding: any, placement: any }}
 */
export function resolvePlacementFinding({
  inventory, findings = [], placementId, findingResourceKey = null,
}) {
  const placement = (inventory?.placements ?? []).find((entry) => entry.placementId === placementId);
  if (!placement) throw unresolved(`unknown placement: ${placementId}`, { placementId, matchCount: 0 });
  const matches = findings.filter((finding) => findingCorrelatesWithPlacement(finding, placement, findingResourceKey));
  if (matches.length === 0) {
    throw unresolved('no maintenance finding corresponds to this exact placement', { placementId, matchCount: 0 });
  }
  if (matches.length > 1 && findingResourceKey?.id) {
    const exact = matches.filter((finding) => finding.resource?.id === findingResourceKey.id);
    if (exact.length === 1) return { findingId: exact[0].id, finding: exact[0], placement };
  }
  if (matches.length > 1) {
    throw unresolved('more than one maintenance finding corresponds to this exact placement', {
      placementId, matchCount: matches.length,
    });
  }
  return { findingId: matches[0].id, finding: matches[0], placement };
}

/** Placements whose verified fields correspond to a resource identity key
 *  (`{kind, host, scope}` — the shape `coordinator.mjs#mutationBlocks`
 *  reports as `placementKeys`). Used to translate the transaction engine's
 *  resource-identity tuples into opaque placementIds for `admitGuidance`
 *  WITHOUT minting new identity. Deliberately permissive: an ambiguous key
 *  (no `name` to disambiguate on) correlates to every candidate placement,
 *  because for a write BLOCK the fail-closed direction is to block too much
 *  rather than too little. */
export function placementsForResourceKey(inventory, key, { environmentId = null } = {}) {
  if (!key) return [];
  const mappedKind = mappedResourceKind(key.kind);
  return (inventory?.placements ?? []).filter((placement) => {
    if (mappedKind && placement.kind !== mappedKind) return false;
    if (environmentId && placement.environmentId !== environmentId) return false;
    if (!scopeMatches(key.scope, placement.administrativeScope)) return false;
    if (!hostMatches(key.host, placement)) return false;
    return true;
  });
}

/** Placements that (transitively, bounded) depend on any placement in
 *  `directIds` — a backward dependency-edge traversal from each one, per
 *  `dependencies.mjs#traverseDependencies`'s "what depends on the start"
 *  direction. Never includes a placement already in `directIds` itself. */
function boundedDependents(inventory, directIds) {
  const dependents = new Set();
  for (const placementId of directIds) {
    // `traverseDependencies`'s backward direction reports each hop as
    // `{from: <node expanded from>, to: <newly discovered dependent>}` — the
    // dependent we want is `to`; `from` is just the walk's current node
    // (equal to `placementId` itself at depth 1), so collecting it instead
    // would silently miss every real dependent.
    const { visited } = traverseDependencies(inventory, placementId, { direction: 'backward' });
    for (const { to } of visited) dependents.add(to);
  }
  for (const id of directIds) dependents.delete(id);
  return dependents;
}

function environmentOf(inventory, placementId) {
  return (inventory?.placements ?? []).find((entry) => entry.placementId === placementId)?.environmentId ?? null;
}

/**
 * Bridge `coordinator.mjs#mutationBlocks`' output shape (`{receiptId, status,
 * placementKeys, placementIds, environmentScope, broad}` — T now resolves
 * `placementIds` directly for any action that carried an opaque
 * `placementId`, with `placementKeys` as the fallback for older receipts)
 * into the shape `guidance.mjs#admitGuidance` expects (`{receiptId,
 * placementIds, environmentId, dependents, broad}`): unions T's own
 * `placementIds` with anything `placementKeys` additionally correlates,
 * resolves `environmentScope:'current'` to the real current environment id,
 * and adds the bounded set of placements that depend on the blocked ones
 * (ADR-0048 §10: a block covers "its affected placement, environment, and
 * verified dependents"). A `broad` (integrity-failure) block cannot name an
 * exact environment, so it fans out into one broad block PER environment in
 * the inventory — omitting that fan-out would let `admitGuidance`'s
 * `environmentId`-scoped broad check silently match nothing and admit apply
 * guidance it should have blocked.
 * @param {any[]} rawBlocks
 * @param {any} inventory
 * @param {{ currentEnvironmentId?: string|null }} [options]
 */
export function mutationBlocksForGuidance(rawBlocks, inventory, { currentEnvironmentId = null } = {}) {
  const environments = inventory?.environments ?? [];
  return (rawBlocks ?? []).flatMap((block) => {
    if (block.broad) {
      return environments.map((environment) => ({
        receiptId: block.receiptId, placementIds: [], dependents: [], broad: true,
        environmentId: environment.environmentId,
      }));
    }
    const keyMatches = (block.placementKeys ?? []).flatMap((key) => placementsForResourceKey(inventory, key));
    const directIds = new Set([
      ...(block.placementIds ?? []).filter((id) => environmentOf(inventory, id)),
      ...keyMatches.map((entry) => entry.placementId),
    ]);
    if (!directIds.size) return [];
    const environmentId = (block.environmentScope && block.environmentScope !== 'current')
      ? block.environmentScope
      : (currentEnvironmentId ?? environmentOf(inventory, [...directIds][0]));
    return [{
      receiptId: block.receiptId,
      placementIds: [...directIds],
      dependents: [...boundedDependents(inventory, directIds)],
      broad: false,
      environmentId,
    }];
  });
}
