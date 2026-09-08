// ADR-0048 facade inventory methods: `refreshInventory`, the path-free reads
// (`report`, `inventory`, `placement`, `guidance`), and the owner-protected
// `revealLocator`. Every read here loads the last-good snapshot written by
// `refreshInventory` — none of them run a collector, a provider, the
// network, or a credential check (MNT-PERF-001).
import path from 'node:path';

import { latestSnapshot } from '../../model-inventory/store.mjs';
import { mutationBlocksForGuidance } from './correlation.mjs';
import { collectMcpRegistrationFacts, probeDependencies } from './dependency-probes.mjs';
import { admitGuidance, inspectorFor } from './guidance.mjs';
import {
  MANAGEMENT_QUERY_SCHEMA, assertManagementInventory, deepFreeze, isOpaqueId, isProhibitedLabel, opaqueId,
} from './model.mjs';
import { buildManagementInventory } from './projection.mjs';
import { createDefaultMaintenanceProviderRegistry } from '../provider-registry.mjs';
import { runInventoryQuery } from './query.mjs';
import { resolveModelSnapshot } from './service-context.mjs';
import { listMaintenanceReceiptsReadOnly } from '../transaction-store.mjs';

/** Read-only maintenance-action provider detections. `maintenance.providerEvidence()`
 * is the real source (T's registry + `detect()` facts, already single-flight
 * and mutation-lock-aware) and is used whenever it exists. The registry this
 * facade builds itself is a fallback ONLY for a legacy/stub `maintenance`
 * that does not implement `providerEvidence` (some tests construct one by
 * hand) — never the normal production path. Detection failures degrade to
 * `{ status: 'unavailable' }` rather than aborting the whole refresh over one
 * provider. */
async function resolveProviderEvidence(ctx, footprint) {
  if (typeof ctx.maintenance.providerEvidence === 'function') {
    const { registry, detections } = await ctx.maintenance.providerEvidence();
    return { providers: registry, detections };
  }
  const registry = createDefaultMaintenanceProviderRegistry({ ...ctx.providerOptions, footprint });
  const detections = new Map();
  for (const [id, provider] of registry) {
    try {
      // Providers are probed sequentially and read-only; the set is small
      // (single digits), so a plain await-in-loop is clearer than Promise.all
      // here and keeps one provider's failure from ever hiding beside another's.
      detections.set(id, await provider.detect());
    } catch {
      detections.set(id, { status: 'unavailable', complete: false });
    }
  }
  return { providers: registry, detections };
}

/** Verified command-availability facts for every MCP registration
 * (`discovery.dependencyProbes`, projection.mjs's gap 4) — read-only,
 * lstat-bounded, never executes anything (see dependency-probes.mjs's own
 * header). `ctx.paths` supplies the three well-known host config file paths;
 * a host whose path helper is absent contributes no facts rather than
 * throwing. */
function collectDependencyProbes(ctx) {
  const configPaths = {
    claudeJson: ctx.paths.claudeUserMcpPath?.(),
    codexConfigToml: ctx.paths.codexConfigPath?.(),
    opencodeConfig: ctx.paths.opencodeConfigPath?.(),
  };
  const facts = collectMcpRegistrationFacts({ fsImpl: ctx.fsImpl, paths: configPaths });
  const pathEntries = String(ctx.env?.PATH ?? '').split(path.delimiter).filter(Boolean);
  return probeDependencies({
    facts, pathEntries, fsImpl: ctx.fsImpl, platform: ctx.platform,
  });
}

/** The PRESENT user-level instruction files D's automatic sources already
 * detected (claude-user's CLAUDE.md, codex-user's AGENTS.md), reshaped into
 * `discovery.instructionFiles`' flat evidence shape. User-level files carry
 * no `projectPath` — that field exists only for the project-scoped fallback
 * path this facade does not otherwise populate (project instruction files
 * arrive through `discovery.projects[].instructionFiles` instead). */
function collectUserInstructionFiles(ctx) {
  const files = [];
  for (const source of ctx.listSources()) {
    for (const file of source.instructionFiles ?? []) {
      if (!file.present) continue;
      files.push({ host: file.host, name: file.name, scope: 'user', ...(file.digest ? { digest: file.digest } : {}) });
    }
  }
  return files;
}

/** Best-effort `discovery.modelStorage` (projection.mjs's documented
 * EXTENSION field, keyed by `modelSnapshot.models[].identity`), built ONLY
 * when the optional ollama-model-remove provider is registered and reports
 * available tag evidence. Correlates by `model.key.modelId === tag.name`,
 * the one field both the model-inventory snapshot and the Ollama tags API
 * agree on for an ollama-provider model. See the swarm report: this join is
 * speculative (no shared contract names the join key explicitly) and never
 * asserts a claim the underlying evidence cannot support. */
function buildModelStorage(modelSnapshot, detections) {
  const facts = detections?.get?.('ollama-model');
  if (!facts || facts.status !== 'available' || !Array.isArray(facts.tags)) return {};
  const tagByName = new Map(facts.tags.map((tag) => [tag.name, tag]));
  const storage = {};
  for (const model of modelSnapshot?.models ?? []) {
    if (model?.key?.provider !== 'ollama' || !model.identity) continue;
    const tag = tagByName.get(model.key.modelId);
    if (!tag || !Number.isFinite(tag.sizeBytes)) continue;
    const sharedCount = modelSnapshot?.blobSharing?.[tag.digest];
    const hasSharedCount = Number.isFinite(sharedCount);
    storage[model.identity] = {
      logicalBytes: tag.sizeBytes,
      physicalBytes: hasSharedCount && sharedCount > 1 ? 0 : tag.sizeBytes,
      sharedBlobs: hasSharedCount ? Math.max(0, sharedCount - 1) : null,
    };
  }
  return storage;
}

/** Every complete-or-known source's discovered projects, flattened for
 * `discovery.projects` (projection.mjs's authoritative project registry).
 * Each public, path-free `orchestrator.projects()` row is merged with its
 * owner-private absolute root from `orchestrator.projectRoots()` — P's
 * projection accepts an optional `path` on these entries to correlate
 * catalog presence rows to the same project. This merged, path-carrying
 * array feeds ONLY `buildManagementInventory`; it is never returned by any
 * facade method (`assertManagementInventory` would refuse a leaked path on
 * the inventory itself regardless). Sources the orchestrator has never
 * touched this session fall back to the project-evidence store's
 * last-published rows via `orchestrator.projects()`'s own fallback. */
export function collectDiscoveryProjects(ctx, sourceIds) {
  // Automatic host roots describe installed configuration, not user projects.
  // Plugin repositories remain inventoried through their host/plugin surfaces.
  const automatic = new Set(ctx.listSources().filter((source) => source.kind === 'automatic').map((source) => source.sourceId));
  const orchestrator = ctx.orchestrator();
  const seen = new Set();
  const projects = [];
  for (const sourceId of sourceIds) {
    if (seen.has(sourceId) || automatic.has(sourceId)) continue;
    seen.add(sourceId);
    const roots = orchestrator.projectRoots({ sourceId });
    for (const project of orchestrator.projects({ sourceId })) {
      const absoluteRoot = roots.get(project.projectId);
      projects.push(absoluteRoot ? { ...project, path: absoluteRoot } : project);
    }
  }
  return projects;
}

function loadReceipts(ctx) {
  return listMaintenanceReceiptsReadOnly(ctx.transactionsRoot, { fsImpl: ctx.fsImpl });
}

/** `orchestrator.coverage()`'s `sourceId` is D's discovery-layer identity: an
 * already-opaque `src_…` id for a user-added exact-project/collection-root
 * source, but the RAW curated string (`'ollama'`, `'claude-user'`, ...) for
 * an automatic source — that raw id is the stable, intentionally non-opaque
 * key `setAutomaticSource`/`discovery().automaticSources[].id`/orchestrator
 * start/pause/resume/stop all address it by, so it is never opaque-ized
 * anywhere in the discovery slice itself. `SourceCoverage.sourceId` inside
 * the inventory, though, must be opaque (`assertManagementInventory`'s
 * `assertCoverage`) — this is the one place that boundary is crossed, ONLY
 * for the copy handed to `buildManagementInventory`; every other use of
 * `orchestrator.coverage()` in this module keeps the raw id so it still
 * matches the orchestrator's own internal keying (`projects`/`projectRoots`).
 *
 * The four non-filesystem automatic sources (runtimes, package managers,
 * Ollama, providers) are dropped entirely here: `SourceCoverage` describes a
 * filesystem walk, and these never have one — their own completeness is
 * already carried by the provider detections already folded into the
 * inventory. Reporting them as "not scanned" here duplicated the Inventory
 * banner's source count for no evidence gain; they still appear in
 * `discovery()`/`scanProgress()` (the Discovery panel), which correctly
 * describes them as covered by the provider check instead. */
function projectionSourceCoverage(ctx, rawCoverage) {
  const filesystemSourceIds = new Set(
    ctx.listSources().filter((source) => source.filesystem !== false).map((source) => source.sourceId),
  );
  return rawCoverage
    .filter((entry) => filesystemSourceIds.has(entry.sourceId))
    .map((entry) => (isOpaqueId(entry.sourceId, 'src') ? entry : {
      ...entry, sourceId: opaqueId('src', { automatic: entry.sourceId }, ctx.installationKey),
    }));
}

/** One refresh's full evidence gather + projection + guidance admission +
 * disposition invalidation, run under `ctx.state.refreshFlight`'s
 * single-flight guard (MNT-PERF-008). Returns the NEW inventory (with
 * guidance-admitted `guidanceEntries`/`guidanceLane`) plus its private
 * locators; never persists on its own — the caller decides whether to keep
 * a partial result (it never does).
 */
async function gatherAndProject(ctx, { deep }) {
  if (deep) await ctx.collector.refreshDeep();
  const footprint = await ctx.collector.read();
  const modelSnapshot = resolveModelSnapshot(ctx, latestSnapshot);
  const providerDetections = await ctx.collectIntegrationFacts({
    cwd: process.cwd(), cfg: ctx.loadConfig(), env: ctx.env,
  });
  const receipts = loadReceipts(ctx);
  const orchestrator = ctx.orchestrator();
  const rawSourceCoverage = orchestrator.coverage();
  const discoveryProjects = collectDiscoveryProjects(ctx, rawSourceCoverage.map((entry) => entry.sourceId));
  const instructionFiles = collectUserInstructionFiles(ctx);
  const dependencyProbes = collectDependencyProbes(ctx);
  const { providers, detections } = await resolveProviderEvidence(ctx, footprint);
  const modelStorage = buildModelStorage(modelSnapshot, detections);
  const sourceCoverage = projectionSourceCoverage(ctx, rawSourceCoverage);

  const { inventory: projected, privateLocators } = buildManagementInventory({
    footprint,
    modelSnapshot,
    hookReadModel: ctx.hookReadModel,
    providerDetections,
    receipts,
    sourceCoverage,
    discovery: {
      instructionFiles, dependencyProbes, installResourceKinds: {}, modelStorage,
      pluginEvidence: { claude: detections.get('claude-plugin'), codex: detections.get('codex-plugin') },
      projects: discoveryProjects,
    },
    environment: { platform: ctx.platform },
    installationKey: ctx.installationKey,
    now: ctx.now,
  });

  const mutationBlocks = mutationBlocksForGuidance(
    ctx.maintenance.mutationBlocks(), projected, { currentEnvironmentId: ctx.environmentId },
  );
  // Invalidate stale dispositions against the NEW inventory before admission
  // reads them back, so a resurfaced condition is never suppressed by a
  // disposition the fresh evidence has already outdated.
  ctx.dispositionStore.invalidateDispositions({ inventory: projected, now: new Date(ctx.now()) });
  const { inventory } = admitGuidance({
    inventory: projected,
    providers,
    detections,
    receipts,
    recipes: ctx.allRecipes(),
    dispositions: ctx.dispositionStore.activeDispositions(new Date(ctx.now())),
    mutationBlocks,
    now: () => new Date(ctx.now()),
    installationKey: ctx.installationKey,
  });
  return { inventory: assertManagementInventory(inventory), privateLocators };
}

const LOCAL_PATH_LIKE = /(?:^|[\s"'([{=:])(?:file:\/\/\/?|~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?!\/))/u;
const MAX_REFRESH_MESSAGE_CHARS = 200;

/** D6b: `lastRefresh.message` is the ONE place a caught error's own text
 *  could leak a path or a prohibited label into a wire-facing field — every
 *  other error surface in this facade passes the raw Error through (its
 *  `.message` was never asserted path-free). Bounded to 200 chars; a message
 *  that looks like it names a local path, or that trips the prohibited-label
 *  check, is replaced outright rather than partially redacted. */
function sanitizeRefreshMessage(message) {
  if (typeof message !== 'string' || !message) return undefined;
  const bounded = message.length > MAX_REFRESH_MESSAGE_CHARS
    ? `${message.slice(0, MAX_REFRESH_MESSAGE_CHARS - 3)}...` : message;
  if (LOCAL_PATH_LIKE.test(bounded) || isProhibitedLabel(bounded)) {
    return 'An internal detail was omitted from this message.';
  }
  return bounded;
}

function lastRefreshOk(ctx) {
  return { status: 'ok', at: new Date(ctx.now()).toISOString() };
}

/** Written at the START of a refresh so a concurrent `report()`/`inventory()`
 * can say the build is in progress rather than "never built" (real builds
 * take seconds on a large footprint; the dashboard polls until it settles). */
function lastRefreshRunning(ctx) {
  return { status: 'running', at: new Date(ctx.now()).toISOString() };
}

function lastRefreshFailed(ctx, error) {
  const message = sanitizeRefreshMessage(error?.message);
  return {
    status: 'failed',
    at: new Date(ctx.now()).toISOString(),
    ...(typeof error?.code === 'string' && error.code ? { code: error.code } : {}),
    ...(message ? { message } : {}),
  };
}

/** Rebuild the ManagementInventory from live evidence and persist it as the
 * new last-good snapshot (MNT-INV-001). Concurrent calls share one flight
 * (MNT-PERF-008). A failed build throws and NEVER touches the persisted
 * snapshot — the previous last-good inventory stays authoritative
 * (MNT-PERF-007). Every outcome — success or failure — is recorded to
 * `lastRefresh` (D6b), surfaced through `report()`/`inventory()`/`guidance()`,
 * so a failed refresh is never silently invisible on the wire. Returns a
 * method taking `{ deep?: boolean }`. */
export function refreshInventory(ctx) {
  return async function refresh({ deep = false } = {}) {
    if (ctx.state.refreshFlight) return ctx.state.refreshFlight;
    const flight = (async () => {
      try {
        ctx.lastRefreshStore.write(lastRefreshRunning(ctx));
        const { inventory, privateLocators } = await gatherAndProject(ctx, { deep });
        ctx.inventorySnapshotStore.write(inventory);
        ctx.locatorStore.write(privateLocators);
        ctx.state.privateLocators = privateLocators;
        ctx.lastRefreshStore.write(lastRefreshOk(ctx));
        return deepFreeze({ inventoryId: inventory.inventoryId, capturedAt: inventory.capturedAt });
      } catch (error) {
        ctx.lastRefreshStore.write(lastRefreshFailed(ctx, error));
        throw error;
      }
    })();
    ctx.state.refreshFlight = flight;
    try {
      return await flight;
    } finally {
      ctx.state.refreshFlight = null;
    }
  };
}

/** The last-good inventory, or `null` when none has ever been built. */
export function loadLastGoodInventory(ctx) {
  return ctx.inventorySnapshotStore.read();
}

/** The most recent `refreshInventory` outcome, or `null` before any refresh
 * has ever run (D6b). */
function lastRefresh(ctx) {
  return ctx.lastRefreshStore.read();
}

function laneCounts(entries) {
  const counts = {
    apply: 0, steps: 0, decision: 0, update: 0, recovery: 0, total: entries.length,
  };
  for (const entry of entries) counts[entry.lane] = (counts[entry.lane] ?? 0) + 1;
  return counts;
}

/** `report()` — a bounded summary of the last-good inventory (MNT-PERF-001).
 * Never a fake row when nothing has been saved yet. */
export function report(ctx) {
  return async function reportSummary() {
    const inventory = loadLastGoodInventory(ctx);
    if (!inventory) {
      return deepFreeze({
        scanRequired: true, inventoryId: null, capturedAt: null, sourceFingerprint: null,
        resourceCount: 0, placementCount: 0, guidanceCounts: laneCounts([]), lastRefresh: lastRefresh(ctx),
      });
    }
    return deepFreeze({
      scanRequired: false,
      inventoryId: inventory.inventoryId,
      capturedAt: inventory.capturedAt,
      sourceFingerprint: inventory.sourceFingerprint,
      resourceCount: inventory.resources.length,
      placementCount: inventory.placements.length,
      guidanceCounts: laneCounts(inventory.guidanceEntries ?? []),
      lastRefresh: lastRefresh(ctx),
    });
  };
}

/** `inventory(query)` — a page of the last-good inventory via
 * `runInventoryQuery`. Returns a `scanRequired` envelope shaped like a query
 * page, never a fake page, when nothing has been saved yet. */
export function inventoryQuery(ctx) {
  return function queryInventory(params = {}) {
    const inventory = loadLastGoodInventory(ctx);
    if (!inventory) {
      return deepFreeze({
        scanRequired: true, schema: MANAGEMENT_QUERY_SCHEMA, inventoryId: null, total: 0,
        groups: [], facetCounts: {}, sortGroups: [], partialSources: [], appliedFacets: {},
        lastRefresh: lastRefresh(ctx),
      });
    }
    return deepFreeze({ scanRequired: false, ...runInventoryQuery(inventory, params), lastRefresh: lastRefresh(ctx) });
  };
}

/** `placement({ placementId })` — the path-free nine-question inspector.
 * Returns `{ scanRequired: true }` when no inventory has been built yet; an
 * unknown placementId against a real inventory still throws (a genuine
 * caller error, not an evidence gap). */
export function placement(ctx) {
  return function placementInspector({ placementId }) {
    const inventory = loadLastGoodInventory(ctx);
    if (!inventory) return deepFreeze({ scanRequired: true });
    const receipts = loadReceipts(ctx);
    const inspector = inspectorFor(inventory, placementId, {
      guidance: inventory.guidanceEntries,
      receipts,
      dispositions: ctx.dispositionStore.activeDispositions(new Date(ctx.now())),
      coverage: inventory.sourceCoverage,
    });
    const locator = ctx.state.privateLocators.get(placementId) ?? ctx.locatorStore.read().get(placementId);
    return deepFreeze({ ...inspector, whereIsIt: { ...inspector.whereIsIt, revealAvailable: Boolean(locator?.path), locationNote: locator?.path ? null : 'No local file path was measured for this resource.' } });
  };
}

/** `revealLocator({ placementId })` — owner-only, the sole place a real
 * filesystem path or config selector ever leaves this facade. Returns
 * `{ placementId, breadcrumb, exactPath, selector?, file? }` (`path` is kept
 * as an alias of `exactPath` for callers written against the earlier shape). */
export function revealLocator(ctx) {
  return function reveal({ placementId }) {
    const locator = ctx.state.privateLocators.get(placementId) ?? ctx.locatorStore.read().get(placementId);
    if (!locator) throw new TypeError(`no revealable locator for placement: ${placementId}`);
    const inventory = loadLastGoodInventory(ctx);
    const owner = inventory?.placements?.find((entry) => entry.placementId === placementId);
    return {
      placementId,
      breadcrumb: owner ? [...owner.locationBreadcrumb] : [],
      exactPath: locator.path ?? null,
      path: locator.path ?? null,
      ...(locator.selector != null ? { selector: locator.selector } : {}),
      ...(locator.file != null ? { file: locator.file } : {}),
    };
  };
}

const QUERY_PAGE_LIMIT = 200;

/** Every placementId `runInventoryQuery(inventory, {scope, facets, view:'all'})`
 * matches, collected by paging through every result page — this is how
 * `guidance()` gets full facet parity with `inventory()`'s query engine
 * (scope lens, every FACETS entry, not just `kind`) without re-implementing
 * Q's matching rules a second time. */
function placementIdsMatchingQuery(inventory, { scope, facets }) {
  const ids = new Set();
  let cursor;
  do {
    const page = runInventoryQuery(inventory, {
      scope: scope ?? 'across', view: 'all', facets: facets ?? {}, limit: QUERY_PAGE_LIMIT, cursor,
    });
    for (const group of page.groups) {
      for (const row of group.placements) ids.add(row.placementId);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

/** `guidance({ lane?, scope?, facets? })` — a lane-grouped view over the
 * last-good inventory's already-admitted guidance entries, narrowed to
 * exactly the placements `inventory()`'s own query engine would return for
 * the same `scope`/`facets` (full facet parity — every `FACETS` entry, not
 * only `kind`), plus an optional `lane` filter guidance entries alone carry. */
export function guidance(ctx) {
  /** @param {{ lane?: string|null, scope?: string|null, facets?: Record<string, string[]> }} [options] */
  return function guidanceView({ lane = null, scope = null, facets = /** @type {Record<string, string[]>} */ ({}) } = {}) {
    const inventory = loadLastGoodInventory(ctx);
    const lanes = {
      apply: [], steps: [], decision: [], update: [], recovery: [],
    };
    if (!inventory) return deepFreeze({ scanRequired: true, lanes, counts: laneCounts([]), entries: [], lastRefresh: lastRefresh(ctx) });
    const matchingPlacementIds = placementIdsMatchingQuery(inventory, { scope, facets });
    const entries = (inventory.guidanceEntries ?? []).filter((entry) => {
      if (lane && entry.lane !== lane) return false;
      return matchingPlacementIds.has(entry.placementId);
    });
    for (const entry of entries) lanes[entry.lane].push(entry);
    return deepFreeze({
      scanRequired: false, lanes, counts: laneCounts(entries), entries, lastRefresh: lastRefresh(ctx),
    });
  };
}
