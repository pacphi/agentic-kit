// dashboard-server.mjs — a read-only, localhost-only web dashboard for the kit.
//
// Zero runtime deps: a plain node:http server bound to 127.0.0.1. Routes:
//   GET /            → one self-contained HTML document (all CSS + JS inline,
//                      no external fetches — offline-first, matches the kit ethos)
//   GET /api/status  → JSON: the same subsystem rows `ak status --json` emits,
//                      PLUS version drift, the LAUNCHING project's own
//                      .claude-flow/improvement.json (if present), and an
//                      `intel` object covering the machine-wide Intelligence
//                      feature — see collectData()'s own field comments for
//                      the exact shape. `intel` is keyed off a machine-wide
//                      project catalog (dashboard/project-discovery.mjs),
//                      NOT the server's launching cwd: pass ?project=<key>
//                      (a key from intel.projects[].key, e.g. the previous
//                      response's own intel.selectedProjectKey) to pick which
//                      discovered project's detail is shown; omit it (or pass
//                      an unresolvable key) to default to the most-recently-
//                      active discovered project. intel.machineWide is always
//                      the full machine-wide rollup, independent of ?project.
//   GET /api/live    → bounded, privacy-safe live session projection
//   GET /api/live/events → resumable Server-Sent Events stream
//   GET /api/live/intelligence → SSE stream of one discovered project's
//                      intel-history.mjs combined read; one initial frame on
//                      connect, then a fresh frame whenever that project's
//                      IntelligenceWatch detects a real change. Accepts the
//                      SAME optional ?project=<key> param as /api/status,
//                      resolved identically (so both endpoints agree on what
//                      an absent/unresolvable key defaults to); a small pool
//                      keyed by resolved project path keeps at most one
//                      watcher per distinct project actually being watched.
//   GET /api/usage    → the usage Aggregate MINUS sessions[] (ADR-0009)
//   GET /api/hooks    → cached, sanitized hook configuration/runtime read model
//   GET /api/sessions → the session list, filtered + paginated
//   GET /api/session/:id → one transcript, secrets masked SERVER-side
//   GET /api/system   → the machine-footprint payload (ADR-0025): the cheap
//                      tier (runtime census + known-file stats, TTL-cached
//                      ~60s) merged with the last persisted deep snapshot,
//                      carried forward with ITS asOf. `?refresh=deep` starts
//                      or attaches to the single-flight deep scan and returns
//                      immediately with progress state; `&trees=1|0` sets
//                      whether that scan walks project working trees.
//
// The status rows are gathered by SHELLING OUT to the installed CLI
// (`node bin/agentic-kit.mjs status --json`) so we never duplicate status.mjs's
// collector logic and never touch the shared seam files. `fetchStatus` can be
// injected (tests, embedding) to bypass the shell-out.
//
// startDashboard() NEVER detaches — the caller runs it foreground and calls
// close() on SIGINT.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { driftReport, selfDrift, installedVersion } from './versions.mjs';
import { HOSTS, collectIntegrationFacts } from './providers.mjs';
import { globalRoot } from './paths.mjs';
import { drift as ruvnetBrainDrift } from './ruvnet-brain.mjs';
import { drift as ruvectorDrift, managed as ruvectorManaged } from './ruvector.mjs';
import { loadKitConfig } from './config.mjs';
import { resolveRoutes, routingSummary, divergedRoutes, retirementOf, ACTIVITIES } from './routing.mjs';
import { renderPage } from './dashboard/page.mjs';
// One constant, from a module with no imports of its own and no I/O — so this
// is a static import where usage-index.mjs is deliberately lazy (see
// lazyUsage): the reason for that laziness is the transcript walk, which this
// module does not do.
import { BASELINE_TRAILING_DAYS } from './usage-aggregate.mjs';
import { requestRejection } from './dashboard/request-security.mjs';
import { createMaintenanceDashboardApi } from './dashboard/maintenance-api.mjs';
import {
  MAINTENANCE_MUTATION_ROUTES, maintenanceMutationRejection,
} from './dashboard/maintenance-security.mjs';
import {
  readJsonSafe, mintToken, tokenMatches, sendJson, sendUnauthorized, sendNotFound, listenLoopback,
} from './loopback-server.mjs';
import { sseRoute } from './dashboard/sse.mjs';
// readHealthRing itself was moved (not duplicated) into intel-history.mjs —
// dashboard-server.mjs no longer defines it locally. It isn't called directly
// here because readIntelHistory() already composes it (as `.healthRing`,
// forwarded verbatim below); a bare `readHealthRing` import would be unused.
import { readIntelHistory, readMachineWideIntel } from './dashboard/intel-history.mjs';
import { projectCensus, projectsInScope, describeScope } from './project-census.mjs';
import { resolveProjectIdentity, safeProjectKey } from './live/project-label.mjs';
import {
  TRANSCRIPT_ROOTS,
  maskMeta,
  maskTurns,
  parseSessionId,
  resolvesInsideRoot,
  parseNamespacedSessionId,
  resolvesNamespacedInsideRoot,
} from './dashboard/session-security.mjs';

export {
  maskMeta, maskTurns, parseSessionId, resolvesInsideRoot,
  parseNamespacedSessionId, resolvesNamespacedInsideRoot,
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');

// Security review Finding 4: admin already carries a CSP (ADR-0007); the
// dashboard — a larger inline-script surface (page.mjs, live-view.mjs,
// client.mjs) that also renders transcript text, the one data source here
// that is genuinely attacker-influenced (agents paste in web pages, repo
// content) — had none. This is not "we found an XSS": esc() discipline is
// consistent across dashboard/client.mjs's ~1,200 lines.
//
// WHAT THIS CSP DOES AND DOES NOT BUY (security review SEC-13). The comment
// here used to claim it "turns one future missed esc() into a blocked console
// error instead of a working exploit". That is true of a `<script src=…>`
// injection, which `default-src 'none'` blocks, and of exfiltration, which
// `connect-src 'self'` blocks. It is NOT true of the two shapes a missed
// esc() actually produces: `script-src 'unsafe-inline'` permits inline
// `<script>alert(1)</script>` AND inline event handlers, so `<img src=x
// onerror=…>` runs — the blocked image load still fires onerror. No
// vulnerability today; the correction is here so nobody reads this header as
// licence to relax the escaping that is doing the real work.
const DASH_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",   // the two inline module scripts (live + main)
  "style-src 'unsafe-inline'",    // the one inline <style>
  "connect-src 'self'",           // fetch()/EventSource are same-origin only
  "img-src data:",                // the inline data: favicon; nothing else
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Default status provider: shell out to the installed CLI and parse its JSON.
 *  Resilient — a spawn/parse failure resolves to an honest empty payload rather
 *  than rejecting, so /api/status always answers with valid JSON. */
function shellOutStatus(cwd) {
  return () => new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(PKG_ROOT, 'bin', 'agentic-kit.mjs'), 'status', '--json'],
      { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout) => {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && Array.isArray(parsed.rows)) return resolve(parsed);
          throw new Error('unexpected shape');
        } catch {
          resolve({ overall: 'unknown', rows: [], error: err ? String(err.message || err) : 'status --json unparseable' });
        }
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Machine-wide Intelligence: project catalog + selection (ADR pending).
//
// The dashboard used to hardcode Intelligence data to the server's own
// launching cwd. This is a deliberate clean break: Intelligence is now
// machine-wide, backed by dashboard/project-discovery.mjs's catalog of every
// ruflo-initialized project on this machine, with one of them "selected" for
// detail display. Both /api/status and /api/live/intelligence resolve that
// selection identically (resolveSelectedProject below) so they can never
// disagree about what an absent/unresolvable ?project= defaults to.
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_SNAPSHOT_TTL_MS = 60_000;

/** intel-history.mjs's readIntelHistory() shape, for a selection of "no
 *  project" (discovery found zero ruflo-initialized projects on this
 *  machine) — same null/[]-on-absent conventions readIntelHistory itself
 *  uses for a single missing file, applied here for "no project at all". */
const EMPTY_SELECTED_HISTORY = { patternStore: [], graph: null, healthRing: null, globalStats: null };

/** A stable, opaque key for a discovered project, derived from its resolved
 *  absolute path — NOT from its display label, which two different projects
 *  can share (e.g. two repos both named "backend"). resolveProjectIdentity
 *  (src/lib/live/project-label.mjs, already used machine-wide for live-
 *  session project identity) hashes the project's own canonical git root
 *  path when one is found — a distinct, collision-resistant key per real
 *  project on disk. stableProjectKey alone was checked and does NOT fit
 *  here: it reduces its input to a bare directory-name label before hashing,
 *  so keying on it directly would collapse two same-named-but-different
 *  projects onto one key — exactly the ambiguity a *selection* key (unlike a
 *  *display* label, where that collision is merely cosmetic) cannot afford.
 *  resolveProjectIdentity falls back to that same label-hash only for a
 *  genuinely non-git directory, which is an acceptable degraded case. */
function keyForProject(project) {
  return resolveProjectIdentity(project.path).key;
}

/** Accept an incoming ?project= value only if it is ALREADY shaped like a
 *  genuine opaque project key (the exact `project:<16-hex>` form
 *  safeProjectKey emits) — reusing safeProjectKey's own shape check rather
 *  than duplicating its regex. Passing the raw value as both arguments means
 *  a well-formed key round-trips unchanged, while anything else (garbage,
 *  a raw path, empty) resolves to some OTHER key that will simply fail to
 *  match any discovered project below — never a fabricated key that could be
 *  echoed back as if it were valid. */
function validProjectKeyParam(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const sanitized = safeProjectKey(raw, raw);
  return sanitized === raw ? raw : null;
}

/** Resolve which discovered (and key-tagged) project a request means: an
 *  explicit ?project=<key> match if present and valid, else the first entry
 *  — discoverRuvfloProjects() itself already sorts most-recently-active
 *  first, so "no explicit selection" naturally means "whatever this machine
 *  used most recently", never the server's launching cwd. Returns null only
 *  when discovery found zero ruflo-initialized projects on this machine.
 *  Shared verbatim by /api/status and /api/live/intelligence. */
function resolveSelectedProject(projects, rawParam) {
  const requested = validProjectKeyParam(rawParam);
  if (requested) {
    const match = projects.find((p) => p.key === requested);
    if (match) return match;
  }
  return projects[0] ?? null;
}

/** Machine-wide discovery + the machine-wide intel rollup are the SAME data
 *  for every client polling /api/status or connecting to
 *  /api/live/intelligence — nothing about either is per-client — and
 *  discovery walks the registry files plus every discovered project's own
 *  .claude-flow tree, so it is not free. Cached in-memory with a short
 *  (~60s) TTL, keyed by nothing (one snapshot per dashboard instance is
 *  correct for machine-wide data), so a burst of polls/connections within
 *  the window reuses one scan instead of re-walking the machine on every
 *  request. `discoverProjectsFn`/`machineWideIntelFn` are injected by
 *  startDashboard (defaulting to the real imports) purely for testability —
 *  discovery reads real machine-global state (~/.claude-flow/*.json,
 *  ~/.config/agentic-kit/observability-workspaces.json) that a test must
 *  never depend on. */
function buildProjectSnapshotCache(discoverProjectsFn, machineWideIntelFn, readCensusFn) {
  let snapshot = null;
  let fetchedAt = 0;
  return () => {
    const now = Date.now();
    if (!snapshot || now - fetchedAt > PROJECT_SNAPSHOT_TTL_MS) {
      const projects = discoverProjectsFn().map((project) => (
        { ...project, key: keyForProject(project) }
      ));
      // The scope counts that let the panel say what it counted (ADR-0027).
      // Null when a caller injected its own discoverProjects: that seam yields
      // a project list with no census behind it, and reporting a machine-wide
      // total derived from a fixture would be a fabricated number. Absent is
      // the honest reading, and the renderer omits the line rather than
      // printing a zero (ADR-0023).
      const census = typeof readCensusFn === 'function' ? readCensusFn() : null;
      snapshot = { projects, machineWide: machineWideIntelFn(projects), census };
      fetchedAt = now;
    }
    return snapshot;
  };
}

/** The default discovery seam: one census walk, exposed two ways — the
 *  learning-scoped project rows the Intelligence panel aggregates, and the
 *  scope counts that explain how that number relates to what the other tabs
 *  show. Paired so the corpus is walked ONCE per snapshot rather than twice. */
function censusBackedDiscovery() {
  let last = null;
  return {
    discover: () => {
      last = projectCensus();
      return projectsInScope(last, 'learning');
    },
    readCensus: () => (last ? {
      everSeen: last.everSeen, onDisk: last.onDisk,
      gitRepos: last.gitRepos, learning: last.learning,
      complete: last.complete,
    } : null),
  };
}

/** Assemble the full /api/status payload. */
async function collectData({ cwd, fetchStatus, projectParam, getProjectSnapshot }) {
  let status;
  try { status = await fetchStatus(); } catch (e) { status = { overall: 'unknown', rows: [], error: String(e && e.message || e) }; }
  const rows = Array.isArray(status?.rows) ? status.rows : [];
  const overall = status?.overall ?? 'unknown';

  // Version drift: prefer what the status payload already carried; otherwise
  // ask versions.mjs directly (TTL-cached, so no extra network within the window).
  let drift = Array.isArray(status?.drift) ? status.drift : null;
  if (!drift) {
    try { drift = await driftReport(); } catch { drift = null; }
    // driftReport only carries the npm-managed tools — fold in the two managed
    // outside it so the update banner covers ALL tools under management: the
    // RuvNet Brain (release-managed; foldBrainDrift) and the kit itself
    // (selfDrift already returns the banner's {pkg, installed, latest, outdated}
    // shape). Self-computed path only: a payload that supplied its own drift
    // owns the whole array (tests inject network-free payloads). Both folds are
    // TTL-cached in kit.json, like driftReport's window.
    try {
      const s = await selfDrift({ pkgRoot: PKG_ROOT });
      if (s.installed) drift = [...(drift ?? []), s];
    } catch { /* banner is best-effort — the subsystem card still carries the self row */ }
    try {
      if (loadKitConfig().ruvnetBrain) drift = foldBrainDrift(drift, await ruvnetBrainDrift());
    } catch { /* banner is best-effort — the subsystem card still carries the brain row */ }
    try {
      if (ruvectorManaged()) drift = foldRuvectorDrift(drift, await ruvectorDrift());
    } catch { /* banner is best-effort — the subsystem card still carries the ruvector row */ }
    try { drift = await foldKnownVersions(drift); } catch { /* version chips degrade, nothing else */ }
  }

  // Machine-wide Intelligence (clean break from the old cwd-hardcoded,
  // single-project shape — see the block comment above buildProjectSnapshotCache).
  // `getProjectSnapshot()` is the shared, TTL-cached {projects, machineWide}
  // read; `projectParam` is the raw ?project= query value, resolved the exact
  // same way /api/live/intelligence resolves it (resolveSelectedProject).
  const { projects, machineWide, census } = getProjectSnapshot();
  const selected = resolveSelectedProject(projects, projectParam);
  const selectedHistory = selected ? readIntelHistory(selected.path) : EMPTY_SELECTED_HISTORY;

  return {
    generatedAt: new Date().toISOString(),
    kit: { name: '@pacphi/agentic-kit', version: kitVersion() },
    overall,
    error: status?.error ?? null,
    rows,
    drift,
    // improvement — UNCHANGED contract: still the LAUNCHING project's own
    // .claude-flow/improvement.json (server cwd), independent of Intelligence
    // project selection below. Not part of the Intelligence redesign — this
    // is a different subsystem ("is this project's own status stale") that
    // never had a "which project" ambiguity to begin with.
    improvement: readJsonSafe(path.join(cwd, '.claude-flow', 'improvement.json')),
    // intel — the machine-wide Intelligence feature's ENTIRE payload, newly
    // designed from scratch (no relation to the prior alpha's flat
    // health/globalStats/patternStore/graph top-level fields, which this
    // supersedes and removes). Shape:
    //   selectedProjectKey/selectedProjectLabel — which discovered project's
    //     detail the four fields below describe; both null only when
    //     discovery found zero ruflo-initialized projects on this machine.
    //     Always present so the client can label the detail strip correctly
    //     regardless of whether ?project was supplied.
    //   projects — the full machine-wide catalog (most-recently-active
    //     first, matching discoverRuvfloProjects()'s own sort), each row
    //     `{ key, label, path, source }` — the key a client echoes back as
    //     ?project=<key> to select a different project's detail. Without
    //     this catalog, ?project= would be undiscoverable from the API
    //     alone.
    //   health/globalStats/patternStore/graph — readIntelHistory(selected
    //     project's path)'s four series, UNCHANGED individual shapes from
    //     the prior alpha (see intel-history.mjs's own header for why
    //     patternStore and globalStats.patternsLearned must never be
    //     conflated) — only their home moved, from top-level to nested here,
    //     and their source moved, from the server's launching cwd to
    //     whichever project is selected.
    //   machineWide — intel-history.mjs's readMachineWideIntel() rollup
    //     across EVERY discovered project, `{ totals, perProject }`. ALWAYS
    //     the full machine-wide figure, independent of selectedProjectKey —
    //     switching the selected project changes the four detail series
    //     above, never this.
    intel: {
      selectedProjectKey: selected?.key ?? null,
      selectedProjectLabel: selected?.label ?? null,
      projects: projects.map(({ key, label, path: projectPath, source }) => (
        { key, label, path: projectPath, source }
      )),
      health: selectedHistory.healthRing,
      globalStats: selectedHistory.globalStats,
      patternStore: selectedHistory.patternStore,
      graph: selectedHistory.graph,
      machineWide,
      //   census — how this panel's project count relates to the counts the
      //     other tabs show (ADR-0027). `scope` names the filter Intelligence
      //     applies; `counts` are the same machine census under every scope, so
      //     a user can see that 14 and 48 and this number are three questions
      //     rather than three answers. Null when discovery was injected — there
      //     is no census behind a fixture, and inventing one would be worse
      //     than saying nothing.
      census: census ? {
        scope: 'learning',
        note: describeScope('learning'),
        counts: census,
      } : null,
    },
    routing: routingPayload(),
  };
}

/** The per-activity routing matrix for the dashboard (ADR-0005). Null unless a
 *  routing policy is set, so single-host projects render nothing new. */
export function routingPayload(cfg = loadKitConfig()) {
  try {
    const policy = cfg.routing?.routes ?? {};
    if (!Object.keys(policy).length) return null;
    const routes = resolveRoutes(policy);
    // Two DIFFERENT signals, deliberately kept apart on the wire so the panel can
    // say different things about them (see RETIRED_MODELS in routing.mjs):
    //   retiredFrom — the host withdrew this model; ak already substituted it, so
    //                 the row shows what will actually run. Actionable but not a
    //                 choice.
    //   diverged    — a seeded route the defaults moved past. A trade to weigh,
    //                 cleared only by an explicit `ak x host refresh`.
    const diverged = new Map(divergedRoutes(policy).map((d) => [d.activity, d]));
    return {
      primaryHost: cfg.routing?.primaryHost ?? 'claude',
      summary: routingSummary(policy),
      routes: ACTIVITIES.map((activity) => {
        const r = routes[activity];
        const d = diverged.get(activity);
        return {
          activity, host: r.host, model: r.model ?? '',
          provenance: r.provenance, akOriginated: !!r.akOriginated,
          escalation: (r.escalation ?? []).map((e) => e.host),
          ...(r.retiredFrom
            ? { retiredFrom: r.retiredFrom, retiresOn: retirementOf(r.retiredFrom)?.retiresOn ?? null }
            : {}),
          ...(d ? { diverged: { defaultModel: d.defaultModel, defaultNote: d.defaultNote, currentNote: d.currentNote } } : {}),
        };
      }),
    };
  } catch { return null; }
}

function kitVersion() {
  const pj = readJsonSafe(path.join(PKG_ROOT, 'package.json'));
  return pj?.version ?? '0.0.0';
}

/** Fold the RuvNet Brain into the npm drift array, same {pkg, installed, latest,
 *  outdated} shape renderDrift expects. `b` is a src/lib/ruvnet-brain.mjs drift()
 *  result (release-tag namespace, disk-first — the same value `ak status` and the
 *  statusline show, so the banner can never disagree with them). Absent brain →
 *  array unchanged (the "not installed" story lives on the subsystem card).
 *  Pure; exported for tests. */
export function foldBrainDrift(drift, b) {
  if (!b?.present) return drift;
  return [...(drift ?? []), {
    pkg: 'ruvnet-brain',
    installed: b.installedRelease ?? '(unversioned)',
    latest: b.latest,
    // A tag without the installer's required bundle is visible on the status
    // card, but must not become an actionable dashboard update banner.
    outdated: !!b.outdated && b.releaseAssetAvailable === true,
  }];
}

/** Fold the ruvector CLI into the npm drift array, same shape renderDrift wants.
 *  `r` is a src/lib/ruvector.mjs drift() result. Absent ruvector → array
 *  unchanged: ak reports its drift but never advertises installing it.
 *  Pure; exported for tests. */
export function foldRuvectorDrift(drift, r) {
  if (!r?.present) return drift;
  return [...(drift ?? []), {
    pkg: 'ruvector',
    installed: r.installed,
    latest: r.latest,
    outdated: !!r.outdated,
  }];
}

// `collectIntegrationFacts` probes each host's binary for its version, which
// costs ~300ms and must never ride the dashboard's ~30s poll. Host versions
// change only when someone installs or upgrades a CLI, so an in-process window
// this long is generous and still catches an upgrade within one coffee break.
const HOST_FACTS_TTL_MS = 5 * 60_000;
let hostFactsCache = null;

async function cachedHostFacts(now) {
  if (hostFactsCache && now - hostFactsCache.at < HOST_FACTS_TTL_MS) return hostFactsCache.hosts;
  const facts = await collectIntegrationFacts({ cwd: process.cwd(), cfg: loadKitConfig() });
  hostFactsCache = { at: now, hosts: facts?.hosts ?? {} };
  return hostFactsCache.hosts;
}

/**
 * Fold in the installed versions `driftReport()` structurally cannot report, so
 * every About card states a version rather than some silently omitting one.
 *
 * driftReport only walks the globals whose upgrades are governed by npm-latest.
 * Other managed components are still knowable but sit outside it: a host
 * installed by mise/brew/the native installer; agent-browser and agentdb,
 * whose exact versions are selected for compatibility rather than npm-latest;
 * and aidefence, which ships inside ruflo's dependency tree.
 *
 * Both fold in with `outdated: false` and no `latest`, which is inert for the
 * banner — `noticeHtml` renders only entries where `outdated` is true — while
 * giving the version chip the structured fact it needs. Nothing here parses a
 * version out of a status row's prose; every value is a structured probe.
 * Existing entries always win, so this can only ever add.
 * @param {Array<{pkg:string, installed?:string|null, latest?:string|null,
 *   outdated?:boolean}>|null} drift the drift array, in the shape driftReport()
 *   and the selfDrift/brain/ruvector folds all already emit
 * @param {{ now?: number, hostFacts?: Record<string, {version?: string|null}>,
 *   installedVersionFn?: (pkg:string)=>string|null }} [deps] test seam
 * @returns {Promise<Array<{pkg:string, installed?:string|null, latest?:string|null,
 *   outdated?:boolean}>>} the input array plus the folded entries; incoming
 *   entries are passed through untouched, so their fields stay as optional as
 *   whichever fold produced them
 */
export async function foldKnownVersions(drift, {
  now = Date.now(), hostFacts, installedVersionFn = installedVersion,
} = {}) {
  const out = [...(drift ?? [])];
  const seen = new Set(out.map((d) => d?.pkg).filter(Boolean));
  const add = (pkg, installed) => {
    if (!pkg || !installed || seen.has(pkg)) return;
    seen.add(pkg);
    out.push({ pkg, installed, latest: null, outdated: false });
  };
  const hosts = hostFacts ?? await cachedHostFacts(now);
  for (const host of HOSTS) add(host.pkg, hosts?.[host.id]?.version);
  add('agent-browser', installedVersionFn('agent-browser'));
  add('agentdb', installedVersionFn('agentdb'));
  add('@claude-flow/aidefence', bundledVersion('ruflo', '@claude-flow/aidefence'));
  return out;
}

/** The version of a package that ships INSIDE another rather than as its own
 *  global — aidefence lives in ruflo's dependency tree, so `installedVersion`
 *  cannot see it and its card was the last one silently missing a version.
 *  Both npm layouts are checked directly (hoisted beside the host, then nested
 *  under it) because Node's resolver refuses `<pkg>/package.json` whenever the
 *  package publishes an `exports` map, which aidefence does. */
function bundledVersion(hostPkg, pkg) {
  const root = globalRoot();
  for (const file of [
    path.join(root, pkg, 'package.json'),
    path.join(root, hostPkg, 'node_modules', pkg, 'package.json'),
  ]) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null; } catch { /* try next */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage tab plumbing (ADR-0009). Everything here is either a pure guard or a
// thin adapter over usage-index.mjs — no parsing, no aggregation, no pricing.
// ─────────────────────────────────────────────────────────────────────────────

/** Session rows per project embedded in /api/usage. Matches what the tree
 *  renders before "load all"; the rest come from /api/sessions on demand. */
const USAGE_TREE_PREVIEW = 25;

/**
 * The Prompts view's half of the payload (METRICS.md §21): what the operator typed,
 * how it splits per host and per day, the personal baselines the detectors
 * compare against, and the repetition projection.
 *
 * NOTHING IS RE-DERIVED HERE. `patterns` is `agg.promptPatterns` verbatim — the
 * single projection usage-aggregate.mjs builds from the records it holds, which
 * `ak usage prompts` reads too, so the two surfaces cannot disagree about what
 * a cluster is. The per-host, per-day and baseline maps are likewise lifted
 * from the aggregate that already computed them.
 *
 * The one figure computed here is `headless`, and it follows
 * detectHeadlessShare's definition exactly rather than inventing a second one:
 * sessions carrying the fingerprint layer, of which those that typed nothing. A
 * session with no layer is excluded from BOTH halves of the fraction, because
 * "unknowable" is not "headless".
 *
 * Prompt text cannot reach this object: every input is a fingerprint-derived
 * count, a curated cluster name, or a session id for the existing masked
 * session route (ADR-0039's privacy split).
 */
function promptsPayload(agg) {
  const t = agg.totals ?? {};
  const classified = (agg.sessions ?? []).filter((s) => Number.isFinite(s.typedPrompts));
  const headless = classified.filter((s) => s.typedPrompts === 0);
  const responses = classified.reduce((n, s) => n + (Number(s.responses) || 0), 0);
  const headlessResponses = headless.reduce((n, s) => n + (Number(s.responses) || 0), 0);
  return {
    typed: t.typedPrompts ?? 0,
    taps: t.tapCount ?? 0,
    tapShare: t.tapShare ?? null,
    byHost: agg.promptsByHost ?? {},
    statsByDay: agg.promptStatsByDay ?? {},
    baselines: agg.promptBaselines ?? {},
    patterns: agg.promptPatterns ?? null,
    headless: {
      sessions: headless.length,
      responses: headlessResponses,
      // Null rather than 0 on an empty denominator: a window with no
      // classified session never measured a headless share, which is not the
      // claim "0% of it was headless" makes.
      share: responses > 0 ? headlessResponses / responses : null,
      measuredSessions: classified.length,
      measuredResponses: responses,
    },
  };
}

function lazyUsage() {
  let mod = null;
  const load = async () => (mod ||= await import('./usage-index.mjs'));
  return {
    readIndex: async (opts) => (await load()).readIndex(opts),
    readSession: async (id) => (await load()).readSession(id),
    maskSecrets: async (s) => (await load()).maskSecrets(s),
    // Provider-account analytics is an independent offline cache read. It is
    // deliberately not part of usage-index's transcript aggregation.
    readProviderAnalytics: async () => ({
      openrouter: (await import('./usage-openrouter.mjs')).readOpenRouterActivity(),
    }),
    // resolved at call time so a module that ships masking later still fails
    // closed rather than silently serving raw text.
    masker: async () => (await load()).maskSecrets,
  };
}

const DASHBOARD_HOOK_HOSTS = new Set(['all', 'claude', 'codex', 'opencode', 'external']);
const DEFAULT_HOOK_CACHE_MS = 30_000;

/** Default Hook source: the same explicit, read-only audit used by
 * `ak audit hooks`, loaded only when the Hooks view asks for it. Runtime
 * receipts are empty until a caller injects a bounded receipt source; absence
 * is rendered as unknown, never as a fabricated clean run. */
async function collectDashboardHooks({ host }) {
  const { collectHookAudit } = await import('../commands/audit.mjs');
  return {
    audit: collectHookAudit({
      flags: { host: [host], project: [], 'all-projects': false },
    }),
    receipts: [],
  };
}

/** Per-server Hook cache. One promise per host is both the single-flight slot
 * and the only route to a cached sanitized payload. Failures clear the slot
 * and are never cached. */
function hookJsonPointer(record) {
  if (typeof record?.source?.jsonPointer === 'string') return record.source.jsonPointer;
  if (Number.isInteger(record?.indices?.group) && Number.isInteger(record?.indices?.hook)) {
    const event = String(record.event ?? '').replaceAll('~', '~0').replaceAll('/', '~1');
    return `/hooks/${event}/${record.indices.group}/hooks/${record.indices.hook}`;
  }
  if (record?.type === 'package-plugin' && Number.isInteger(record?.indices?.plugin)) {
    return `/plugin/${record.indices.plugin}`;
  }
  if (record?.source?.sourceKind === 'external-adapter-manifest') {
    const event = String(record.event ?? '');
    if (event.startsWith('lifecycle.')) return `/lifecycle/${event.slice(10).replaceAll('~', '~0').replaceAll('/', '~1')}/hook`;
    if (event === 'execution.run') return '/execution/run/hook';
    if (event === 'aqe.provider') return '/aqe/provider/hook';
  }
  return null;
}

function hookSourceLocator(record) {
  const rawFile = record?.source?.file;
  const root = record?.source?.baseDir;
  const digest = record?.source?.digest;
  if (typeof rawFile !== 'string' || typeof root !== 'string' || rawFile.includes('#')) return null;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest)) return null;
  if (!path.isAbsolute(rawFile) || !path.isAbsolute(root) || /^https?:|^npm:/.test(rawFile)) return null;
  return {
    file: rawFile, containmentRoot: root, digest,
    pointer: hookJsonPointer(record), host: record?.host ?? 'unknown', event: record?.event ?? 'unknown',
    sourceKind: record?.source?.sourceKind ?? 'unknown', owner: record?.source?.owner ?? 'unknown',
    format: ({ '.json': 'json', '.jsonc': 'jsonc', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml' })[
      path.extname(rawFile).toLowerCase()] ?? 'text',
  };
}

function pointerValue(document, pointer) {
  if (pointer === '') return document;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  let value = document;
  for (const part of pointer.split('/').slice(1).map((item) => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

const HOOK_DETAIL_MAX_BYTES = 64 * 1024;
const HOOK_SENSITIVE_KEY = /(?:secret|token|password|passwd|api_?key|private_?key|credential)/i;

function maskHookDefinition(value, mask, depth = 0) {
  if (depth > 12) return '[depth limit]';
  if (typeof value === 'string') return mask(value).slice(0, HOOK_DETAIL_MAX_BYTES);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => maskHookDefinition(item, mask, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 128).map(([key, item]) => [
    key.slice(0, 128), HOOK_SENSITIVE_KEY.test(key) ? '<redacted>' : maskHookDefinition(item, mask, depth + 1),
  ]));
}

function displayHookPath(file) {
  const home = process.env.HOME;
  return home && (file === home || file.startsWith(`${home}${path.sep}`)) ? `~${file.slice(home.length)}` : file;
}

function createHookDashboardReader({ hooks, cacheMs }) {
  const provide = typeof hooks === 'function'
    ? hooks : hooks ? async () => hooks : collectDashboardHooks;
  const cache = new Map();
  const inflight = new Map();
  const locators = new Map();
  const referenceKey = mintToken();
  const ttlMs = clampInt(cacheMs, DEFAULT_HOOK_CACHE_MS, 1_000, 300_000);
  const read = (host) => {
    const cached = cache.get(host);
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.payload);
    const active = inflight.get(host);
    if (active) return active;
    const pending = Promise.resolve().then(() => provide({ host })).then(async (raw) => {
      const generationAt = Date.now();
      const expiresAt = generationAt + ttlMs;
      for (const [ref, locator] of locators) {
        if (locator.expiresAt <= generationAt) locators.delete(ref);
      }
      const { buildHookDashboardReadModel } = await import('./hook-read-model.mjs');
      let healingPlan = null;
      try {
        const { buildHookHealingPlan, publicHookHealingPlan } = await import('./hook-remediation/planner.mjs');
        healingPlan = publicHookHealingPlan(buildHookHealingPlan({ report: raw?.audit }));
      } catch { /* a failed plan compilation is not evidence for an action */ }
      const refs = new Map();
      for (const report of Object.values(raw?.audit?.reports ?? {})) {
        for (const record of report?.records ?? []) {
          const locator = hookSourceLocator(record);
          if (!locator) continue;
          const ref = createHmac('sha256', referenceKey).update([
            raw?.audit?.auditId ?? 'audit', record?.occurrenceId ?? '', locator.file,
            locator.pointer ?? '', locator.digest ?? '',
          ].join('\0')).digest('hex').slice(0, 32);
          refs.set(record?.occurrenceId, ref);
          locators.set(ref, { ...locator, expiresAt });
        }
      }
      const payload = buildHookDashboardReadModel({
        audit: raw?.audit ?? null,
        receipts: Array.isArray(raw?.receipts) ? raw.receipts : [],
        healingPlan,
        sourceRef: (record) => refs.get(record?.occurrenceId) ?? null,
      });
      cache.set(host, { at: generationAt, payload });
      return payload;
    }).finally(() => inflight.delete(host));
    inflight.set(host, pending);
    return pending;
  };
  const source = async (ref, mask) => {
    const locator = locators.get(ref);
    if (!locator || locator.expiresAt < Date.now()) {
      locators.delete(ref);
      const error = /** @type {Error & { code: string }} */ (new Error('hook source reference is unknown or expired'));
      error.code = 'HOOK_SOURCE_NOT_FOUND';
      throw error;
    }
    if (typeof mask !== 'function') {
      const error = /** @type {Error & { code: string }} */ (new Error('hook source masking is unavailable'));
      error.code = 'HOOK_SOURCE_MASK_UNAVAILABLE';
      throw error;
    }
    const { readBoundedFile, sha256 } = await import('./hook-audit/common.mjs');
    const current = readBoundedFile(locator.file, locator.containmentRoot, 2 * 1024 * 1024);
    if (current.status !== 'valid' || (locator.digest && sha256(current.bytes) !== locator.digest)) {
      const error = /** @type {Error & { code: string }} */ (new Error('hook source changed; refresh the audit'));
      error.code = 'HOOK_SOURCE_CHANGED';
      throw error;
    }
    let definitionValue = null;
    let definitionAvailable = false;
    let unavailableCode = null;
    let unavailableReason = null;
    if (locator.pointer && !locator.pointer.startsWith('/')) {
      unavailableCode = 'selector-invalid';
      unavailableReason = 'The audited selector is not a valid JSON Pointer, so no source content was disclosed.';
    } else if (locator.pointer && path.extname(locator.file).toLowerCase() === '.json') {
      try {
        const selected = pointerValue(JSON.parse(current.text), locator.pointer);
        if (selected === undefined) {
          unavailableCode = 'selector-not-found';
          unavailableReason = 'The audited definition selector is not present in this source. Refresh the hook audit before inspecting it again.';
        } else {
          definitionValue = maskHookDefinition(selected, mask);
          definitionAvailable = true;
        }
      } catch {
        unavailableCode = 'parse-failed';
        unavailableReason = 'This JSON source could not be normalized for display.';
      }
    } else {
      unavailableCode = locator.pointer ? 'unsupported-format' : 'selector-unavailable';
      unavailableReason = 'This source format is location-only; the dashboard does not parse or execute it.';
    }
    if (definitionAvailable && Buffer.byteLength(JSON.stringify(definitionValue)) > HOOK_DETAIL_MAX_BYTES) {
      definitionValue = null;
      definitionAvailable = false;
      unavailableCode = 'display-limit';
      unavailableReason = 'The selected definition exceeds the bounded display limit.';
    }
    const definition = definitionAvailable
      ? { status: 'available', format: locator.format, value: definitionValue }
      : { status: 'location-only', format: locator.format, reason: unavailableCode };
    return {
      schemaVersion: 1,
      location: {
        displayPath: displayHookPath(locator.file), absolutePath: locator.file,
        selector: locator.pointer, digest: locator.digest,
      },
      host: locator.host, hostId: locator.host, lifecyclePoint: locator.event, sourceKind: locator.sourceKind,
      owner: locator.owner, format: locator.format, definition, unavailableReason, redacted: true,
      explanation: definition.status === 'available'
        ? `This is the ${locator.event} hook definition selected from the audited ${locator.format.toUpperCase()} source. Secret-shaped values are masked, and the dashboard does not execute this configuration.`
        : 'The physical source was verified, but this definition could not be translated safely into a bounded code presentation.',
    };
  };
  return { read, source };
}

/** ?days=N → a sane window. Junk falls back to the 14-day default rather than
 *  reaching the indexer as NaN. */
function clampDays(raw, fallback = 14) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(365, Math.max(1, n));
}
function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** A 500 that discloses nothing about the filesystem. Node's fs errors embed
 *  the absolute path ("EACCES: permission denied, open
 *  '/Users/<user>/.claude/projects/<project-slug>/<uuid>.jsonl'"), and project
 *  slugs are derived from real working directories — so reflecting the raw
 *  message hands a client the username, the directory layout, and the names of
 *  projects worked on. The operator still gets the whole error on stderr, where
 *  it belongs. */
function serverFault(res, where, e, message) {
  console.error(`[dashboard] ${where} failed:`, e);
  sendJson(res, 500, { error: message });
}

// Observability History's window control — day-count approximations (a
// calendar "month" is treated as 30 days, matching clampDays' own plain-day
// semantics rather than adding calendar-aware month math for a browse filter).
const HISTORY_WINDOW_DAYS = {
  '1d': 1, '7d': 7, '14d': 14, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365,
};
/** ?window=<token> → an epoch-ms cutoff, or null for "all time". Unknown/
 *  missing tokens fall back to 14d, the same default clampDays uses. */
function windowToSinceMs(raw, now = Date.now()) {
  if (raw === 'all') return null;
  const days = Object.hasOwn(HISTORY_WINDOW_DAYS, raw) ? HISTORY_WINDOW_DAYS[raw] : HISTORY_WINDOW_DAYS['14d'];
  return now - days * 86_400_000;
}

const PRIVATE_LIVE_FIELDS = new Set([
  'prompt', 'response', 'arguments', 'args', 'result', 'toolarguments',
  'toolresult', 'content', 'body', 'text', 'transcript',
]);
const PATH_LIVE_FIELDS = new Set([
  'artifact', 'cwd', 'path', 'filepath', 'projectroot', 'root',
]);

function publicLivePayload(value) {
  if (Array.isArray(value)) return value.map(publicLivePayload);
  if (!value || typeof value !== 'object') return value;
  if (value.sessionId && (!value.project || value.project === 'unknown')) return null;
  if (Array.isArray(value.sessions)) {
    value = {
      ...value,
      sessions: value.sessions.filter((session) => session?.project
        && session.project !== 'unknown'),
      ...(Array.isArray(value.projects) ? { projects: value.projects.filter((project) => {
        const label = project?.label ?? project?.name ?? project?.project;
        return label && label !== 'unknown';
      }) } : {}),
    };
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (PRIVATE_LIVE_FIELDS.has(normalized)) {
      // Live is metadata-only. Even an injected/misbehaving adapter cannot
      // promote transcript text or tool payloads into the snapshot/SSE wire.
      continue;
    }
    if (PATH_LIVE_FIELDS.has(normalized) && typeof item === 'string') {
      // Adapter artifacts are useful provenance, but their absolute transcript
      // paths reveal usernames and directory structure. Keep only the leaf;
      // project identity is supplied separately as a human-safe label.
      out[key] = item.split(/[\\/]/).pop()?.slice(0, 256) || null;
    } else {
      out[key] = publicLivePayload(item);
    }
  }
  return out;
}

function sseFrame(name, data, id) {
  const lines = [];
  if (id != null) lines.push(`id: ${String(id).replaceAll(/[\r\n]/g, '')}`);
  if (name) lines.push(`event: ${name}`);
  for (const line of JSON.stringify(publicLivePayload(data)).split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

function transcriptSseFrame(name, data, id) {
  const lines = [];
  if (id != null) lines.push(`id: ${String(id).replaceAll(/[\r\n]/g, '')}`);
  if (name) lines.push(`event: ${name}`);
  for (const line of JSON.stringify(data).split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

/** The dedup/delivery pass for /api/live/events' init: reconcile events that
 *  arrived via replay(snapshot.cursor) ("after") against events buffered
 *  while snapshot()/replay() were in flight ("pending") so nothing is
 *  delivered twice and nothing from the gap between them is dropped. Moved
 *  out of handleLiveEvents verbatim (2026-08 complexity audit, Finding 1) —
 *  including the ORDERING, which is load-bearing: reading `postSnapshot`'s
 *  `events` (below) can itself synchronously re-enter the subscription
 *  callback (a service may publish from a getter, as the race regression
 *  test does), so `pending` must not be buffer-snapshotted — and `initAt`
 *  must not flip to "live" — until AFTER that read, with no `await` between
 *  the snapshot and the flip (nothing can dispatch a callback in that gap). */
function deliverLiveInit({ write, replay, snapshot, postSnapshot, pending, snapshotPendingCount, markInitialized }) {
  // Inspect replay while callbacks still buffer. A custom/async service may
  // publish while materializing this result even though replay() itself has
  // resolved.
  const after = !postSnapshot?.reset && Array.isArray(postSnapshot?.events)
    ? postSnapshot.events : [];
  if (!replay?.reset) {
    for (const event of Array.isArray(replay?.events) ? replay.events : []) {
      write(sseFrame('delta', event, event?.eventId));
    }
  }
  write(sseFrame('init', { reset: !!replay?.reset, snapshot }));
  const afterIds = new Set(after.map((event) => event?.eventId).filter(Boolean));
  const emitted = new Set();
  const buffered = [...pending];
  // Take the final buffer snapshot and flip modes without an await between
  // them. JavaScript cannot dispatch a subscription callback in that gap:
  // every later event therefore goes directly to the response.
  markInitialized();
  for (const [index, event] of [...after, ...buffered].entries()) {
    const id = event?.eventId;
    const pendingIndex = index - after.length;
    // Events buffered after snapshot() resolved cannot be represented by
    // that immutable snapshot. Deliver them even if replay() captured its
    // result before they arrived. Earlier identified events absent from
    // replay(snapshot.cursor) are already represented by the snapshot.
    if (id && !afterIds.has(id)
      && (pendingIndex < 0 || pendingIndex < snapshotPendingCount)) continue;
    if (id && emitted.has(id)) continue;
    if (id) emitted.add(id);
    write(sseFrame('delta', event, id));
  }
}

function sendTranscriptJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(payload));
}

/** Lazily bind the machine-footprint collector (ADR-0025), for the same reason
 *  lazyUsage is lazy: the System area pulls in five walkers plus the runtime
 *  survey, and a panel that never opens that tab must not pay for them. One
 *  instance per dashboard server — it owns the cheap tier's TTL cache and the
 *  deep scan's single-flight slot, and a second instance would defeat both. */
function lazySystem(systemOptions = {}) {
  let instancePromise;
  return async () => {
    instancePromise ||= import('./footprint/index.mjs').then(({ createSystemCollector }) => (
      createSystemCollector(systemOptions)
    ));
    return instancePromise;
  };
}

/** Load the collector only when Live is requested. This keeps dashboard startup
 * cheap and permits tests/embedders to inject a source without touching real
 * transcript stores. */
function lazyLive(liveOptions = {}) {
  let instancePromise;
  return async () => {
    instancePromise ||= import('./live/service.mjs').then(({ LiveSessionsService }) => (
      new LiveSessionsService(liveOptions)
    ));
    return instancePromise;
  };
}

/**
 * Start the dashboard HTTP server, bound to loopback only.
 * @param {{ port?: number, cwd?: string, fetchStatus?: () => Promise<any>, usage?: any,
 *           limits?: () => Promise<any>, hooks?: any, hookCacheMs?: number,
 *           live?: any, liveHeartbeatMs?: number,
 *           liveClientBuffer?: number, liveMaxClients?: number, liveOptions?: any,
 *           liveIdleMs?: number, transcripts?: any, transcriptOptions?: any,
 *           transcriptClientBuffer?: number, transcriptMaxClients?: number,
 *           intelWatch?: ((projectPath: string, onUpdate: (combined: any) => void) =>
 *             any|Promise<any>)|any,
 *           intelClientBuffer?: number, intelMaxClients?: number,
 *           discoverProjects?: () => Array<{ path: string, label: string, source?: string }>,
 *           machineWideIntel?: (projects: Array<any>) => any,
 *           models?: any, modelScopeKey?: string, system?: any, systemOptions?: any,
 *           maintenance?: any, maintenanceOptions?: any }} [opts]
 * @returns {Promise<{ url: string, urlWithToken: string, port: number, token: string, close: () => Promise<void> }>}
 */
export function startDashboard({
  port = 7431, cwd = process.cwd(), fetchStatus, usage, limits, hooks,
  hookCacheMs = DEFAULT_HOOK_CACHE_MS, live,
  liveHeartbeatMs = 15_000, liveClientBuffer = 256, liveMaxClients = 32,
  liveOptions = {}, liveIdleMs = 30_000, transcripts, transcriptOptions = {},
  transcriptClientBuffer = 64, transcriptMaxClients = 16,
  intelWatch, intelClientBuffer = 256, intelMaxClients = 32,
  discoverProjects, machineWideIntel, models, modelScopeKey, system, systemOptions = {},
  maintenance, maintenanceOptions = {},
} = {}) {
  const provide = fetchStatus || shellOutStatus(cwd);
  const usageApi = usage || lazyUsage();
  const getHooks = createHookDashboardReader({ hooks, cacheMs: hookCacheMs });
  // Cache-only and lazy: model discovery is exclusively owned by
  // `ak models refresh`; opening the dashboard never contacts a host/catalog.
  const provideModels = typeof models === 'function' ? models : models ? async () => models : async () => {
    const [{ readModelStore, latestSnapshot, previousSnapshot }, { diffSnapshotHistory }, { createModelReadModel }] = await Promise.all([
      import('./model-inventory/store.mjs'), import('./model-inventory/diff.mjs'),
      import('./model-inventory/read-model.mjs'),
    ]);
    const store = readModelStore();
    const snapshot = latestSnapshot(store);
    if (!snapshot) return { status: 'empty', snapshot: null, history: [], hint: 'ak models refresh' };
    const baseline = previousSnapshot(store, snapshot);
    const diff = baseline ? diffSnapshotHistory(baseline, snapshot, store.snapshots)
      : { changes: [], diagnostics: [] };
    return {
      status: 'cached', snapshot: createModelReadModel(snapshot, { changes: diff }),
      history: store.snapshots.filter((entry) => entry.scope.fingerprint === snapshot.scope.fingerprint)
        .map(({ snapshotId, capturedAt }) => ({ snapshotId, capturedAt })),
      comparison: { baseline: baseline?.snapshotId ?? null, latest: snapshot.snapshotId,
        comparable: diff.comparable ?? false, diagnostics: diff.diagnostics ?? [] },
    };
  };
  // Injectable like `usage`: tests must never spawn a real codex or read the
  // real ~/.config through this route. Lazy for the same reason lazyUsage is.
  // enabledHosts drives quota.mjs's F-10 labeling (any OTHER enabled host with
  // no sanctioned quota channel) from the same kit.json read used elsewhere in
  // this file (see loadKitConfig() below) — never a second, ad hoc source.
  const provideLimits = limits || (async () => {
    const { readLimits } = await import('./quota.mjs');
    return readLimits({ enabledHosts: loadKitConfig().integrations.hosts });
  });
  const provideLive = typeof live === 'function' ? live : live ? async () => live : lazyLive(liveOptions);
  // Same injection contract as `live`: a function is called to produce the
  // collector, a value is reused verbatim (tests hand over a fake so the route
  // never walks the real machine), and the default is the lazy real one. The
  // collector must expose read/refreshDeep — checked at use, not here, so an
  // unopened System tab still costs nothing.
  const provideSystem = typeof system === 'function'
    ? system : system ? async () => system : lazySystem({ cwd, ...systemOptions });
  let systemPromise;
  const getSystem = async () => {
    const collector = await (systemPromise ||= Promise.resolve().then(provideSystem));
    if (!collector || typeof collector.read !== 'function'
      || typeof collector.refreshDeep !== 'function') {
      throw new TypeError('system collector must implement read and refreshDeep');
    }
    return collector;
  };
  // Maintenance consumes the SAME collector instance as System. This preserves
  // the bounded-context split (System measures; Maintenance plans/acts) without
  // letting two dashboard routes independently walk or disagree about the
  // machine. Like every expensive panel, construction remains lazy.
  const provideMaintenance = typeof maintenance === 'function'
    ? maintenance : maintenance ? async () => maintenance : async () => {
      const [{ createMaintenanceService }, collector] = await Promise.all([
        import('./maintenance/service.mjs'), getSystem(),
      ]);
      return createMaintenanceService({ collector, ...maintenanceOptions });
    };
  let maintenancePromise;
  const getMaintenance = async () => {
    const service = await (maintenancePromise ||= Promise.resolve().then(provideMaintenance));
    if (!service || typeof service.report !== 'function' || typeof service.scan !== 'function'
      || typeof service.plan !== 'function') {
      throw new TypeError('maintenance service must implement report, scan, and plan');
    }
    return service;
  };
  let transcriptServicePromise;
  const provideTranscripts = typeof transcripts === 'function'
    ? transcripts : transcripts ? async () => transcripts : async () => {
      const [{ TranscriptStreams }, maskFn] = await Promise.all([
        import('./live/transcript-streams.mjs'),
        typeof usageApi.masker === 'function'
          ? usageApi.masker() : Promise.resolve(usageApi.maskSecrets),
      ]);
      return new TranscriptStreams({
        roots: { claude: TRANSCRIPT_ROOTS[0], codex: TRANSCRIPT_ROOTS[1] },
        ...transcriptOptions, mask: maskFn,
      });
    };
  const getTranscripts = async () => {
    const service = await (transcriptServicePromise ||= Promise.resolve().then(provideTranscripts));
    if (!service || typeof service.open !== 'function') {
      throw new TypeError('transcript service must implement open');
    }
    return service;
  };
  let livePromise;
  let liveStartPromise;
  let liveStopPromise;
  let liveIdleTimer;
  let liveStarted = false;
  const liveClients = new Set();
  const transcriptClients = new Set();
  let shuttingDown = false;
  const cancelLiveIdle = () => {
    if (liveIdleTimer != null) clearTimeout(liveIdleTimer);
    liveIdleTimer = undefined;
  };
  const stopLive = async ({ force = false } = {}) => {
    cancelLiveIdle();
    if (!force && liveClients.size > 0) return;
    if (liveStopPromise) return liveStopPromise;
    liveStopPromise = (async () => {
      try { await liveStartPromise; } catch {}
      if ((!force && liveClients.size > 0) || !liveStarted) return;
      try { await (await livePromise)?.close?.(); } catch {}
      liveStarted = false;
      liveStartPromise = undefined;
    })().finally(() => { liveStopPromise = undefined; });
    return liveStopPromise;
  };
  const scheduleLiveIdle = () => {
    cancelLiveIdle();
    if (shuttingDown || liveClients.size > 0 || !liveStarted) return;
    const delay = Math.max(10, Math.min(3_600_000, Number(liveIdleMs) || 30_000));
    liveIdleTimer = setTimeout(() => {
      liveIdleTimer = undefined;
      void stopLive();
    }, delay);
    liveIdleTimer.unref?.();
  };
  const getLive = async () => {
    cancelLiveIdle();
    if (liveStopPromise) await liveStopPromise;
    if (shuttingDown) throw new Error('dashboard is closing');
    const service = await (livePromise ||= Promise.resolve().then(provideLive));
    if (shuttingDown) throw new Error('dashboard is closing');
    if (!service || typeof service.snapshot !== 'function'
      || typeof service.replay !== 'function' || typeof service.subscribe !== 'function') {
      throw new TypeError('live service must implement snapshot, replay and subscribe');
    }
    if (!liveStarted) await (liveStartPromise ||= Promise.resolve()
      .then(() => service.start?.())
      .then(() => { liveStarted = true; })
      .catch((error) => { liveStartPromise = null; throw error; }));
    return service;
  };

  // Shared, TTL-cached machine-wide project catalog + rollup — see the block
  // comment above buildProjectSnapshotCache. One instance per dashboard
  // server, used by BOTH /api/status and /api/live/intelligence so they can
  // never scan the machine independently or disagree on results within the
  // same TTL window.
  const censusBacked = censusBackedDiscovery();
  const injectedDiscovery = typeof discoverProjects === 'function';
  const getProjectSnapshot = buildProjectSnapshotCache(
    injectedDiscovery ? discoverProjects : censusBacked.discover,
    typeof machineWideIntel === 'function' ? machineWideIntel : readMachineWideIntel,
    injectedDiscovery ? null : censusBacked.readCensus,
  );

  // ── /api/live/intelligence pool plumbing ──────────────────────────────────
  // Was a single server-wide IntelligenceWatch hardcoded to the server's own
  // cwd; now Intelligence is machine-wide and project-selectable, so this is
  // a small POOL keyed by resolved project path instead — at most one
  // watcher per DISTINCT project actually being watched by at least one SSE
  // client, however many clients (on the same or different projects) are
  // connected. `intelClients` mirrors `liveClients`/`transcriptClients`:
  // cap-tracking AND the set force-closed on shutdown, across every project.
  // `intelPool` is the per-project state: each entry owns its own `writers`
  // set (only THIS project's SSE clients) and its own lazily-started,
  // memoized IntelligenceWatch, since — unlike LiveSessionsService — that
  // class has no built-in per-subscriber pub-sub of its own; each entry's
  // `broadcast` fans its watch's single `onUpdate` out to only its own
  // writers, so two clients watching two different projects never cross-talk.
  const intelClients = new Set();
  const intelPool = new Map(); // resolved project path -> pool entry

  // intelWatch injection contract for tests/embedders: a FUNCTION is called
  // as (projectPath, onUpdate) -> watch|Promise<watch>, mirroring the pool's
  // real per-path shape (a deliberate signature change from the old
  // singleton's `() => watch`, part of this clean break). A non-function
  // value is reused verbatim for EVERY project path — a single-project test
  // convenience; the pool never re-wires that instance's own onUpdate, so a
  // test using this form should only ever have one project selected.
  const provideIntelWatchFor = typeof intelWatch === 'function'
    ? intelWatch
    : intelWatch
      ? () => intelWatch
      : (projectPath, onUpdate) => import('./live/intelligence-watch.mjs').then(
        ({ IntelligenceWatch }) => new IntelligenceWatch({ cwd: projectPath, onUpdate }),
      );

  /** One pool entry per resolved project path. */
  function createIntelPoolEntry(projectPath) {
    const writers = new Set();
    const broadcast = (combined) => {
      const frame = transcriptSseFrame('update', combined);
      for (const write of writers) {
        try { write(frame); } catch { /* a dead writer is reaped by its own cleanup */ }
      }
    };
    let watchPromise;
    let startPromise;
    let started = false;
    const getWatch = async () => {
      if (shuttingDown) throw new Error('dashboard is closing');
      const watch = await (watchPromise ||= Promise.resolve()
        .then(() => provideIntelWatchFor(projectPath, broadcast)));
      if (shuttingDown) throw new Error('dashboard is closing');
      if (!watch || typeof watch.start !== 'function' || typeof watch.stop !== 'function') {
        throw new TypeError('intelligence watch must implement start and stop');
      }
      if (!started) await (startPromise ||= Promise.resolve()
        .then(() => watch.start())
        .then(() => { started = true; })
        .catch((error) => { startPromise = null; throw error; }));
      return watch;
    };
    const stop = async () => { try { (await watchPromise)?.stop?.(); } catch { /* best-effort */ } };
    return { writers, getWatch, stop };
  }

  function getOrCreateIntelPoolEntry(projectPath) {
    let entry = intelPool.get(projectPath);
    if (!entry) {
      entry = createIntelPoolEntry(projectPath);
      intelPool.set(projectPath, entry);
    }
    return entry;
  }

  const html = renderPage({ name: '@pacphi/agentic-kit', version: kitVersion() });

  // Per-session auth secret (ADR-0014, mirrors admin's ADR-0007 §2): 256-bit,
  // fresh each start, URL-safe so it rides in the launch URL's # fragment.
  // Every /api/* route requires it — this page serves full transcript text,
  // a strictly more sensitive payload than admin's GitHub/npm stats, which
  // already required one. EventSource cannot send headers, so its two routes
  // also accept the token as a query param (see client.mjs's dashSseUrl).
  const token = mintToken();
  const checkToken = (req, query) => tokenMatches(req.headers['x-dash-token'] || query.get('token'), token);
  let maintenanceApiPromise;
  const getMaintenanceApi = async () => (maintenanceApiPromise ||= getMaintenance()
    .then((service) => createMaintenanceDashboardApi({ service, sessionToken: token })));

  const server = http.createServer(async (req, res) => {
    const raw = req.url || '/';
    const qi = raw.indexOf('?');
    const url = qi < 0 ? raw : raw.slice(0, qi);
    const query = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
    // Maintenance has the only mutation allowlist. Every other route remains
    // GET-only, so adding a new read endpoint cannot accidentally create a
    // write path.
    const maintenanceMutation = req.method === 'POST' && MAINTENANCE_MUTATION_ROUTES.has(url);
    if (req.method !== 'GET' && !maintenanceMutation) {
      res.writeHead(405).end('method not allowed');
      return;
    }
    const rejected = requestRejection(req.headers);
    if (rejected) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(rejected);
      return;
    }

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': DASH_CSP,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      res.end(html);
      return;
    }

    // Every route below serves data — none of it is safe to hand to any
    // process that can merely reach this loopback port (Security Finding 1).
    // Query tokens remain an SSE compatibility exception for GET. Mutation
    // capability can only be reached with the explicit header; it never rides
    // in a URL, browser history, referrer or server log.
    const authorized = maintenanceMutation
      ? tokenMatches(req.headers['x-dash-token'], token) : checkToken(req, query);
    if (url.startsWith('/api/') && !authorized) {
      sendUnauthorized(res, 'Wrong or missing dashboard token.');
      return;
    }
    if (maintenanceMutation) {
      const mutationRejection = maintenanceMutationRejection(req.headers);
      if (mutationRejection) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(mutationRejection);
        return;
      }
      try { await (await getMaintenanceApi()).mutate(url, req, res); }
      catch { sendJson(res, 503, { error: 'maintenance operation unavailable' }); }
      return;
    }

    async function handleStatus(req, res, query) {
      let payload;
      try {
        payload = await collectData({
          cwd, fetchStatus: provide, projectParam: query.get('project'), getProjectSnapshot,
        });
      } catch (e) {
        payload = {
          generatedAt: new Date().toISOString(), overall: 'unknown', rows: [], drift: null, improvement: null,
          intel: {
            selectedProjectKey: null, selectedProjectLabel: null, projects: [],
            health: null, globalStats: null, patternStore: [], graph: null,
            machineWide: {
              totals: {
                patternsLearnedLifetime: 0, patternStoreEntries: 0, trajectoriesRecorded: 0,
                projectCount: 0, mostActiveProject: null,
              },
              perProject: [],
            },
          },
          routing: null,
          error: String(e && e.message || e),
        };
      }
      sendJson(res, 200, payload);
      return;
    }

    async function handleLiveSnapshot(req, res, _query) {
      try {
        const service = await getLive();
        sendJson(res, 200, publicLivePayload(await service.snapshot()));
      } catch {
        sendJson(res, 503, { error: 'live telemetry unavailable' });
      } finally {
        scheduleLiveIdle();
      }
      return;
    }

    async function handleLiveHistory(req, res, query) {
      // On-demand, not part of the SSE stream: a fresh scan per request, same
      // privacy scrubbing (publicLivePayload) as every other live surface.
      try {
        const service = await getLive();
        if (typeof service.historySnapshot !== 'function') {
          sendJson(res, 501, { error: 'history browsing not supported by this live service' });
          return;
        }
        const sinceMs = windowToSinceMs(query.get('window'));
        const pageRequested = query.has('limit') || query.has('pageToken') || query.has('projectKey');
        const payload = pageRequested && typeof service.historyPage === 'function'
          ? await service.historyPage({
            sinceMs,
            projectKey: query.get('projectKey') || null,
            pageToken: query.get('pageToken') || null,
            limit: clampInt(query.get('limit'), 100, 1, 250),
          })
          : await service.historySnapshot({ sinceMs });
        sendJson(res, 200, publicLivePayload(payload));
      } catch (error) {
        sendJson(res, error?.code === 'INVALID_HISTORY_PAGE_TOKEN' ? 400 : 503,
          { error: error?.code === 'INVALID_HISTORY_PAGE_TOKEN'
            ? 'invalid history page token' : 'live telemetry unavailable' });
      } finally {
        scheduleLiveIdle();
      }
      return;
    }

    async function handleLiveEvents(req, res, _query) {
      let service;
      await sseRoute({
        req, res, clients: liveClients,
        maxClients: Math.max(1, Math.min(256, Number(liveMaxClients) || 32)),
        tooManyPayload: { error: 'too many live telemetry clients' },
        limit: Math.max(1, Math.min(4096, Number(liveClientBuffer) || 256)),
        heartbeatMs: liveHeartbeatMs,
        // getLive() may do a dynamic import() + service.start(); sseRoute
        // reserves the cap slot before this runs (TOCTOU fix, Finding 1).
        setup: async () => {
          try { service = await getLive(); } catch {
            sendJson(res, 503, { error: 'live telemetry unavailable' });
            return null;
          }
          return { onOverflow: async () => sseFrame('init', { reset: true, snapshot: await service.snapshot() }) };
        },
        afterOpen: async ({ channel, write, cleanup, isGone, activate, setOnClose }) => {
          const cursorHeader = req.headers['last-event-id'];
          const cursor = typeof cursorHeader === 'string' && cursorHeader.length <= 256
            ? cursorHeader : null;
          let replay = { reset: false, events: [] };
          if (cursorHeader != null && cursor == null) replay = { reset: true, events: [] };
          else if (cursor != null && cursor !== '') {
            try { replay = await service.replay(String(cursor)); } catch { replay = { reset: true, events: [] }; }
          }
          if (isGone()) { cleanup(false); return; }
          // Subscribe before taking the snapshot. Events published while the
          // initial state is assembled are buffered and reconciled below,
          // closing the snapshot→subscribe loss window.
          let initializing = true;
          const pending = [];
          const onEvent = (event) => {
            if (initializing) pending.push(event);
            else {
              try { write(sseFrame('delta', event, event?.eventId)); } catch { cleanup(true); }
            }
          };
          let unsubscribe;
          try { unsubscribe = service.subscribe(onEvent); } catch {
            cleanup(false);
            res.end();
            scheduleLiveIdle();
            return;
          }
          setOnClose(() => {
            if (typeof unsubscribe === 'function') unsubscribe();
            else if (unsubscribe && typeof unsubscribe.unsubscribe === 'function') unsubscribe.unsubscribe();
            scheduleLiveIdle();
          });
          activate();
          if (isGone()) { cleanup(true); return; }
          let snapshot;
          let postSnapshot = { reset: false, events: [] };
          let snapshotPendingCount;
          try {
            snapshot = await service.snapshot();
            snapshotPendingCount = pending.length;
            if (snapshot?.cursor) postSnapshot = await service.replay(String(snapshot.cursor));
          } catch {
            cleanup(true);
            return;
          }
          if (channel.isClosed()) return;
          deliverLiveInit({
            write, replay, snapshot, postSnapshot, pending, snapshotPendingCount,
            markInitialized: () => { initializing = false; },
          });
          channel.startHeartbeat();
        },
      });
    }

    async function handleLiveIntelligence(req, res, query) {
      let selected;
      let poolEntry;
      await sseRoute({
        req, res, clients: intelClients,
        maxClients: Math.max(1, Math.min(256, Number(intelMaxClients) || 32)),
        tooManyPayload: { error: 'too many intelligence clients' },
        limit: Math.max(1, Math.min(4096, Number(intelClientBuffer) || 256)),
        heartbeatMs: liveHeartbeatMs,
        // Same reservation-before-await discipline sseRoute applies to every
        // caller: resolving + starting a project's pool entry may await a
        // dynamic import() + watch.start() on that project's very first
        // connection.
        setup: async () => {
          // Same ?project=<key> resolution as /api/status, off the SAME
          // cached discovery snapshot — the two endpoints can never disagree
          // about which project an absent/unresolvable key defaults to.
          const { projects } = getProjectSnapshot();
          selected = resolveSelectedProject(projects, query.get('project'));
          if (!selected) {
            sendJson(res, 503, { error: 'no ruflo-initialized project found on this machine' });
            return null;
          }
          poolEntry = getOrCreateIntelPoolEntry(selected.path);
          try { await poolEntry.getWatch(); } catch {
            // Nobody else is (yet) watching this path — don't leave a dead
            // entry behind for the next request to trip over.
            if (poolEntry.writers.size === 0) intelPool.delete(selected.path);
            sendJson(res, 503, { error: 'intelligence telemetry unavailable' });
            return null;
          }
          return {
            // Reuses transcriptSseFrame (plain id/event/data lines, no
            // publicLivePayload redaction) rather than sseFrame — this
            // payload is aggregate learning metrics, not live
            // session/transcript content, so the session-privacy scrubbing
            // sseFrame applies is not the right tool here.
            onOverflow: () => transcriptSseFrame('init', readIntelHistory(selected.path)),
            onClose: () => { if (poolEntry.writers.size === 0) intelPool.delete(selected.path); },
          };
        },
        afterOpen: async ({ channel, write, cleanup, isGone, activate, setOnClose }) => {
          setOnClose(() => {
            poolEntry.writers.delete(write);
            // Last writer for this project gone — stop its watcher and forget
            // the pool entry entirely, so an unwatched project's watcher does
            // not run forever (the exact leak this pool replaces the old
            // singleton to avoid).
            if (poolEntry.writers.size === 0) {
              intelPool.delete(selected.path);
              void poolEntry.stop();
            }
          });
          activate();
          poolEntry.writers.add(write);
          if (isGone()) { cleanup(true); return; }

          // One initial frame with the current combined read for the
          // SELECTED project so a fresh page load doesn't have to wait out
          // the watcher's own debounce window; every frame after this is
          // pushed by that project's IntelligenceWatch onUpdate, fanned out
          // to every writer currently watching this same path (and only this
          // path).
          write(transcriptSseFrame('init', readIntelHistory(selected.path)));
          channel.startHeartbeat();
        },
      });
    }

    async function handlePlayback(req, res, query, match) {
      const host = match[1];
      const id = parseSessionId(match[2]);
      const rawAt = query.get('at');
      const atMs = rawAt == null || rawAt === '' ? null : Number(rawAt);
      if (!['claude', 'codex'].includes(host) || !id
        || (atMs != null && (!Number.isFinite(atMs) || atMs < 0
          || atMs > Number.MAX_SAFE_INTEGER))) {
        sendTranscriptJson(res, 400, { error: 'invalid playback target or seek' });
        return;
      }
      let service;
      let opened = false;
      try {
        service = await getTranscripts();
        const stream = service.open(host, id);
        opened = true;
        if (typeof stream?.playback !== 'function') {
          throw new TypeError('transcript playback unavailable');
        }
        sendTranscriptJson(res, 200, stream.playback({ atMs }));
      } catch (error) {
        const message = String(error?.message ?? '');
        const status = /invalid|seek/.test(message) ? 400
          : (/not found|outside/.test(message) ? 404 : 503);
        sendTranscriptJson(res, status, {
          error: status === 404 ? 'transcript not found'
            : (status === 400 ? 'invalid playback target or seek'
              : 'transcript playback unavailable'),
        });
      } finally {
        if (opened) service?.release?.(host, id);
      }
      return;
    }

    async function handleTranscriptEvents(req, res, query, match) {
      const host = match[1];
      const id = parseSessionId(match[2]);
      if (!['claude', 'codex'].includes(host) || !id) {
        sendJson(res, 400, { error: 'invalid transcript target' });
        return;
      }
      let stream;
      let transcriptService;
      await sseRoute({
        req, res, clients: transcriptClients,
        maxClients: Math.max(1, Math.min(64, Number(transcriptMaxClients) || 16)),
        tooManyPayload: { error: 'too many transcript clients' },
        limit: Math.max(1, Math.min(512, Number(transcriptClientBuffer) || 64)),
        heartbeatMs: Math.max(1_000, liveHeartbeatMs),
        setup: async () => {
          try {
            transcriptService = await getTranscripts();
            stream = transcriptService.open(host, id);
          } catch (error) {
            const message = String(error?.message ?? '');
            const status = /invalid/.test(message) ? 400 : (/not found|outside/.test(message) ? 404 : 503);
            sendJson(res, status, { error: status === 404 ? 'transcript not found' : 'transcript unavailable' });
            return null;
          }
          return {
            headers: {
              'x-content-type-options': 'nosniff',
              'cross-origin-resource-policy': 'same-origin',
              'referrer-policy': 'no-referrer',
            },
            onOverflow: () => transcriptSseFrame('gap', { sessionKey: `${host}:${id}`, reason: 'client-overflow' }),
            onClose: () => { transcriptService?.release?.(host, id); },
          };
        },
        afterOpen: async ({ channel, write, cleanup, isGone, activate, setOnClose }) => {
          let initializing = true;
          const pending = [];
          const onEvent = (event) => {
            if (initializing) pending.push(event);
            else write(transcriptSseFrame('delta', event, event?.eventId));
          };
          let unsubscribe;
          try { unsubscribe = stream.subscribe(onEvent); } catch {
            cleanup(false);
            res.end();
            return;
          }
          setOnClose(() => {
            if (typeof unsubscribe === 'function') unsubscribe();
            transcriptService?.release?.(host, id);
          });
          activate();
          if (isGone()) { cleanup(true); return; }

          const header = req.headers['last-event-id'];
          const cursor = typeof header === 'string' && header.length <= 256 ? header : null;
          let replay = { reset: header != null && cursor == null, events: [] };
          try {
            if (cursor) replay = stream.replay(cursor);
            const snapshot = stream.snapshot();
            if (!replay.reset) {
              for (const event of replay.events ?? []) {
                write(transcriptSseFrame('delta', event, event?.eventId));
              }
            }
            write(transcriptSseFrame('init', { reset: !!replay.reset, snapshot }));
          } catch {
            cleanup(true);
            return;
          }
          const emitted = new Set((replay.events ?? []).map((event) => event?.eventId));
          for (const event of pending) {
            if (!event?.eventId || !emitted.has(event.eventId)) {
              write(transcriptSseFrame('delta', event, event?.eventId));
            }
          }
          initializing = false;
          channel.startHeartbeat();
        },
      });
    }

    // ── Usage (ADR-0009). Lazy: nothing below runs until the tab is opened. ──

    async function handleModels(req, res, query) {
      try {
        const payload = await provideModels();
        if (!payload || payload.status === 'empty' || !payload.snapshot) {
          const { createDashboardModelViewPayload } = await import('./model-inventory/read-model.mjs');
          sendJson(res, 200, createDashboardModelViewPayload(payload, { query }));
          return;
        }
        const [{ readModelScopeKey }, { createDashboardModelViewPayload }] = await Promise.all([
          import('./model-inventory/store.mjs'), import('./model-inventory/read-model.mjs'),
        ]);
        const key = modelScopeKey === undefined ? readModelScopeKey() : modelScopeKey;
        if (!key) {
          sendJson(res, 503, { error: 'model dashboard privacy key unavailable' });
          return;
        }
        const days = clampDays(query.get('days'));
        let usage = null;
        if (query.get('view') === 'summary' && typeof usageApi.readIndex === 'function') {
          try { usage = await usageApi.readIndex({ days }); }
          catch { usage = { unavailable: true, sessions: [] }; }
        }
        sendJson(res, 200, createDashboardModelViewPayload(payload, {
          key, query, ...(usage ? { usage, days } : {}),
        }));
      } catch (error) {
        // Do not echo native parser/provider errors: they may contain a private identifier.
        const invalid = error?.code === 'INVALID_MODEL_INVENTORY_QUERY';
        const changed = error?.code === 'MODEL_INVENTORY_SNAPSHOT_CHANGED';
        sendJson(res, invalid ? 400 : changed ? 409 : 500,
          { error: invalid ? 'invalid model inventory query'
            : changed ? 'model inventory changed; retry' : 'model dashboard evidence unavailable' });
      }
      return;
    }

    // Rollups only. Dropping the top-level sessions[] is NOT sufficient on its
    // own: projectTree[].rows holds the SAME object references, so every session
    // still shipped and the "order of magnitude" saving was really about 20%.
    // The tree preview is therefore trimmed to what the client actually renders
    // (USAGE_TREE_PREVIEW rows per project), with rowsTotal kept so the "load
    // all" control still knows the true count and calls /api/sessions for the rest.
    async function handleUsage(req, res, query) {
      try {
        const days = clampDays(query.get('days'));
        const [agg, providerAnalytics] = await Promise.all([
          // lookbackDays widens what usage-index.mjs reads off disk so records
          // from the window BEFORE this one survive to be aggregated;
          // previous:true is what actually turns those into agg.previous
          // (totals + rhythm) — this window's own totals/sessions stay
          // exactly `days` wide either way (usage-index.mjs's own display-
          // cutoff guarantee).
          //
          // The width is the BASELINE's requirement, not the previous window's:
          // `promptBaselines` reads the trailing BASELINE_TRAILING_DAYS before
          // the window and needs BASELINE_MIN_ACTIVE_DAYS of it populated
          // before it will claim a normal. At the old `days * 2` a 7-day
          // window reached 14 days back and every baseline was structurally
          // null, so every detector keyed on one fell back to its absolute
          // threshold without saying so. `days + BASELINE_TRAILING_DAYS` is
          // wider than `days * 2` for every window this server serves, so the
          // previous-window projection is unaffected.
          usageApi.readIndex({
            days, lookbackDays: days + BASELINE_TRAILING_DAYS, previous: true, prompts: true,
          }),
          typeof usageApi.readProviderAnalytics === 'function'
            ? Promise.resolve(usageApi.readProviderAnalytics())
              .catch(() => ({ openrouter: null }))
            : Promise.resolve({ openrouter: null }),
        ]);
        // promptPatterns is destructured OUT rather than spread: the Prompts
        // view reads it through `prompts.patterns` below, and leaving it at
        // the top level too would publish the same projection twice under two
        // names that could later drift apart.
        const { sessions: _sessions, projectTree, promptPatterns: _patterns, ...rollups } = agg || {};
        sendJson(res, 200, {
          ...rollups,
          prompts: promptsPayload(agg || {}),
          // Account-level metadata has no session/host correlation key. Keep
          // it visibly separate instead of laundering it into local totals.
          providerAnalytics,
          projectTree: (projectTree || []).map((n) => ({
            ...n,
            rowsTotal: Array.isArray(n.rows) ? n.rows.length : 0,
            rows: Array.isArray(n.rows) ? n.rows.slice(0, USAGE_TREE_PREVIEW) : [],
          })),
        });
      } catch (e) {
        serverFault(res, '/api/usage', e, 'usage index unavailable');
      }
      return;
    }

    // Plan-limit utilization (ADR-0010). Claude side is a pure file read (the
    // statusline tee); Codex side may spawn ONE vendor subprocess (`codex
    // app-server`), TTL-cached — the same shell-out trust model as
    // `ak status --json` above. No vendor credential is ever read here.
    async function handleLimits(req, res, query) {
      try {
        const agg = await usageApi.readIndex({ days: clampDays(query.get('days')) }).catch(() => null);
        const payload = await provideLimits();
        const { detectLimitInsights } = await import('./usage-insights.mjs');
        sendJson(res, 200, { ...payload, insights: detectLimitInsights(payload, agg) ?? [] });
      } catch (e) {
        serverFault(res, '/api/limits', e, 'plan limits unavailable');
      }
      return;
    }

    // Hook assurance is LAZY and read-only. The source audit only inspects
    // configuration; buildHookDashboardReadModel then drops commands, paths,
    // output and diagnostic prose before anything crosses the HTTP boundary.
    async function handleHooks(req, res, query) {
      const host = query.get('host') || 'all';
      if (!DASHBOARD_HOOK_HOSTS.has(host)) {
        sendJson(res, 400, { error: 'invalid hook host' });
        return;
      }
      try {
        sendJson(res, 200, await getHooks.read(host));
      } catch (e) {
        serverFault(res, '/api/hooks', e, 'hook audit unavailable');
      }
      return;
    }

    async function handleHookSource(req, res, query, match) {
      if (query.has('path')) {
        sendJson(res, 400, { error: 'path parameters are not accepted' });
        return;
      }
      const ref = match?.[1] ?? '';
      if (!/^[a-f0-9]{32}$/.test(ref)) {
        sendJson(res, 404, {
          error: 'Hook source reference is invalid.', code: 'HOOK_SOURCE_NOT_FOUND',
          recovery: 'Refresh Hooks and inspect the current definition again.',
        });
        return;
      }
      try {
        const maskFn = typeof usageApi.masker === 'function' ? await usageApi.masker() : usageApi.maskSecrets;
        sendJson(res, 200, await getHooks.source(ref, maskFn));
      } catch (error) {
        if (error?.code === 'HOOK_SOURCE_NOT_FOUND') sendJson(res, 404, {
          error: 'The audited source reference expired.', code: error.code,
          recovery: 'Refresh Hooks and inspect the current definition again.',
        });
        else if (error?.code === 'HOOK_SOURCE_CHANGED') sendJson(res, 409, {
          error: 'The hook source changed after this audit.', code: error.code,
          recovery: 'The Hooks list must be refreshed before the current definition can be inspected.',
        });
        else serverFault(res, '/api/hooks/source/:ref', error, 'hook source unavailable');
      }
      return;
    }

    // ── System / machine footprint (ADR-0025). Lazy, like Usage above. ──────
    //
    // DELIBERATE DIVERGENCE from publicLivePayload, documented in ADR-0025 §7
    // and the machine-footprint DDD's delivery section: this payload carries
    // ABSOLUTE PATHS and is NOT run through publicLivePayload's leaf-only
    // reduction. That reduction exists because a path is incidental provenance
    // on a *session* payload; here the path IS the answer — a storage
    // breakdown that hides where the bytes live answers nothing. The exposure
    // is bounded by what the collectors structurally cannot do: file CONTENTS
    // are never read (stat metadata, directory entries, and manifest names
    // only), so no transcript, prompt, or tool payload can reach this route to
    // leak. Delivery protections are otherwise identical to every route above
    // — loopback bind, per-session token auth, no-store, nosniff, zero egress.
    async function handleSystem(req, res, query) {
      try {
        const collector = await getSystem();
        // ORDER IS LOAD-BEARING: assemble the payload BEFORE starting a scan.
        // The deep collectors are synchronous, so the first phase occupies the
        // event loop the moment it gets a turn — and `read()` awaits, which
        // hands it that turn. Starting first therefore made the *initiating*
        // request wait out the phase it had just kicked off (measured: 9s),
        // which is precisely the hang the progress state exists to avoid.
        const payload = await collector.read();
        if (query.get('refresh') === 'deep') {
          // Start-or-attach and answer NOW. The collector's single flight means
          // a second refresh joins the running scan rather than racing it, and
          // it never rejects — the catch guards an injected collector that does
          // not honour that contract, so a bad one cannot take the process down
          // with an unhandled rejection.
          // `trees` is a MEASUREMENT parameter, not a view filter: project
          // working trees are only walked when it is set, and one large
          // repository outweighs every shared cache combined — so the ranking
          // has to be re-measured, not re-sorted. Absent means "keep whatever
          // the collector already defaults to".
          const trees = query.get('trees');
          Promise.resolve(collector.refreshDeep(
            trees == null ? undefined : { includeProjectTrees: trees === '1' },
          )).catch(() => {});
          // The payload predates the start by microseconds; re-stamp the live
          // scan block so this response reads "running", not "idle".
          if (typeof collector.scanState === 'function') payload.scan = collector.scanState();
        }
        sendJson(res, 200, payload);
      } catch (e) {
        sendJson(res, 503, { error: 'system footprint unavailable', reason: String(e && e.message || e) });
      }
      return;
    }

    async function handleMaintenance(req, res, query) {
      const refresh = query.getAll('refresh');
      if ([...query.keys()].some((key) => key !== 'refresh')
          || refresh.length > 1 || (refresh.length === 1 && refresh[0] !== 'scan')) {
        sendJson(res, 400, { error: 'invalid maintenance scan request' });
        return;
      }
      try { await (await getMaintenanceApi()).report(req, res, { refresh: query.get('refresh') === 'scan' }); }
      catch { sendJson(res, 503, { error: 'maintenance evidence unavailable' }); }
      return;
    }

    async function handleSessions(req, res, query) {
      try {
        const agg = await usageApi.readIndex({ days: clampDays(query.get('days')) });
        const project = query.get('project') || '';
        const category = query.get('category') || '';
        const offset = clampInt(query.get('offset'), 0, 0, 1_000_000);
        const limit = clampInt(query.get('limit'), 200, 1, 1000);
        const all = (Array.isArray(agg?.sessions) ? agg.sessions : []).filter((s) => (
          (!project || s.project === project) && (!category || s.category === category)
        ));
        sendJson(res, 200, { sessions: all.slice(offset, offset + limit), total: all.length, offset, limit });
      } catch (e) {
        serverFault(res, '/api/sessions', e, 'usage index unavailable');
      }
      return;
    }

    async function handleSession(req, res, query, match) {
      // Validate BEFORE touching the index — a rejected id must never reach a
      // filesystem call, so the 400 happens here and nowhere deeper. Two
      // shapes are accepted: a plain id (unchanged — parseSessionId/
      // resolvesInsideRoot, exactly as before), or a namespaced
      // `<parentId>/<stem>` Claude subagent id (Task 5 round 2), gated by
      // its own dedicated parse+containment pair rather than loosening
      // parseSessionId/resolvesInsideRoot — those two also gate the
      // live-playback/SSE routes, which this fix does not touch.
      const id = parseSessionId(match[1]);
      const plainOk = !!id && TRANSCRIPT_ROOTS.some((r) => resolvesInsideRoot(r, id));
      const nested = plainOk ? null : parseNamespacedSessionId(match[1]);
      const nestedOk = !!nested
        && TRANSCRIPT_ROOTS.some((r) => resolvesNamespacedInsideRoot(r, nested.parentId, nested.stem));
      if (!plainOk && !nestedOk) {
        sendJson(res, 400, { error: 'invalid session id' });
        return;
      }
      const effectiveId = plainOk ? id : `${nested.parentId}/${nested.stem}`;
      try {
        const maskFn = typeof usageApi.masker === 'function' ? await usageApi.masker() : usageApi.maskSecrets;
        const found = await usageApi.readSession(effectiveId);
        // A well-formed id that matches no file is 404, not 200-with-a-null-body.
        // Returning 200 here made every nonexistent session look like an empty
        // one, and turned the route into a mild existence oracle.
        if (!found || !found.meta) {
          sendJson(res, 404, { error: 'no such session' });
          return;
        }
        // maskTurns is the gate, but `meta` used to be forwarded verbatim around
        // it — meta.title happened to be masked upstream at parse time while
        // project/skill/plugin never were. Masking the whole payload here means
        // the fail-closed throw covers meta too, instead of only the turns.
        sendJson(res, 200, {
          meta: maskMeta(found.meta, maskFn),
          turns: maskTurns(found.turns, maskFn),
        });
      } catch (e) {
        // Includes the fail-closed path: no masker → no transcript, ever.
        serverFault(res, '/api/session/:id', e, 'session transcript unavailable');
      }
      return;
    }

    // Exact-path routes (O(1) lookup) win first, then the parametrized ones —
    // mirrors the original if-chain's ordering, though none of these patterns
    // can collide with an exact path above. Splitting the 15-route if-chain
    // (formerly one closure, CC=194) into a handler per route plus this table
    // is the mechanical half of the dashboard refactor (ADR-0036); the SSE
    // routes' shared reserve-slot/early-close/channel lifecycle is factored
    // out separately into sse.mjs's sseRoute().
    const ROUTES = {
      '/api/status': handleStatus,
      '/api/live': handleLiveSnapshot,
      '/api/live/history': handleLiveHistory,
      '/api/live/events': handleLiveEvents,
      '/api/live/intelligence': handleLiveIntelligence,
      '/api/models': handleModels,
      '/api/usage': handleUsage,
      '/api/hooks': handleHooks,
      '/api/limits': handleLimits,
      '/api/system': handleSystem,
      '/api/maintenance': handleMaintenance,
      '/api/sessions': handleSessions,
    };
    /** @type {Array<[RegExp, (req: any, res: any, query: any, match: RegExpExecArray) => Promise<void>]>} */
    const PARAM_ROUTES = [
      [/^\/api\/hooks\/source\/([^/]+)$/, handleHookSource],
      [/^\/api\/live\/playback\/([^/]+)\/([^/]+)$/, handlePlayback],
      [/^\/api\/live\/transcripts\/([^/]+)\/([^/]+)\/events$/, handleTranscriptEvents],
      // (.*) not (.+): the original startsWith('/api/session/') matched a
      // bare trailing slash too (empty id), relying on parseSessionId/
      // handleSession's own validation to fail it closed with 400 — a
      // one-or-more-chars pattern here would 404 that case instead.
      [/^\/api\/session\/(.*)$/, handleSession],
    ];
    const exactHandler = ROUTES[url];
    if (exactHandler) { await exactHandler(req, res, query); return; }
    for (const [pattern, handler] of PARAM_ROUTES) {
      const match = pattern.exec(url);
      if (match) { await handler(req, res, query, match); return; }
    }

    sendNotFound(res);
  });

  // Loopback ONLY — never expose the panel beyond this machine.
  return listenLoopback(server, {
    port, token,
    close: async () => {
      shuttingDown = true;
      cancelLiveIdle();
      for (const cleanup of [...liveClients]) cleanup(true);
      for (const cleanup of [...transcriptClients]) cleanup(true);
      for (const cleanup of [...intelClients]) cleanup(true);
      await new Promise((res) => server.close(() => res(undefined)));
      await stopLive({ force: true });
      try { await (await transcriptServicePromise)?.close?.(); } catch {}
      // Backstop: each intel client's own cleanup above already stops +
      // deletes its pool entry the instant its last writer disconnects,
      // so this is normally a no-op — but stop every REMAINING entry
      // (e.g. one still mid-start with zero writers) rather than assume
      // that cascade always wins the race, so every pool watcher is
      // stopped on shutdown, not just one.
      for (const entry of [...intelPool.values()]) { try { await entry.stop(); } catch {} }
      intelPool.clear();
    },
  });
}
