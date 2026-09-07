// ADR-0048 facade discovery methods: source configuration (owner-only —
// these carry configured roots), preview-then-confirm add/remove, and the
// bounded, path-free scan lifecycle. `startScan`/`resumeScan` DRIVE a source
// to a terminal state in the background: the orchestrator runs one work
// slice synchronously, then yields between slices, and the facade keeps one
// in-flight drive per source (single-flight) until the source is complete,
// paused, stopped, or failed. Callers get `scanProgress()` back after the
// first slice and poll it; they never have to call `resumeScan` to keep a
// valid scan going (MNT-DSC-011/012: a work-slice boundary pauses work, it
// never ends a stable, finite, readable source).
import {
  addExclusion as configureAddExclusion,
  addExactProject, addCollectionRoot,
  AUTOMATIC_SOURCES,
  readDiscoveryConfiguration,
  removeExclusion as configureRemoveExclusion,
  removeSource as configureRemoveSource,
  resolveAutomaticSourceRoots,
  setAutomaticSource as configureSetAutomaticSource,
} from '../discovery/configuration.mjs';
import { previewSource as discoveryPreviewSource } from '../discovery/preview.mjs';
import { claimsAllowed, progressNarrative } from '../discovery/coverage.mjs';
import { opaqueId } from './model.mjs';

const DEFAULT_MAX_SLICES = Infinity;

/** Per-curated-source-id `filesystem` classification (true for the
 * filesystem host sources and `projects`, false for runtimes/package
 * managers/Ollama/providers), independent of whether the source is
 * currently enabled: resolved as if every automatic source were enabled, so
 * a DISABLED source still reports its true nature rather than silently
 * defaulting. `projects` never appears in the probe's own output (it only
 * expands against configured exact/collection roots, deliberately left
 * empty here) and is correctly left to the `true` default below — its
 * expansion is always a filesystem walk. */
function automaticSourceFilesystemById(ctx) {
  const probeConfiguration = {
    automaticSources: AUTOMATIC_SOURCES.map((source) => ({ ...source, enabled: true })),
    exactProjects: [], collectionRoots: [], exclusions: [],
  };
  const probed = resolveAutomaticSourceRoots({
    configuration: probeConfiguration, paths: ctx.paths, platform: ctx.platform, fsImpl: ctx.fsImpl, installationKey: ctx.installationKey,
  });
  const byOpaqueId = new Map(probed.map((source) => [source.sourceId, source.filesystem]));
  const byRawId = new Map();
  for (const source of AUTOMATIC_SOURCES) {
    const opaque = opaqueId('src', { automatic: source.id }, ctx.installationKey);
    byRawId.set(source.id, byOpaqueId.get(opaque) ?? true);
  }
  return byRawId;
}

/** `{sourceId}` and `{sourceIds}` are accepted interchangeably everywhere a
 * scan-lifecycle method takes source targets — a bare `sourceId` is just the
 * one-element case of `sourceIds`. Returns `null` (every configured source)
 * when neither is given. */
function normalizeSourceIds({ sourceId = null, sourceIds = null } = {}) {
  if (Array.isArray(sourceIds)) return sourceIds;
  if (sourceId) return [sourceId];
  return null;
}

function afterConfigChange(ctx, plan) {
  const next = plan.commit();
  ctx.rebuildOrchestrator();
  return next;
}

/** `discovery()` — owner-only: every configured root, current coverage, a
 * factual progress narrative, and bounded scan history. */
export function discovery(ctx) {
  return function discoveryOverview() {
    const configuration = readDiscoveryConfiguration({ loadConfig: ctx.loadConfig });
    const progress = scanProgress(ctx)();
    const filesystemById = automaticSourceFilesystemById(ctx);
    return {
      automaticSources: configuration.automaticSources.map((source) => ({
        ...source, filesystem: filesystemById.get(source.id) ?? true,
      })),
      exactProjects: configuration.exactProjects,
      collectionRoots: configuration.collectionRoots,
      exclusions: configuration.exclusions,
      coverage: progress.coverage,
      progress: progress.narrative,
      narrative: progress.narrative,
      evidenceChecks: progress.evidenceChecks,
      projectCoverageNote: 'Projects found by the machine measurement are included in Inventory. Only configured discovery roots contribute to the filesystem source count.',
      history: ctx.scanHistoryStore.list().map((entry) => ({
        ...entry, label: entry.label || progress.coverage.find((source) => source.sourceId === entry.sourceId)?.label || 'Source no longer configured',
      })),
    };
  };
}

/** `previewSource({ kind, root, maxDepth?, includeNetwork? })` — advisory,
 * bounded, never persisted. Remembers the exact previewed root/policy so a
 * later `saveSource` cannot be tricked into saving a different root than
 * the one the user actually reviewed (MNT-DSC-003). */
export function previewSourceMethod(ctx) {
  return function previewSourceCall({ kind, root, maxDepth = null, includeNetwork = false }) {
    const configuration = readDiscoveryConfiguration({ loadConfig: ctx.loadConfig });
    const preview = discoveryPreviewSource({
      kind, root, configuration, fsImpl: ctx.fsImpl, walk: ctx.walk, installationKey: ctx.installationKey, now: ctx.now,
    });
    return ctx.previewCache.remember({ ...preview, maxDepth, includeNetwork });
  };
}

/** `saveSource({ previewId, confirmed })` — commits exactly the previewed
 * root as an exact project or collection root. Refuses an unknown/expired
 * previewId rather than falling back to a caller-supplied root. */
export function saveSource(ctx) {
  return function saveSourceCall({ previewId, confirmed = false }) {
    const preview = ctx.previewCache.get(previewId);
    if (!preview) throw new TypeError(`unknown or expired preview: ${previewId}`);
    if (!confirmed) return { confirmed: false, preview };
    const deps = ctx.discoveryDeps();
    const plan = preview.kind === 'exact-project'
      ? addExactProject({ root: preview.root }, deps)
      : addCollectionRoot({ root: preview.root, maxDepth: preview.maxDepth, includeNetwork: preview.includeNetwork }, deps);
    const committed = afterConfigChange(ctx, plan);
    // A newly added root starts scanning on Save — there is no separate
    // "scan now" moment for a source the user just chose to include.
    const added = [...(committed?.exactProjects ?? []), ...(committed?.collectionRoots ?? [])]
      .find((entry) => entry.root === preview.root);
    if (added?.sourceId) driveSources(ctx, 'start', [added.sourceId], DEFAULT_MAX_SLICES);
    return { confirmed: true, saved: true, kind: preview.kind, root: preview.root, ...(added?.sourceId ? { sourceId: added.sourceId } : {}) };
  };
}

/** After a machine measurement (System Full scan / `ak maintain scan --deep`):
 * drive every filesystem source's discovery walk to a terminal state, wait
 * for them, then rebuild the inventory so coverage and project evidence are
 * part of it. This is the one "re-measure" path the workspace exposes. */
export function rebuildAfterMeasurement(ctx, { refreshInventory }) {
  return async function rebuildAfterMeasurementCall() {
    driveSources(ctx, 'start', null, DEFAULT_MAX_SLICES);
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.allSettled([...scanFlights(ctx).values()]);
    const inventory = await refreshInventory({ deep: false });
    return { inventory, scans: scanProgress(ctx)() };
  };
}

/** `removeSource({ sourceId, confirmed })` — unenroll a configured source
 * (an automatic source is disabled, an exact/collection root is dropped),
 * stopping any in-flight scan for it. Returns the affected preview before
 * confirmation (MNT-DSC §"remove"). */
export function removeSource(ctx) {
  return function removeSourceCall({ sourceId, confirmed = false }) {
    const plan = configureRemoveSource({ sourceId }, ctx.discoveryDeps());
    if (!confirmed) return { confirmed: false, preview: plan.preview };
    try { ctx.orchestrator().stop({ sourceId, confirmed: true }); } catch { /* never started this session */ }
    afterConfigChange(ctx, plan);
    return { confirmed: true, removed: true };
  };
}

export function setAutomaticSource(ctx) {
  return function setAutomaticSourceCall({ sourceId, enabled }) {
    const plan = configureSetAutomaticSource({ sourceId, enabled }, ctx.discoveryDeps());
    return afterConfigChange(ctx, plan);
  };
}

/** `addExclusion({ path, recursive })` — preview-then-save in one call (the
 * exclusion path is user-typed intent, exempt from the no-path rule per
 * ADR-0048 non-negotiable #11). */
export function addExclusion(ctx) {
  return function addExclusionCall({ path: exclusionPath, recursive = false }) {
    const plan = configureAddExclusion({ path: exclusionPath, recursive }, ctx.discoveryDeps());
    return afterConfigChange(ctx, plan);
  };
}

export function removeExclusion(ctx) {
  return function removeExclusionCall({ exclusionId }) {
    const plan = configureRemoveExclusion({ exclusionId }, ctx.discoveryDeps());
    return afterConfigChange(ctx, plan);
  };
}

function scanFlights(ctx) {
  ctx.state.scanFlights ??= new Map();
  return ctx.state.scanFlights;
}

function scanFailures(ctx) {
  ctx.state.scanFailures ??= new Map();
  return ctx.state.scanFailures;
}

/** Start (or continue) one background drive per source. A source already in
 * flight is left alone (single-flight); a rejected drive is recorded against
 * that source so `scanProgress()` reports it as `failed`/`io-failure` instead
 * of silently showing a stalled `scanning` row. The orchestrator's first work
 * slice runs synchronously inside the `start`/`resume` call, so the caller
 * observes real progress immediately; every later slice runs after a yield. */
function scannableSources(ctx) {
  return ctx.listSources().filter((source) => source.filesystem !== false && source.root);
}

/** An explicitly named source must be a filesystem source with a root: the
 * non-filesystem automatic sources (runtimes, package managers, Ollama,
 * providers) are covered by the provider check and the machine measurement,
 * never by a discovery walk. Refusing here (code SOURCE_NOT_SCANNABLE) keeps
 * the API and CLI from ever reporting a "scan" of nothing. */
function assertScannable(ctx, ids) {
  if (!ids) return;
  const scannable = new Set(scannableSources(ctx).map((source) => source.sourceId));
  const refused = ids.filter((id) => !scannable.has(id));
  if (refused.length) {
    throw Object.assign(new Error('This source is covered by the provider check and machine measurement, not by a discovery scan.'),
      { code: 'SOURCE_NOT_SCANNABLE', sourceIds: refused });
  }
}

/** Map any drive failure onto the closed `LIMITING_REASONS` vocabulary
 * (model.mjs) — a raw fs/orchestrator error code must never leak into
 * `SourceCoverage.limitingReason`, which is a validated enum. Only the two
 * permission-flavoured fs codes get their own reason; every other failure
 * (ENOENT, a thrown orchestrator error, a rejected promise with no code at
 * all) is reported as the generic `io-failure`. */
function classifyDriveFailure(error) {
  const code = error?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission-denied';
  return 'io-failure';
}

function driveSources(ctx, method, ids, maxSlices) {
  const flights = scanFlights(ctx);
  const failures = scanFailures(ctx);
  assertScannable(ctx, ids);
  const targets = ids ?? scannableSources(ctx).map((source) => source.sourceId);
  for (const id of targets) {
    if (flights.has(id)) continue;
    failures.delete(id);
    const flight = ctx.orchestrator()[method]({ sourceIds: [id], maxSlices })
      .catch((error) => { failures.set(id, classifyDriveFailure(error)); })
      .finally(() => { if (flights.get(id) === flight) flights.delete(id); });
    flights.set(id, flight);
  }
}

export function startScan(ctx) {
  return async function startScanCall({
    sourceId = null, sourceIds = null, deep = false, maxSlices = DEFAULT_MAX_SLICES,
  } = {}) {
    if (deep) await ctx.collector.refreshDeep();
    driveSources(ctx, 'start', normalizeSourceIds({ sourceId, sourceIds }), maxSlices);
    await new Promise((resolve) => setImmediate(resolve));
    return scanProgress(ctx)();
  };
}

export function resumeScan(ctx) {
  return async function resumeScanCall({
    sourceId = null, sourceIds = null, maxSlices = DEFAULT_MAX_SLICES,
  } = {}) {
    driveSources(ctx, 'resume', normalizeSourceIds({ sourceId, sourceIds }), maxSlices);
    await new Promise((resolve) => setImmediate(resolve));
    return scanProgress(ctx)();
  };
}

/** Wait for every in-flight background drive (optionally for the named
 * sources) to settle. Used by the CLI to report a final state and by tests;
 * the dashboard never awaits it (MNT-PERF-004). */
export function awaitScans(ctx) {
  return async function awaitScansCall({ sourceId = null, sourceIds = null } = {}) {
    const ids = normalizeSourceIds({ sourceId, sourceIds });
    const flights = scanFlights(ctx);
    const selected = ids ? ids.map((id) => flights.get(id)).filter(Boolean) : [...flights.values()];
    await Promise.allSettled(selected);
    return scanProgress(ctx)();
  };
}

/** Symmetric with `resumeScan`/`startScan`: accepts either `{sourceId}` or
 * `{sourceIds}` and returns the overall `scanProgress()` (not one source's
 * bare coverage row), so a caller pausing several sources at once reads one
 * consistent result the same way start/resume already do. */
export function pauseScan(ctx) {
  return function pauseScanCall({ sourceId = null, sourceIds = null } = {}) {
    const ids = normalizeSourceIds({ sourceId, sourceIds }) ?? [...scanFlights(ctx).keys()];
    for (const id of ids) {
      // Pausing a source that already finished (or was never started) is a
      // no-op, not an error: the caller asked for "no more work", which holds.
      // Prefer the orchestrator's own error code; keep the message-text match
      // as a fallback for one release while the code lands everywhere.
      try { ctx.orchestrator().pause({ sourceId: id }); } catch (error) {
        const notPausable = error?.code === 'SOURCE_NOT_PAUSABLE' || /cannot pause source/.test(error?.message ?? '');
        if (!notPausable) throw error;
      }
    }
    return scanProgress(ctx)();
  };
}

/** `stopScan({ sourceId, confirmed })` — stops the scan; a confirmed stop
 * also unenrolls the source from kit.json (D's `configuration.removeSource`)
 * so a stopped source does not silently resume on the next `startScan`. */
export function stopScan(ctx) {
  return function stopScanCall({ sourceId, confirmed = false }) {
    const result = ctx.orchestrator().stop({ sourceId, confirmed });
    if (confirmed && result?.confirmed) {
      const plan = configureRemoveSource({ sourceId }, ctx.discoveryDeps());
      afterConfigChange(ctx, plan);
    }
    return result;
  };
}

/** Union of this-session live coverage, the last-good snapshot for sources
 * not yet touched this session, and every remaining configured-but-never-run
 * source — reported `not-scanned` (SOURCE_COVERAGE_STATES/model.mjs), never
 * `scanning`: a source this orchestrator instance has not started, and that
 * has no last-good snapshot either, has not been scanned at all, so claiming
 * it is currently scanning would be false. `scanProgress()` still never
 * silently omits it. */
function mergedCoverage(ctx) {
  const orchestrator = ctx.orchestrator();
  const live = orchestrator.coverage();
  const touched = new Set(live.map((entry) => entry.sourceId));
  const lastGood = ctx.lastGoodDiscoveryStore.current().filter((entry) => !touched.has(entry.sourceId));
  for (const entry of lastGood) touched.add(entry.sourceId);
  const sources = ctx.listSources();
  const neverRun = sources.filter((source) => !touched.has(source.sourceId)).map((source) => ({
    sourceId: source.sourceId, environmentId: source.environmentId, state: 'not-scanned', visited: 0,
    estimated: null, completedPartitions: 0, pendingPartitions: 0, limitingReason: null,
    lastCompletedAt: null, label: source.label,
  }));
  const failures = scanFailures(ctx);
  // `filesystem` is Discovery-panel-only evidence (never carried onto the
  // inventory's own sourceCoverage, which is built straight from
  // `orchestrator.coverage()` in service-inventory.mjs, not from here): a
  // live/last-good row can only ever be a filesystem source (non-filesystem
  // sources are refused at `assertScannable`/`scannableSources`), so the
  // lookup and its `true` default are correct for every row shape.
  const filesystemBySourceId = new Map(sources.map((source) => [source.sourceId, source.filesystem !== false]));
  const rows = [...live, ...lastGood, ...neverRun];
  return rows.map((entry) => {
    const filesystem = filesystemBySourceId.get(entry.sourceId) ?? true;
    if (failures.has(entry.sourceId) && entry.state === 'scanning') {
      return { ...entry, state: 'failed', limitingReason: failures.get(entry.sourceId), filesystem };
    }
    return { ...entry, filesystem };
  });
}

/** `scanProgress()` — bounded public progress across every known source
 * (`coverage`, the SourceCoverage-shaped rows; `progress`, D's own bounded
 * per-source live phase/count rows from `orchestrator.progress()`), plus a
 * factual narrative sentence and the claims the current coverage set cannot
 * yet support (MNT-DSC-014/016). `startScan`/`resumeScan`/`pauseScan` all
 * return this same shape. */
export function scanProgress(ctx) {
  return function scanProgressCall() {
    const coverage = mergedCoverage(ctx);
    const filesystemCoverage = coverage.filter((entry) => entry.filesystem !== false);
    return {
      coverage,
      progress: ctx.orchestrator().progress(),
      narrative: progressNarrative(filesystemCoverage, { totalSources: filesystemCoverage.length }),
      evidenceChecks: coverage.filter((entry) => entry.filesystem === false).map((entry) => ({ sourceId: entry.sourceId, label: entry.label, method: 'Refresh evidence' })),
      forbiddenClaims: claimsAllowed(filesystemCoverage),
    };
  };
}
