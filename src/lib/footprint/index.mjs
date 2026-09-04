// footprint/index.mjs — the composed machine-footprint collector (ADR-0025).
//
// One collector behind two surfaces (the dashboard's System area and the
// `ak system` CLI), in two tiers that differ by orders of magnitude in cost:
//
//   CHEAP  runtime census + individually-known file stats + the last persisted
//          deep snapshot, carried forward with ITS asOf. Served on every read,
//          TTL-cached ~60s in memory following buildProjectSnapshotCache's
//          pattern in dashboard-server.mjs — machine-wide data, one entry per
//          collector instance, no per-caller key.
//   DEEP   the full storage walk + per-project LOC and stack detection +
//          cross-host catalog dedup + the ranked largest-consumers view.
//          Explicit, user-triggered, SINGLE-FLIGHT: a second request attaches
//          to the running scan instead of racing it (invariant 7). usage-index
//          keys its coalescing map by the options that change the RESULT; a
//          deep scan has exactly one identity per collector instance, so the
//          same discipline collapses to a single in-flight promise here.
//
// Honest degradation is structural, not decorative (ADR-0023, invariant 2): a
// section that has never been deep-scanned is `null` with a reason next to it,
// never an object full of zeros — there is no numeric field for a renderer to
// misread. A measured zero is a real zero and stays one.
//
// Deep collectors use synchronous filesystem APIs, but production runs them in
// one worker so dashboard reads and progress polls remain responsive. Injected
// filesystem/collector collaborators stay inline: functions are not serialized
// across the worker boundary, and hermetic tests exercise the same runner.
import fs from 'node:fs';
import path from 'node:path';
import {
  claudeDir, claudeSettingsPath, claudeUserMcpPath, codexConfigPath, codexDir, configDir, home,
} from '../paths.mjs';
import { loadKitConfig } from '../config.mjs';
import { defaultOpencodeDbPath } from '../usage-opencode.mjs';
import { UNKNOWN, measured, statNode, unknown } from './walk.mjs';
import { collectRuntimeCensus } from './runtime.mjs';
import { probeCatalogDrift } from './catalog-evidence.mjs';
import { discoverProjectSources } from './project-sources.mjs';
import {
  DEEP_SCAN_PHASES, DEFAULT_DEEP_COLLECTORS, runDeepScan,
} from './deep-scan-runner.mjs';
import { runDeepScanInWorker } from './deep-scan-engine.mjs';
import {
  SNAPSHOT_SECTIONS, SNAPSHOT_STALE_AFTER_MS, carryForward, readSnapshot, snapshotFreshness,
  snapshotPath, writeSnapshot,
} from './snapshot.mjs';

/** Same window as the project-snapshot cache: long enough that a burst of
 *  polls costs one census, short enough that the Runtime view is not lying. */
export const CHEAP_TTL_MS = 60_000;

/** Deep-scan progress phases, in order. `idle` is the state before any scan
 *  has run in this process; `done`/`failed` are terminal. */
export const SCAN_PHASES = DEEP_SCAN_PHASES;

/** Whether the ranked-consumers view walks project working trees. Off by
 *  default and deliberately: one repository on this machine is 175 GB, which is
 *  larger than every shared cache combined, so a ranking containing it is a
 *  ranking of that one repository. The exclusion is stated in the payload
 *  (`consumers.projectTrees.reason`), never silent. */
export const INCLUDE_PROJECT_TREES_DEFAULT = false;

/** Individually-known files the cheap tier can stat without a walk. Each is one
 *  lstat, so the whole list is affordable on every request — which is the
 *  point: these are the files that grow fastest between deep scans (ledgers,
 *  tee files, index caches), and a user watching one grow should not have to
 *  run a deep scan to see it move. */
function knownFileSpecs() {
  const stateRoot = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  const kit = (name) => path.join(configDir(), name);
  // [id, host, category, label, path] — the categories are STORAGE_CATEGORIES'
  // vocabulary so a known file and its deep-tier node land in the same bucket.
  const rows = [
    ['claude-history', 'claude', 'ledgers-and-logs', 'history.jsonl', path.join(claudeDir(), 'history.jsonl')],
    ['claude-settings', 'claude', 'kit-caches', 'settings.json', claudeSettingsPath()],
    ['claude-user-mcp', 'claude', 'kit-caches', '.claude.json', claudeUserMcpPath()],
    ['codex-history', 'codex', 'ledgers-and-logs', 'history.jsonl', path.join(codexDir(), 'history.jsonl')],
    ['codex-config', 'codex', 'kit-caches', 'config.toml', codexConfigPath()],
    ['opencode-store', 'opencode', 'transcripts', 'opencode.db', defaultOpencodeDbPath()],
    ['ak-usage-index', 'agentic-kit', 'kit-caches', 'usage-index.json', kit('usage-index.json')],
    ['ak-observability-workspaces', 'agentic-kit', 'kit-caches', 'observability-workspaces.json',
      kit('observability-workspaces.json')],
    ['ak-kit-config', 'agentic-kit', 'kit-caches', 'kit.json', kit('kit.json')],
    ['ak-claude-limits', 'agentic-kit', 'kit-caches', 'claude-rate-limits.json',
      kit('claude-rate-limits.json')],
    ['ak-codex-limits', 'agentic-kit', 'kit-caches', 'codex-rate-limits.json',
      kit('codex-rate-limits.json')],
    ['ak-footprint-snapshot', 'agentic-kit', 'kit-caches', 'footprint-snapshot.json', snapshotPath()],
    ['ak-runtime-debug', 'agentic-kit', 'ledgers-and-logs', 'runtime-debug.log',
      path.join(stateRoot, 'agentic-kit', 'runtime-debug.log')],
  ];
  return rows.map(([id, host, category, label, at]) => ({ id, host, category, label, path: at }));
}

/**
 * Stat the known files. ENOENT is an ABSENCE (a measured zero, presence
 * 'absent') because a file that does not exist genuinely holds no bytes; every
 * other errno is unknown-with-reason, matching walk.mjs's rootMeasurements
 * vocabulary so the two agree on what "we saw nothing" means.
 *
 * @param {{ asOf?: number, fsImpl?: typeof fs,
 *           specs?: Array<{ id: string, host: string, category: string,
 *                           label: string, path: string }> }} [options]
 */
export function knownFileNodes({ asOf = Date.now(), fsImpl = fs, specs = null } = {}) {
  return (specs ?? knownFileSpecs()).map((spec) => {
    const stat = statNode(spec.path, { fsImpl });
    if (stat.status === UNKNOWN) {
      const absent = stat.reason === 'ENOENT';
      return {
        ...spec,
        presence: absent ? 'absent' : 'degraded',
        kind: null,
        bytes: absent ? measured(0, { asOf }) : unknown(stat.reason),
        mtimeMs: null,
      };
    }
    return {
      ...spec,
      presence: 'present',
      kind: stat.kind,
      // A directory or symlink where a file was expected has no size we may
      // claim — statNode refuses to follow the link, so there is nothing to
      // report but the fact that it is not a regular file.
      bytes: stat.kind === 'file'
        ? measured(stat.bytes, { asOf })
        : unknown(`known path is a ${stat.kind}, not a file`),
      mtimeMs: stat.mtimeMs,
    };
  });
}

function freshScanState() {
  return {
    running: false,
    phase: 'idle',
    scanned: 0,
    total: 0,
    path: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
    asOf: null,
    // What the RUNNING scan is measuring, not what the next one would: `null`
    // until a scan starts, so "no scan has run" cannot read as "trees off".
    includeProjectTrees: null,
  };
}

/**
 * Build the composed collector. One instance per dashboard server (or per CLI
 * invocation) owns the TTL cache and the single-flight slot; two instances
 * would defeat both, which is why this is a factory and not module state.
 *
 * Every collaborator is injectable so a test can drive the whole composition
 * without touching the real machine — the same discipline the individual
 * collectors already follow.
 *
 * `discoverProjects` supplies candidate paths only (invariant 9). It returns a
 * discoverProjectSources() payload — every project ANY host has ever recorded a
 * session in, which is what the Projects KPI means; an array is still accepted
 * and taken as an explicit catalog, the shape the older ruflo-state discovery
 * returned.
 *
 * @param {{
 *   now?: () => number, ttlMs?: number, staleAfterMs?: number,
 *   snapshotFile?: string, fsImpl?: typeof fs, cwd?: string,
 *   loadConfig?: () => object,
 *   discoverProjects?: (options?: object) => object|Array<{ path: string, label: string }>,
 *   includeProjectTrees?: boolean,
 *   collectors?: Record<string, Function>, collectorOptions?: Record<string, object>,
 *   readSnapshotImpl?: typeof readSnapshot, writeSnapshotImpl?: typeof writeSnapshot,
 *   runWorkerImpl?: typeof runDeepScanInWorker,
 * }} [options]
 */
export function createSystemCollector({
  now = Date.now,
  ttlMs = CHEAP_TTL_MS,
  staleAfterMs = SNAPSHOT_STALE_AFTER_MS,
  snapshotFile = null,
  fsImpl = fs,
  cwd = process.cwd(),
  loadConfig = loadKitConfig,
  discoverProjects = discoverProjectSources,
  includeProjectTrees: includeProjectTreesDefault = INCLUDE_PROJECT_TREES_DEFAULT,
  collectors = {},
  collectorOptions = {},
  readSnapshotImpl = readSnapshot,
  writeSnapshotImpl = writeSnapshot,
  runWorkerImpl = runDeepScanInWorker,
} = {}) {
  const collect = {
    runtime: collectRuntimeCensus,
    ...DEFAULT_DEEP_COLLECTORS,
    ...collectors,
  };
  const snapshotOpts = { ...(snapshotFile ? { file: snapshotFile } : {}), fsImpl };
  // Production inputs (`cwd`, snapshot path, project-tree toggle) are data and
  // cross the worker boundary. Any injected function/fs or collector option is
  // an in-process contract and selects the transport-neutral runner directly.
  const useWorker = now === Date.now
    && fsImpl === fs
    && loadConfig === loadKitConfig
    && discoverProjects === discoverProjectSources
    && readSnapshotImpl === readSnapshot
    && writeSnapshotImpl === writeSnapshot
    && Object.keys(collectors).length === 0
    && Object.keys(collectorOptions).length === 0;

  /** @type {{ at: number, runtime: any, knownFiles: object,
 *           snapshot: ReturnType<typeof readSnapshot>,
 *           sections: Record<string, any>, freshness: object, catalogDrift: object }|null} */
  let cheap = null;
  /** @type {Promise<object>|null} — the single-flight slot (invariant 7). */
  let inFlight = null;
  let scan = freshScanState();
  /** Sticky across scans, because the chip that sets it reads its own state
   *  back off the LAST scan's payload: a plain rescan that silently reverted to
   *  the default would flip a control the user did not touch. */
  let includeProjectTrees = includeProjectTreesDefault === true;

  const markPhase = (phase, extra = {}) => {
    scan = { ...scan, phase, ...extra };
  };

  /** The cheap tier, memoized for `ttlMs`. Invalidated (not merely aged out)
   *  the moment a deep scan lands, so a completed rescan is visible on the
   *  very next read rather than up to a minute later. */
  async function cheapTier() {
    const at = now();
    if (cheap && at - cheap.at <= ttlMs) return cheap;

    // The runtime census never throws by contract; guard anyway so a future
    // change there cannot take the whole payload down with it.
    let runtime;
    try {
      runtime = await collect.runtime({ cwd, ...(collectorOptions.runtime ?? {}) });
    } catch (error) {
      runtime = { error: String(error?.code || error?.message || error), processes: null };
    }

    const persisted = readSnapshotImpl(snapshotOpts);
    const freshness = snapshotFreshness(persisted, { now: at, staleAfterMs });
    const catalogDrift = probeCatalogDrift(persisted.sections?.['catalog']?.sourceStamps, { fsImpl, asOf: at });
    // Carried forward, not re-stamped as current: a figure measured last week
    // is presented with last week's asOf (invariant 3).
    const sections = persisted.present
      ? Object.fromEntries(SNAPSHOT_SECTIONS.map((key) => (
        [key, persisted.sections?.[key] == null ? null : carryForward(persisted.sections[key], persisted.asOf)]
      )))
      : Object.fromEntries(SNAPSHOT_SECTIONS.map((key) => [key, null]));

    cheap = {
      at,
      runtime,
      knownFiles: { asOf: at, nodes: knownFileNodes({ asOf: at, fsImpl }) },
      snapshot: persisted,
      sections,
      freshness,
      catalogDrift,
    };
    return cheap;
  }

  /** Assemble the wire payload. The scan block is read LIVE (never from the
   *  TTL cache) so a rescan started microseconds ago already reads as running.
   */
  async function read() {
    const tier = await cheapTier();
    const { file, present, reason, completeness } = tier.snapshot;
    return {
      generatedAt: new Date(now()).toISOString(),
      platform: process.platform,
      // The census is ephemeral by invariant 5 — computed per request (within
      // the TTL window), never written to the snapshot file.
      runtime: tier.runtime,
      knownFiles: tier.knownFiles,
      ...tier.sections,
      snapshot: {
        present,
        file,
        reason,
        completeness,
        ...tier.freshness,
        catalogDrift: tier.catalogDrift,
      },
      cheapTier: { asOf: tier.at, ttlMs },
      scan: { ...scan },
    };
  }

  /** Run the five deep collectors using the appropriate execution transport.
   *  Never rejects: a failed worker or collector records the reason in `scan`
   *  and resolves with `ok: false`. */
  async function runDeep() {
    const startedAt = now();
    const withTrees = includeProjectTrees;
    scan = {
      ...freshScanState(),
      running: true,
      phase: 'install',
      startedAt,
      asOf: startedAt,
      includeProjectTrees: withTrees,
    };
    const onActivity = ({ phase, ...extra }) => markPhase(phase, extra);
    const completed = useWorker
      ? await runWorkerImpl({
        startedAt, cwd, includeProjectTrees: withTrees, snapshotFile, onActivity,
      })
      : await runDeepScan({
        startedAt,
        cwd,
        includeProjectTrees: withTrees,
        fsImpl,
        loadConfig,
        discoverProjects,
        collectors: collect,
        collectorOptions,
        snapshotOpts,
        writeSnapshotImpl,
        now,
        onActivity,
      });
    const { terminal, ...result } = completed;
    scan = { ...scan, ...terminal };
    cheap = null;
    return result;
  }

  return {
    read,

    /**
     * Start the deep scan, or attach to the one already running. Both callers
     * get the SAME promise, so two concurrent refreshes can never race each
     * other or double-write the snapshot (invariant 7).
     *
     * `includeProjectTrees` is a MEASUREMENT parameter, not a view filter:
     * project working trees are walked or they are not, so changing it requires
     * a rescan. Omitting it keeps the last value used — the chip that sets it
     * reads its own state back off the last scan's payload. A caller that
     * ATTACHES to a running scan gets that scan's parameter, not its own; the
     * result says which was used (`consumers.includeProjectTrees` and
     * `scan.includeProjectTrees`), so the answer is never mislabelled.
     *
     * @param {{ includeProjectTrees?: boolean }} [options]
     */
    refreshDeep(options = {}) {
      if (typeof options?.includeProjectTrees === 'boolean') {
        includeProjectTrees = options.includeProjectTrees;
      }
      if (inFlight) return inFlight;
      inFlight = runDeep().finally(() => { inFlight = null; });
      return inFlight;
    },

    /** Live progress, cheap enough to read on every request. */
    scanState() { return { ...scan }; },

    /** True while a deep scan holds the single-flight slot. */
    isScanning() { return inFlight != null; },

    /** Drop the TTL cache (tests, and after anything that invalidates the
     *  cheap tier out-of-band). The single-flight slot is deliberately NOT
     *  cleared — a running scan owns it until it settles. */
    invalidate() { cheap = null; },
  };
}
