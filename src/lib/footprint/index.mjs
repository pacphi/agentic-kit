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
// KNOWN COST, deliberately accepted for v1: the deep collectors are
// synchronous, so a scan occupies the event loop in multi-second stretches.
// The tier boundary is what contains this — nothing on the cheap path walks a
// tree — and the scan yields between phases so an embedding server is not
// blocked for the whole run. Moving the walk off-thread is a separate
// decision with its own seam.
import fs from 'node:fs';
import path from 'node:path';
import {
  claudeDir, claudeSettingsPath, claudeUserMcpPath, codexConfigPath, codexDir, configDir, home,
} from '../paths.mjs';
import { loadKitConfig } from '../config.mjs';
import { defaultOpencodeDbPath } from '../usage-opencode.mjs';
import { UNKNOWN, measured, statNode, unknown } from './walk.mjs';
import { collectRuntimeCensus } from './runtime.mjs';
import { collectInstall } from './install.mjs';
import { collectStorage } from './storage.mjs';
import { collectCatalog } from './catalog.mjs';
import { probeCatalogDrift } from './catalog-evidence.mjs';
import { collectProjects } from './projects.mjs';
import { collectConsumers } from './consumers.mjs';
import { discoverProjectSources } from './project-sources.mjs';
import {
  SNAPSHOT_SECTIONS, SNAPSHOT_STALE_AFTER_MS, carryForward, readSnapshot, snapshotFreshness,
  snapshotPath, summarizeCompleteness, writeSnapshot,
} from './snapshot.mjs';

/** Same window as the project-snapshot cache: long enough that a burst of
 *  polls costs one census, short enough that the Runtime view is not lying. */
export const CHEAP_TTL_MS = 60_000;

/** Deep-scan progress phases, in order. `idle` is the state before any scan
 *  has run in this process; `done`/`failed` are terminal. */
export const SCAN_PHASES = Object.freeze([
  'idle', 'install', 'storage', 'catalog', 'projects', 'consumers', 'persist', 'done', 'failed',
]);

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

/** Hand the event loop back between deep-scan phases. Not a throttle: the
 *  collectors are synchronous, and without this an embedding HTTP server
 *  cannot answer anything at all for the whole run. */
const breathe = () => new Promise((resolve) => { setImmediate(resolve); });

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
 * Read a discovery result without deciding what it means for the caller.
 *
 * Two shapes are legitimate. `discoverProjectSources()` returns a payload whose
 * `projects` include projects that have since been DELETED — that is the point
 * of `everSeen` — so only the surviving subset can be measured, and the payload
 * itself is forwarded so the Projects section can publish everSeen/onDisk/
 * gitRepos/method rather than recomputing them from the rows it kept. A bare
 * array is an explicit catalog and is passed straight through as one.
 *
 * @param {any} result a discoverProjectSources() payload, an explicit catalog
 *   array, or whatever an injected discovery returned — including nothing
 * @returns {{ sources: object|null, catalog: Array|null, onDisk: Array }}
 */
function readDiscovery(result) {
  if (Array.isArray(result)) {
    return { sources: null, catalog: result, onDisk: result.filter((p) => p?.path) };
  }
  if (!result || typeof result !== 'object' || !Array.isArray(result.projects)) {
    return { sources: null, catalog: null, onDisk: [] };
  }
  return {
    sources: result,
    catalog: null,
    onDisk: result.projects.filter((project) => project?.path && project.exists !== false),
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
} = {}) {
  const collect = {
    runtime: collectRuntimeCensus,
    install: collectInstall,
    storage: collectStorage,
    catalog: collectCatalog,
    projects: collectProjects,
    consumers: collectConsumers,
    ...collectors,
  };
  const snapshotOpts = { ...(snapshotFile ? { file: snapshotFile } : {}), fsImpl };

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

  /** Run the five deep collectors in order, persist, invalidate the cheap
   *  cache. Never rejects: a scan that blows up records the reason in `scan`
   *  and resolves with `ok: false`, so a fire-and-forget caller (the HTTP
   *  route) cannot produce an unhandled rejection and a waiting caller (the
   *  CLI) still gets an answer. */
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
    /** @type {Record<string, any>} */
    const sections = {};
    try {
      // Yield BEFORE the first synchronous collector. `refreshDeep()` runs this
      // body up to the first await, so without this an HTTP caller that starts
      // a scan would wait out the install walk before its own response — the
      // start-or-attach route must return while the scan runs, not after it.
      await breathe();

      // Discovery is a candidate-path source shared by three collectors
      // (invariant 9). Resolve it ONCE — a ~3,200-transcript sweep — so
      // storage's learning-store nodes, the Projects table and the consumers
      // ranking describe the same set of projects.
      let discovered = null;
      try { discovered = discoverProjects({ fsImpl }); } catch { discovered = null; }
      const { sources, catalog, onDisk } = readDiscovery(discovered);
      // Only projects that still exist can be walked; the vanished ones survive
      // in the Projects section's everSeen, not as unmeasurable paths handed to
      // a collector. `null` (discovery failed) stays null — storage reports that
      // as unknown, which a zero-length array would not.
      const projectPaths = discovered ? onDisk.map((project) => project.path) : null;

      let cfg = {};
      try { cfg = loadConfig() ?? {}; } catch { cfg = {}; }

      sections.install = collect.install({ now: () => startedAt, fsImpl, ...(collectorOptions.install ?? {}) });
      await breathe();

      markPhase('storage');
      // `projects: null` is load-bearing — it means "no catalog was supplied",
      // which storage reports as unknown rather than a fabricated zero.
      sections.storage = collect.storage({
        projects: projectPaths, now: () => startedAt, fsImpl, ...(collectorOptions.storage ?? {}),
      });
      await breathe();

      markPhase('catalog');
      // The same on-disk project list storage measures. A skill defined in a
      // repo is as deployed as one in ~/.claude, so the inventory covers every
      // project rather than only the one the dashboard was launched from —
      // `?? []` keeps "discovery failed" as user scope, never as a claim that
      // no project defines anything.
      sections.catalog = collect.catalog({
        cwd, cfg, projects: projectPaths ?? [], now: () => startedAt, fsImpl,
        ...(collectorOptions.catalog ?? {}),
      });
      await breathe();

      markPhase('projects', { scanned: 0, total: onDisk.length });
      sections.projects = collect.projects({
        // Whichever shape discovery produced: a sources payload carries
        // everSeen/onDisk/gitRepos/method through to the KPIs, an explicit
        // array is measured verbatim. Both slots are null when discovery
        // failed, which makes the section report the failure rather than an
        // empty machine.
        sources,
        projects: catalog,
        now: () => startedAt,
        fsImpl,
        onProgress: ({ scanned, total, path: at }) => {
          scan = { ...scan, scanned, total, path: at ?? null };
        },
        ...(collectorOptions.projects ?? {}),
      });
      await breathe();

      // Consumers runs LAST because it is the only collector that can adopt
      // another section's figures instead of re-walking: install's tool trees
      // and — when project trees are in scope — every ProjectFootprint's
      // totalBytes, which is what keeps the toggle from walking a 175 GB
      // repository a second time in the same scan.
      markPhase('consumers');
      const measuredProjects = sections.projects?.projects;
      sections.consumers = collect.consumers({
        now: () => startedAt,
        fsImpl,
        install: sections.install ?? null,
        // Adopted footprints when the Projects phase measured any, the bare
        // discovered paths otherwise (a truncated or LOC-less projects scan
        // still leaves the ranking able to walk what it names).
        projects: Array.isArray(measuredProjects) && measuredProjects.length
          ? measuredProjects
          : projectPaths,
        includeProjectTrees: withTrees,
        ...(collectorOptions.consumers ?? {}),
      });
      await breathe();

      markPhase('persist');
      const persisted = writeSnapshotImpl(sections, { ...snapshotOpts, now: now(), asOf: startedAt });
      const finishedAt = now();
      scan = {
        ...scan,
        running: false,
        phase: 'done',
        finishedAt,
        durationMs: finishedAt - startedAt,
        // A snapshot that could not be written is a degraded convenience, not a
        // failed scan: the figures were still measured. Say so without
        // pretending the scan failed.
        error: persisted.ok ? null : `snapshot not persisted: ${persisted.error}`,
      };
      cheap = null;
      return {
        ok: true,
        asOf: startedAt,
        sections,
        completeness: summarizeCompleteness(sections),
        persisted,
        error: scan.error,
      };
    } catch (error) {
      const finishedAt = now();
      const reason = String(error?.code || error?.message || error);
      scan = {
        ...scan,
        running: false,
        phase: 'failed',
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: reason,
      };
      cheap = null;
      // Whatever DID complete is returned rather than discarded — one failed
      // section must not erase three measured ones.
      return {
        ok: false,
        asOf: startedAt,
        sections,
        completeness: summarizeCompleteness(sections),
        persisted: null,
        error: reason,
      };
    }
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
