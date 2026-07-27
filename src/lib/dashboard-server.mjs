// dashboard-server.mjs — a read-only, localhost-only web dashboard for the kit.
//
// Zero runtime deps: a plain node:http server bound to 127.0.0.1. Routes:
//   GET /            → one self-contained HTML document (all CSS + JS inline,
//                      no external fetches — offline-first, matches the kit ethos)
//   GET /api/status  → JSON: the same subsystem rows `ak status --json` emits,
//                      PLUS version drift, the project's .claude-flow/improvement.json
//                      (if present), and the health-history ring (if present).
//   GET /api/usage    → the usage Aggregate MINUS sessions[] (ADR-0009)
//   GET /api/sessions → the session list, filtered + paginated
//   GET /api/session/:id → one transcript, secrets masked SERVER-side
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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { driftReport, selfDrift } from './versions.mjs';
import { drift as ruvnetBrainDrift } from './ruvnet-brain.mjs';
import { loadKitConfig } from './config.mjs';
import { resolveRoutes, routingSummary, ACTIVITIES, HOST_PROVIDER } from './routing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The health-history ring: an array of point samples over time. Accepts either
 *  a bare array or `{ samples: [...] }`. Returns null when absent/unreadable. */
function readHealthRing(cwd) {
  const raw = readJsonSafe(path.join(cwd, '.claude-flow', 'health-history.json'));
  if (!raw) return null;
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw.samples) ? raw.samples : null;
  return arr && arr.length ? arr : null;
}

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

/** Assemble the full /api/status payload. */
async function collectData({ cwd, fetchStatus }) {
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
  }

  return {
    generatedAt: new Date().toISOString(),
    kit: { name: '@pacphi/agentic-kit', version: kitVersion() },
    overall,
    error: status?.error ?? null,
    rows,
    drift,
    improvement: readJsonSafe(path.join(cwd, '.claude-flow', 'improvement.json')),
    health: readHealthRing(cwd),
    routing: routingPayload(),
  };
}

/** The per-activity routing matrix for the dashboard (ADR-0005). Null unless a
 *  dualRouting policy is set, so single-host projects render nothing new. */
function routingPayload() {
  try {
    const cfg = loadKitConfig();
    const policy = cfg.providers?.dualRouting ?? {};
    if (!Object.keys(policy).length) return null;
    const routes = resolveRoutes(policy);
    return {
      primaryHost: cfg.providers?.primaryHost ?? 'claude',
      summary: routingSummary(policy),
      routes: ACTIVITIES.map((activity) => {
        const r = routes[activity];
        return {
          activity, host: r.host, provider: HOST_PROVIDER[r.host], model: r.model ?? '',
          source: r.source, akOriginated: !!r.akOriginated,
          escalate: (r.escalate ?? []).map((e) => e.host),
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
    outdated: !!b.outdated,
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage tab plumbing (ADR-0009). Everything here is either a pure guard or a
// thin adapter over usage-index.mjs — no parsing, no aggregation, no pricing.
// ─────────────────────────────────────────────────────────────────────────────

/** The transcript stores. Only used to assert containment — usage-index.mjs owns
 *  the actual reads and may override its own roots for test. */
/** Session rows per project embedded in /api/usage. Matches what the tree
 *  renders before "load all"; the rest come from /api/sessions on demand. */
const USAGE_TREE_PREVIEW = 25;

const TRANSCRIPT_ROOTS = [
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(os.homedir(), '.codex', 'sessions'),
];

/** Session ids are an OPAQUE, closed alphabet — no separators, no dot segments.
 *  Decoding happens FIRST, so `%2e%2e%2f` is judged as the `../` it becomes;
 *  validating the raw form and decoding after is the classic way this guard is
 *  defeated. Returns the safe id, or null (→ 400) for anything else. Pure. */
export function parseSessionId(raw) {
  let id;
  try { id = decodeURIComponent(String(raw ?? '')); } catch { return null; }
  if (id !== String(raw ?? '') && /%[0-9a-f]{2}/i.test(id)) return null; // double-encoded
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) return null;
  if (id === '.' || id === '..') return null;   // legal chars, illegal meaning
  return id;
}

/** Defence in depth behind parseSessionId: the id, resolved against a transcript
 *  root, must land as a DIRECT child of that root. parseSessionId already bars
 *  every separator, so this cannot currently reject anything it accepted — it is
 *  here so that a future loosening of the alphabet fails this check loudly
 *  instead of quietly opening a traversal. Pure. */
export function resolvesInsideRoot(root, id) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, id);
  return resolved !== base
    && resolved.startsWith(base + path.sep)
    && path.dirname(resolved) === base;
}

/** Run every turn body through the masker before it reaches the wire (ADR-0009
 *  §8). Copies — never mutates the caller's turns. THROWS when no masker is
 *  supplied: an unmasked transcript must fail the request, not slip out. Pure. */
export function maskTurns(turns, maskFn) {
  if (typeof maskFn !== 'function') throw new Error('no secret masker available — refusing to serve an unmasked transcript');
  return (Array.isArray(turns) ? turns : []).map((t) => {
    const out = { ...t };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'string') out[k] = maskFn(out[k]);
    }
    return out;
  });
}

/**
 * Mask a session's metadata. Sibling of `maskTurns` and deliberately as strict:
 * `title` is the ai-title, or the first 100 chars of the user's opening prompt
 * when there is none, and `project` / `skill` / `plugin` are transcript-derived
 * too. Forwarding `meta` around the gate meant a secret in any of them reached
 * the browser unmasked. Throws on a missing masker for the same reason
 * `maskTurns` does — fail closed, and cover the WHOLE payload, not just part.
 */
export function maskMeta(meta, maskFn) {
  if (typeof maskFn !== 'function') throw new Error('no secret masker available — refusing to serve unmasked metadata');
  if (!meta || typeof meta !== 'object') return null;
  const out = { ...meta };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string') out[k] = maskFn(out[k]);
  }
  return out;
}

/** Lazily bind usage-index.mjs. Deliberately NOT a static import: the module
 *  walks two transcript stores, and the panel must boot (and serve /api/status)
 *  without paying for that until the Usage tab is actually opened. Same named
 *  exports the spec specifies — `readIndex`, `readSession`, `maskSecrets`. */
function lazyUsage() {
  let mod = null;
  const load = async () => (mod ||= await import('./usage-index.mjs'));
  return {
    readIndex: async (opts) => (await load()).readIndex(opts),
    readSession: async (id) => (await load()).readSession(id),
    maskSecrets: async (s) => (await load()).maskSecrets(s),
    // resolved at call time so a module that ships masking later still fails
    // closed rather than silently serving raw text.
    masker: async () => (await load()).maskSecrets,
  };
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

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

/**
 * Start the dashboard HTTP server, bound to loopback only.
 * @param {{ port?: number, cwd?: string, fetchStatus?: () => Promise<any>, usage?: any,
 *           limits?: () => Promise<any> }} [opts]
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export function startDashboard({ port = 7431, cwd = process.cwd(), fetchStatus, usage, limits } = {}) {
  const provide = fetchStatus || shellOutStatus(cwd);
  const usageApi = usage || lazyUsage();
  // Injectable like `usage`: tests must never spawn a real codex or read the
  // real ~/.config through this route. Lazy for the same reason lazyUsage is.
  const provideLimits = limits || (async () => (await import('./quota.mjs')).readLimits());
  const html = renderPage({ name: '@pacphi/agentic-kit', version: kitVersion() });

  const server = http.createServer(async (req, res) => {
    const raw = req.url || '/';
    const qi = raw.indexOf('?');
    const url = qi < 0 ? raw : raw.slice(0, qi);
    const query = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
    if (req.method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
    // DNS-rebinding guard: the socket binds loopback-only, but a hostile page
    // can rebind its own hostname to 127.0.0.1 and read /api/status cross-
    // origin (the browser's SOP keys on the NAME, not the address). Only
    // loopback literals are legitimate Hosts for this panel.
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden (unexpected Host)');
      return;
    }

    // Cross-site request guard. The Host check above stops a hostile page from
    // READING a response, and no ACAO is emitted — but a plain <img>/<script>
    // GET to 127.0.0.1 still carries a loopback Host, needs no preflight, and
    // EXECUTES. On /api/usage that means a full-corpus parse plus a cache
    // rewrite, and since the memo is keyed on `days`, iterating days=1..365
    // defeats it. Blind, but a real CPU/disk DoS from any page the user visits
    // while the panel is open.
    //
    // Fetch-metadata is the right tool: our own page sends `same-origin`;
    // a hostile page sends `cross-site`. Absent (curl, older browsers) is
    // allowed so the panel stays scriptable from the terminal — this raises the
    // bar for the drive-by case without breaking legitimate non-browser use.
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden (cross-site request)');
      return;
    }
    const origin = String(req.headers.origin || '').toLowerCase();
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden (foreign Origin)');
      return;
    }

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (url === '/api/status') {
      let payload;
      try { payload = await collectData({ cwd, fetchStatus: provide }); }
      catch (e) { payload = { generatedAt: new Date().toISOString(), overall: 'unknown', rows: [], drift: null, improvement: null, health: null, error: String(e && e.message || e) }; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    // ── Usage (ADR-0009). Lazy: nothing below runs until the tab is opened. ──

    // Rollups only. Dropping the top-level sessions[] is NOT sufficient on its
    // own: projectTree[].rows holds the SAME object references, so every session
    // still shipped and the "order of magnitude" saving was really about 20%.
    // The tree preview is therefore trimmed to what the client actually renders
    // (USAGE_TREE_PREVIEW rows per project), with rowsTotal kept so the "load
    // all" control still knows the true count and calls /api/sessions for the rest.
    if (url === '/api/usage') {
      try {
        const agg = await usageApi.readIndex({ days: clampDays(query.get('days')) });
        const { sessions: _sessions, projectTree, ...rollups } = agg || {};
        sendJson(res, 200, {
          ...rollups,
          projectTree: (projectTree || []).map((n) => ({
            ...n,
            rowsTotal: Array.isArray(n.rows) ? n.rows.length : 0,
            rows: Array.isArray(n.rows) ? n.rows.slice(0, USAGE_TREE_PREVIEW) : [],
          })),
        });
      } catch (e) {
        sendJson(res, 500, { error: String(e && e.message || e) });
      }
      return;
    }

    // Plan-limit utilization (ADR-0010). Claude side is a pure file read (the
    // statusline tee); Codex side may spawn ONE vendor subprocess (`codex
    // app-server`), TTL-cached — the same shell-out trust model as
    // `ak status --json` above. No vendor credential is ever read here.
    if (url === '/api/limits') {
      try {
        const agg = await usageApi.readIndex({ days: clampDays(query.get('days')) }).catch(() => null);
        const payload = await provideLimits();
        const { detectLimitInsights } = await import('./usage-insights.mjs');
        sendJson(res, 200, { ...payload, insights: detectLimitInsights(payload, agg) ?? [] });
      } catch (e) {
        sendJson(res, 500, { error: String(e && e.message || e) });
      }
      return;
    }

    if (url === '/api/sessions') {
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
        sendJson(res, 500, { error: String(e && e.message || e) });
      }
      return;
    }

    if (url.startsWith('/api/session/')) {
      // Validate BEFORE touching the index — a rejected id must never reach a
      // filesystem call, so the 400 happens here and nowhere deeper.
      const id = parseSessionId(url.slice('/api/session/'.length));
      if (!id || !TRANSCRIPT_ROOTS.some((r) => resolvesInsideRoot(r, id))) {
        sendJson(res, 400, { error: 'invalid session id' });
        return;
      }
      try {
        const maskFn = typeof usageApi.masker === 'function' ? await usageApi.masker() : usageApi.maskSecrets;
        const found = await usageApi.readSession(id);
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
        sendJson(res, 500, { error: String(e && e.message || e) });
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // Loopback ONLY — never expose the panel beyond this machine.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = addr && typeof addr === 'object' ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        port: actual,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The page. One document, everything inline. Only `name` and `version` are
// interpolated server-side; the client fetches /api/status and renders live.
//
// Layout: a sticky segmented control (Apple's tab idiom) splits the panel into
// five views — Overview, Hosts & Routing, Providers, Runtime, Intelligence.
// Problems never hide behind a tab: Overview aggregates every attention card,
// and each tab carries a count badge when something in it is failing/warning.
// ─────────────────────────────────────────────────────────────────────────────
function renderPage({ name, version }) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230a84ff'/%3E%3Ccircle cx='16' cy='16' r='7' fill='none' stroke='white' stroke-width='3'/%3E%3C/svg%3E">
<title>agentic-kit · dashboard</title>
<style>${CSS}</style>
</head>
<body>
<header class="band">
  <div class="band-lead">
    <div class="mark" aria-hidden="true"></div>
    <div class="band-titles">
      <h1 class="kit-name">${escapeHtml(name)}</h1>
      <div class="kit-sub"><span class="mono ver">v${escapeHtml(version)}</span><span class="sep">·</span><span>local diagnostic panel</span></div>
    </div>
  </div>
  <div class="band-verdict">
    <span class="dot" id="verdict-dot" data-level="unknown"></span>
    <span class="verdict-text" id="verdict-text">connecting…</span>
  </div>
  <div class="band-tools">
    <span class="pulse" id="pulse"></span>
    <span class="upd mono" id="updated">—</span>
    <div class="poll">
      <button class="play on" id="poll-play" type="button" title="polling on — click to pause" aria-label="pause polling">&#9208;</button>
      <button class="ivl mono" id="poll-ivl" type="button" title="polling interval" aria-haspopup="true" aria-expanded="false">30s <span class="caret" aria-hidden="true">&#9662;</span></button>
      <button class="refresh" id="poll-now" type="button" title="refresh now" aria-label="refresh now">&#8635;</button>
    </div>
    <button class="toggle" id="theme-toggle" type="button" aria-label="toggle theme" title="toggle theme">
      <span class="icon" id="theme-icon" aria-hidden="true"></span>
    </button>
  </div>
  <div class="menu" id="poll-menu" hidden>
    <button type="button" data-ms="15000">15s</button>
    <button type="button" data-ms="30000">30s</button>
    <button type="button" data-ms="60000">1m</button>
    <button type="button" data-ms="300000">5m</button>
    <button type="button" data-ms="900000">15m</button>
    <button type="button" data-ms="1800000">30m</button>
    <div class="sep"></div>
    <button type="button" data-ms="3600000">1h</button>
    <button type="button" data-ms="21600000">6h</button>
    <button type="button" data-ms="43200000">12h</button>
    <button type="button" data-ms="86400000">24h</button>
  </div>
</header>

<nav class="tabbar">
  <div class="seg" role="tablist" aria-label="dashboard sections" id="seg">
    <span class="seg-thumb" id="seg-thumb" aria-hidden="true"></span>
    <button class="seg-btn" role="tab" id="tab-overview" data-tab="overview" aria-selected="true" aria-controls="panel-overview" type="button">Overview<span class="badge" id="badge-overview" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-hosts" data-tab="hosts" aria-selected="false" aria-controls="panel-hosts" type="button">Hosts &amp; Routing<span class="badge" id="badge-hosts" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-providers" data-tab="providers" aria-selected="false" aria-controls="panel-providers" type="button">Providers<span class="badge" id="badge-providers" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-runtime" data-tab="runtime" aria-selected="false" aria-controls="panel-runtime" type="button">Runtime<span class="badge" id="badge-runtime" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-intel" data-tab="intel" aria-selected="false" aria-controls="panel-intel" type="button">Intelligence<span class="badge" id="badge-intel" hidden></span></button>
    <button class="seg-btn" role="tab" id="tab-usage" data-tab="usage" aria-selected="false" aria-controls="panel-usage" type="button">Usage</button>
  </div>
</nav>

<main class="wrap">
  <section class="panel" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview">
    <div class="summary" id="summary" hidden></div>
    <div class="notice" id="update-notice" hidden></div>
    <div id="attention" aria-live="polite"></div>
    <h2 class="subhead" id="map-head" hidden>all subsystems</h2>
    <div class="statusmap" id="statusmap"></div>
  </section>

  <section class="panel" id="panel-hosts" role="tabpanel" aria-labelledby="tab-hosts" hidden>
    <div id="cards-hosts"></div>
    <section class="strip" id="routing" hidden>
      <div class="strip-head">
        <h2 class="strip-title">per-activity routing</h2>
        <span class="mono strip-note" id="routing-note"></span>
      </div>
      <div class="route-matrix" id="route-matrix"></div>
    </section>
  </section>

  <section class="panel" id="panel-providers" role="tabpanel" aria-labelledby="tab-providers" hidden>
    <div id="cards-providers"></div>
    <section class="strip" id="models" hidden>
      <div class="strip-head">
        <h2 class="strip-title">routed models</h2>
        <span class="mono strip-note" id="models-note"></span>
      </div>
      <div class="note"><span class="i">&#8505;</span><span>This is your <b>per-activity routing policy</b> &mdash;
        which host and model ak <i>assigns</i> to each kind of work. It is projected into
        <b>agentic-qe</b> agent overrides and <b>ak dual run</b> pipelines; agentic-qe also has its own
        model router, so a route here is the assignment, not a guarantee.
        It does <b>not</b> govern the model an interactive Claude Code or codex CLI session uses &mdash;
        you choose that per session with <span class="mono">/model</span>.
        For the models that <b>actually ran</b>, see <b>Usage &rarr; Scorecard</b>.</span></div>
      <div class="model-list" id="model-list"></div>
    </section>
  </section>

  <section class="panel" id="panel-runtime" role="tabpanel" aria-labelledby="tab-runtime" hidden>
    <div id="cards-runtime"></div>
  </section>

  <section class="panel" id="panel-intel" role="tabpanel" aria-labelledby="tab-intel" hidden>
    <div id="cards-intel"></div>
    <section class="strip" id="history" hidden>
      <div class="strip-head">
        <h2 class="strip-title">learning over time</h2>
        <span class="mono strip-note" id="strip-note"></span>
      </div>
      <div class="spark-row">
        <figure class="spark">
          <figcaption class="mono">patterns learned</figcaption>
          <div class="spark-svg" id="spark-patterns"></div>
        </figure>
        <figure class="spark">
          <figcaption class="mono">improvement Δpp</figcaption>
          <div class="spark-svg" id="spark-delta"></div>
        </figure>
      </div>
    </section>
  </section>

  <section class="panel" id="panel-usage" role="tabpanel" aria-labelledby="tab-usage" hidden>
    <div class="usage-bar">
      <div class="seg subseg" role="tablist" aria-label="usage views" id="usage-seg">
        <button class="seg-btn" role="tab" data-view="score" aria-selected="true" type="button">Scorecard</button>
        <button class="seg-btn" role="tab" data-view="limits" aria-selected="false" type="button">Limits</button>
        <button class="seg-btn" role="tab" data-view="findings" aria-selected="false" type="button">Findings<span class="segbadge" id="u-findings-n" hidden></span></button>
        <button class="seg-btn" role="tab" data-view="sessions" aria-selected="false" type="button">Sessions<span class="mono seg-n" id="u-sessions-n"></span></button>
        <button class="seg-btn" role="tab" data-view="transcript" aria-selected="false" type="button">Transcript</button>
      </div>
      <div class="filters" id="usage-days" role="group" aria-label="window">
        <button class="chipf" type="button" data-days="7">7d</button>
        <button class="chipf on" type="button" data-days="14">14d</button>
        <button class="chipf" type="button" data-days="30">30d</button>
      </div>
    </div>

    <section class="view" id="v-score">
      <div class="hero" id="u-hero"></div>
      <div class="note"><span class="i">&#8505;</span><span>Dollar figures are <b>API list-price equivalents</b> &mdash;
        what these tokens would cost metered. On a Max/Pro subscription you are not billed this.
        Cache reads bill at 0.1&times; input and cache writes at 1.25&times;; ignoring that would overstate
        a window by roughly <b>10&times;</b>. <span class="mono" id="u-asof"></span></span></div>
      <section class="strip">
        <div class="sh"><h2>cost per day</h2><span class="n mono" id="u-days-note"></span></div>
        <div class="days" id="u-daybars"></div>
      </section>
      <div class="two">
        <section class="strip">
          <div class="sh"><h2>by host</h2><span class="n mono">claude vs codex</span></div>
          <div class="psplit" id="u-hosts"></div>
          <div class="tokbar" id="u-tokbar"></div>
          <div class="legend" id="u-toklegend"></div>
        </section>
        <section class="strip">
          <div class="sh"><h2>when you work</h2><span class="n mono">responses &middot; local time</span></div>
          <div id="u-punch"></div>
        </section>
      </div>
      <div class="two">
        <section class="strip">
          <div class="sh"><h2>models in play</h2><span class="n mono">observed in transcripts &middot; by api-equivalent cost<span id="u-models-note"></span></span></div>
          <div id="u-models"></div>
        </section>
        <section class="strip">
          <div class="sh"><h2>projects</h2><span class="n mono" id="u-projects-note"></span></div>
          <div id="u-projects"></div>
        </section>
      </div>
      <section class="strip">
        <div class="sh"><h2>what you worked on</h2>
          <span class="n mono">classified from titles, skills &amp; tool mix &middot; click to filter</span></div>
        <div id="u-cats"></div>
        <div class="legend" style="margin-top:11px">
          <span class="lg"><i class="conf"></i>dot opacity = classifier confidence</span>
          <span class="lg">Unclassified is shown, never force-fit</span>
        </div>
      </section>
    </section>

    <section class="view" id="v-limits" hidden>
      <div class="note"><span class="i">&#8505;</span><span>Utilization here is <b>vendor-reported</b> &mdash;
        the plan&rsquo;s own percentages, a denominator local transcripts cannot compute.
        Claude&rsquo;s numbers arrive via the managed statusLine while a session runs; Codex&rsquo;s come from
        <b>codex app-server</b> using codex&rsquo;s own login. This panel reads no vendor credential.</span></div>
      <div class="two">
        <section class="strip">
          <div class="sh"><h2>claude plan limits</h2><span class="n mono" id="u-lim-claude-note"></span></div>
          <div class="lim" id="u-lim-claude"></div>
        </section>
        <section class="strip">
          <div class="sh"><h2>codex plan limits</h2><span class="n mono" id="u-lim-codex-note"></span></div>
          <div class="lim" id="u-lim-codex"></div>
        </section>
      </div>
      <div class="ins-grid" id="u-lim-insights"></div>
      <div class="foot">windows are keyed by their duration, never by the vendor&rsquo;s primary/secondary slot &middot;
        stale data is labelled stale, not hidden</div>
    </section>

    <section class="view" id="v-findings" hidden>
      <div class="note"><span class="i">&#8505;</span><span id="u-findings-note"></span></div>
      <div class="ins-grid" id="u-insights"></div>
      <div class="foot">grounded in local measurement first; vendor benchmarks are labelled as such &middot;
        third-party &ldquo;model X vs Y&rdquo; blog comparisons are deliberately not used as evidence</div>
    </section>

    <section class="view" id="v-sessions" hidden>
      <div class="note"><span class="i">&#8505;</span><span>Grouped by project, aggregate first.
        Expand a project to see its sessions; click <b>&#9707;</b> on any session to read its transcript.</span></div>
      <div class="ptree" id="u-tree"></div>
      <div class="foot">durations are session span (first&rarr;last event), not exclusive wall-clock</div>
    </section>

    <section class="view" id="v-transcript" hidden>
      <div class="tcrumb" id="u-crumb"></div>
      <section class="strip" id="u-turns"></section>
      <div class="foot">secret-shaped strings are masked server-side &mdash; the original never reaches this page &middot; no export button by design</div>
    </section>
  </section>

  <footer class="foot mono">
    <span id="foot-note">read-only · 127.0.0.1 · nothing here mutates state</span>
  </footer>
</main>

<script>${JS}</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Styles ───────────────────────────────────────────────────────────────────
// Design: Apple system motif. SF stack with a tight-tracked large title, a
// frosted sticky segmented control (the macOS/iOS tab idiom), hairline
// separators, soft diffuse shadows, and the Apple system palette — systemBlue
// accent, systemGreen/Orange/Red status semantics. Restraint over ornament;
// CSS variables drive BOTH themes.
const CSS = `
:root{
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue","Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono","Menlo","Cascadia Code",monospace;
  --r:16px; --r-sm:11px;
  /* One height for every scrollable list, so the page frame never changes
     between Findings / Sessions / Transcript. The 420px subtrahend is the fixed
     chrome above and below: header band + tab bar + sub-tabs + note + footer.
     Without it the region ran to the viewport edge and the footer sat below the
     fold, forcing a window scroll to read it — the thing in-place scrolling was
     supposed to avoid. */
  --listh:clamp(200px, calc(100vh - 420px), 520px);
}
:root[data-theme="dark"]{
  --bg:#000000; --panel:#1c1c1e; --panel-2:#2c2c2e; --raised:#3a3a3c; --thumb:#48484a;
  --ink:#f5f5f7; --ink-2:rgba(235,235,245,.64); --ink-dim:rgba(235,235,245,.38);
  --line:rgba(255,255,255,.09); --line-2:rgba(255,255,255,.17);
  --accent:#0a84ff; --accent-soft:rgba(10,132,255,.16);
  --ok:#30d158; --warn:#ff9f0a; --fail:#ff453a; --info:#98989d; --purple:#bf5af2;
  --material:rgba(16,16,18,.72);
  --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -20px rgba(0,0,0,.9);
}
:root[data-theme="light"]{
  --bg:#f5f5f7; --panel:#ffffff; --panel-2:#f2f2f7; --raised:#ffffff; --thumb:#ffffff;
  --ink:#1d1d1f; --ink-2:rgba(60,60,67,.68); --ink-dim:rgba(60,60,67,.42);
  --line:rgba(60,60,67,.12); --line-2:rgba(60,60,67,.22);
  --accent:#007aff; --accent-soft:rgba(0,122,255,.12);
  --ok:#34c759; --warn:#ff9500; --fail:#ff3b30; --info:#8e8e93; --purple:#af52de;
  --material:rgba(249,249,251,.78);
  --shadow:0 1px 2px rgba(0,0,0,.05),0 12px 30px -22px rgba(0,0,0,.22);
}
@media (prefers-color-scheme:light){
  :root:not([data-theme]){ color-scheme:light; }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg);
  color:var(--ink);
  font-family:var(--sans);
  font-size:14px; line-height:1.5;
  -webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums;
  min-height:100vh;
  overflow-x:hidden;
}
.mono{font-family:var(--mono)}

/* ── header band ── */
.band{
  position:relative;
  display:flex; align-items:center; gap:20px; flex-wrap:wrap;
  padding:24px clamp(16px,4vw,40px) 14px;
}
.band-lead{display:flex; align-items:center; gap:14px; min-width:0}
.mark{
  width:40px; height:40px; flex:none; border-radius:10px;
  background:linear-gradient(165deg,#5ac8fa,#007aff 55%,#0a5fd6);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 8px 18px -8px rgba(0,122,255,.55);
  position:relative;
}
.mark::after{
  content:""; position:absolute; inset:11px; border-radius:50%;
  border:2.5px solid rgba(255,255,255,.92);
  border-top-color:rgba(255,255,255,.35);
  transform:rotate(-45deg);
}
.band-titles{min-width:0}
.kit-name{
  font-size:clamp(21px,2.6vw,28px); font-weight:700; letter-spacing:-.022em;
  line-height:1.1; margin:0;
}
.kit-sub{color:var(--ink-dim); font-size:12px; display:flex; gap:8px; align-items:center; margin-top:3px}
.kit-sub .sep{opacity:.5}
.ver{color:var(--accent)}
.band-verdict{
  display:flex; align-items:center; gap:9px; margin-left:auto;
  padding:7px 15px; border:1px solid var(--line); border-radius:100px;
  background:var(--panel);
}
.verdict-text{font-size:13px; font-weight:500; letter-spacing:-.006em}
.band-tools{display:flex; align-items:center; gap:10px}
.pulse{
  width:8px; height:8px; border-radius:50%; background:var(--accent); flex:none;
  animation:pulse 2.4s ease-out infinite;
}
/* paused reads as paused: the pulse greys and stops, so "live" is never implied
   by a still-animating dot over stale numbers. */
.pulse.off{background:var(--ink-dim); animation:none}
@keyframes pulse{
  0%{box-shadow:0 0 0 0 var(--accent-soft)}
  70%{box-shadow:0 0 0 7px transparent}
  100%{box-shadow:0 0 0 0 transparent}
}
.upd{font-size:11.5px; color:var(--ink-dim); min-width:96px}

/* ── poll control (governs EVERY tab, not just Usage) ── */
.poll{
  display:flex; align-items:center; gap:2px; padding:3px;
  border:1px solid var(--line); border-radius:100px; background:var(--panel);
}
.poll button{
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  border:0; background:transparent; color:var(--ink-2);
  font-family:inherit; font-size:12px; height:26px; padding:0 10px;
  border-radius:100px; cursor:pointer; transition:background .15s ease, color .15s ease;
}
.poll button:hover:not(:disabled){background:var(--panel-2); color:var(--ink)}
.poll button:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.poll button:disabled{opacity:.38; cursor:not-allowed}
.poll .play{width:28px; padding:0}
.poll .play.on{color:var(--accent)}
.poll .ivl{min-width:56px; justify-content:space-between}
.poll .caret{opacity:.5}
.poll .refresh{width:28px; padding:0; font-size:14px}
.poll .refresh.spin{animation:spin .6s linear}
@keyframes spin{to{transform:rotate(360deg)}}
.menu{
  position:absolute; z-index:60; right:clamp(16px,4vw,40px); top:100%; margin-top:-6px;
  background:var(--panel); border:1px solid var(--line-2); border-radius:var(--r-sm);
  box-shadow:var(--shadow); padding:5px; min-width:118px;
}
.menu[hidden]{display:none}
.menu button{
  display:flex; width:100%; justify-content:space-between; align-items:center;
  font-family:var(--mono); font-size:12px; height:26px; padding:0 9px;
  border-radius:7px; background:transparent; border:0; color:var(--ink-2); cursor:pointer;
}
.menu button:hover{background:var(--panel-2); color:var(--ink)}
.menu button.sel{color:var(--accent)}
.menu .sep{height:1px; background:var(--line); margin:4px 2px}
.toggle{
  display:inline-flex; align-items:center; justify-content:center;
  width:34px; height:34px; padding:0;
  color:var(--ink-2); background:var(--panel);
  border:1px solid var(--line); border-radius:50%; cursor:pointer;
  transition:border-color .2s ease, color .2s ease, background .2s ease;
}
.toggle:hover{border-color:var(--line-2); color:var(--accent); background:var(--panel-2)}
.toggle:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.toggle .icon{display:inline-flex}
.toggle .icon svg{width:16px; height:16px; display:block}

/* ── sticky frosted segmented control ── */
.tabbar{
  position:sticky; top:0; z-index:20;
  display:flex; padding:8px clamp(16px,4vw,40px) 10px;
  background:var(--material);
  -webkit-backdrop-filter:saturate(180%) blur(20px);
  backdrop-filter:saturate(180%) blur(20px);
  border-bottom:1px solid var(--line);
}
.seg{
  position:relative; display:inline-flex; gap:2px; padding:3px;
  border-radius:12px; background:var(--panel-2);
  max-width:100%; overflow-x:auto; scrollbar-width:none;
}
.seg::-webkit-scrollbar{display:none}
.seg-btn{
  position:relative; z-index:1; border:0; background:transparent;
  color:var(--ink-2); font-family:inherit; font-size:13px; font-weight:500;
  letter-spacing:-.006em; padding:6px 14px; border-radius:9px; cursor:pointer;
  white-space:nowrap; display:inline-flex; align-items:center; gap:6px;
  transition:color .2s ease;
}
.seg-btn[aria-selected="true"]{color:var(--ink); font-weight:600}
.seg-btn:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.seg-thumb{
  position:absolute; top:3px; left:3px; height:calc(100% - 6px); width:0;
  border-radius:9px; background:var(--thumb);
  box-shadow:0 1px 4px rgba(0,0,0,.18),0 0 0 .5px rgba(0,0,0,.04);
  transition:left .25s cubic-bezier(.3,.7,.3,1), width .25s cubic-bezier(.3,.7,.3,1);
}
.badge{
  min-width:16px; height:16px; padding:0 4px; border-radius:8px;
  background:var(--fail); color:#fff; font-size:10.5px; font-weight:600;
  display:inline-flex; align-items:center; justify-content:center; line-height:1;
}
.badge[data-tone="warn"]{background:var(--warn)}
.badge[hidden]{display:none}

/* ── layout ── */
.wrap{padding:clamp(16px,4vw,40px); max-width:1180px; margin:0 auto}
.panel{animation:fade .25s ease}
.panel[hidden]{display:none}
@keyframes fade{from{opacity:0; transform:translateY(4px)}to{opacity:1; transform:none}}

/* ── triage summary + update notice (Overview) ── */
.summary{
  display:flex; flex-wrap:wrap; gap:9px; align-items:center;
  margin-bottom:14px; font-size:12.5px;
}
.pill{
  display:inline-flex; align-items:center; gap:7px;
  padding:5px 12px; border-radius:100px;
  border:1px solid var(--line); background:var(--panel);
  color:var(--ink-2); letter-spacing:-.006em;
}
.pill .dot{width:8px; height:8px}
.pill b{color:var(--ink); font-weight:600}
.pill[data-level="fail"]{border-color:color-mix(in srgb,var(--fail) 50%,transparent)}
.pill[data-level="warn"]{border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.pill[data-tone="calm"]{opacity:.72}
.notice{
  display:flex; align-items:baseline; gap:9px;
  padding:10px 14px; margin-bottom:14px;
  border-radius:var(--r-sm); background:var(--accent-soft);
  color:var(--ink-2); font-size:13px;
}
.notice .up{color:var(--accent); font-weight:700}
.notice code{font-family:var(--mono); color:var(--ink); font-size:12px}
.notice b{color:var(--ink); font-weight:600}
.allclear{
  display:flex; align-items:center; gap:10px;
  padding:20px 22px; margin-bottom:6px;
  border-radius:var(--r); background:var(--panel); border:1px solid var(--line);
  box-shadow:var(--shadow); color:var(--ink-2); font-size:14px;
}

/* ── cards ── */
.grid{
  display:grid; gap:14px;
  grid-template-columns:repeat(auto-fill,minmax(272px,1fr));
}
.card{
  background:var(--panel); border:1px solid var(--line);
  border-radius:var(--r); padding:16px 17px 15px;
  box-shadow:var(--shadow);
  opacity:0; transform:translateY(6px);
  animation:rise .45s cubic-bezier(.2,.7,.3,1) forwards;
  overflow:hidden;
}
@keyframes rise{to{opacity:1; transform:none}}
.card-top{display:flex; align-items:center; gap:10px; margin-bottom:9px}
.dot{
  width:10px; height:10px; border-radius:50%; flex:none;
  background:var(--lvl,var(--info));
  box-shadow:0 0 0 3px color-mix(in srgb,var(--lvl,var(--info)) 20%, transparent);
}
.card[data-level="ok"]{--lvl:var(--ok)}
.card[data-level="warn"]{--lvl:var(--warn)}
.card[data-level="fail"]{--lvl:var(--fail)}
.card[data-level="info"]{--lvl:var(--info)}
.card[data-level="unknown"]{--lvl:var(--ink-dim)}
.dot[data-level="ok"]{--lvl:var(--ok)}
.dot[data-level="warn"]{--lvl:var(--warn)}
.dot[data-level="fail"]{--lvl:var(--fail)}
.dot[data-level="info"]{--lvl:var(--info)}
.dot[data-level="unknown"]{--lvl:var(--ink-dim)}
.card-name{font-size:15px; font-weight:600; letter-spacing:-.014em; color:var(--ink)}
.card-level{
  margin-left:auto; font-size:10.5px; font-weight:600; letter-spacing:.1em;
  text-transform:uppercase; color:var(--lvl,var(--info));
}
.card-count{
  margin-left:auto; font-size:11px; color:var(--ink-dim);
  border:1px solid var(--line); border-radius:100px; padding:1px 8px;
}
.card-count + .card-level{margin-left:8px}
.rows{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px}
.rows .row{display:flex; gap:9px; align-items:flex-start; font-size:13px; color:var(--ink-2); line-height:1.5}
.row-dot{
  width:7px; height:7px; border-radius:50%; flex:none; margin-top:6px;
  background:var(--lvl,var(--info));
}
.row[data-level="ok"]{--lvl:var(--ok)}
.row[data-level="warn"]{--lvl:var(--warn)}
.row[data-level="fail"]{--lvl:var(--fail)}
.row[data-level="info"]{--lvl:var(--info)}
.row[data-level="unknown"]{--lvl:var(--ink-dim)}
.row-msg{min-width:0; word-break:break-word}
.row-fix{display:block; margin-top:3px; color:var(--ink-dim); font-size:12px}
.row-fix .arrow{color:var(--accent); margin-right:5px}
.row-fix code{font-family:var(--mono); color:var(--ink-2); font-size:11.5px}

/* ── overview status map ── */
.subhead{
  margin:24px 0 10px; color:var(--ink-dim); font-size:12px; font-weight:600;
  letter-spacing:.07em; text-transform:uppercase;
}
.statusmap{
  display:grid; gap:8px;
  grid-template-columns:repeat(auto-fill,minmax(160px,1fr));
}
.tile{
  display:flex; align-items:center; gap:9px; text-align:left;
  padding:10px 13px; border-radius:var(--r-sm);
  background:var(--panel); border:1px solid var(--line);
  color:var(--ink); font-family:inherit; font-size:12.5px; font-weight:500;
  letter-spacing:-.006em; cursor:pointer;
  transition:background .15s ease, border-color .15s ease;
}
.tile:hover{background:var(--panel-2); border-color:var(--line-2)}
.tile:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.tile .dot{width:8px; height:8px}
.tile .tile-go{margin-left:auto; color:var(--ink-dim); font-weight:400}

/* ── strips (routing / models / learning) ── */
.strip{
  margin-top:22px; padding:18px clamp(14px,3vw,24px);
  background:var(--panel); border:1px solid var(--line);
  border-radius:var(--r); box-shadow:var(--shadow);
}
.strip-head{display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:14px}
.strip-title{font-size:16px; font-weight:600; letter-spacing:-.014em; margin:0}
.strip-note{color:var(--ink-dim); font-size:12px}
.route-matrix{display:flex; flex-direction:column; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:var(--r-sm); overflow:hidden}
.r-row{display:grid; grid-template-columns:minmax(140px,1.4fr) 84px minmax(120px,1.4fr) minmax(90px,1fr); gap:10px; align-items:center; padding:8px 14px; background:var(--panel)}
.r-row:hover{background:var(--panel-2)}
.r-act{color:var(--ink); font-size:12.5px; display:flex; align-items:center; gap:6px}
.r-host{font-size:11px; font-weight:600; text-align:center; padding:2px 0; border-radius:100px; border:1px solid var(--line-2)}
.r-host-claude{color:#ff9f0a; background:rgba(255,159,10,.12); border-color:rgba(255,159,10,.3)}
.r-host-codex{color:var(--accent); background:var(--accent-soft); border-color:color-mix(in srgb,var(--accent) 35%,transparent)}
.r-host[data-primary]{box-shadow:inset 0 0 0 1.5px var(--accent); font-weight:700}
.r-model{color:var(--ink-2); font-size:11.5px}
.r-meta{display:flex; align-items:center; gap:8px; justify-content:flex-end; font-size:10.5px}
.r-esc{color:var(--ink-dim)}
.r-src{text-transform:uppercase; letter-spacing:.04em; color:var(--ink-dim); font-size:9.5px}
.r-src-user{color:var(--accent)}
.r-tag{font-size:8.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--accent); border:1px solid var(--accent-soft); border-radius:3px; padding:0 3px}
@media(max-width:560px){.r-row{grid-template-columns:1fr 70px} .r-model,.r-meta{grid-column:1/-1; justify-content:flex-start}}
.model-list{display:flex; flex-direction:column; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:var(--r-sm); overflow:hidden}
.m-row{display:grid; grid-template-columns:84px 1fr auto; gap:12px; align-items:center; padding:9px 14px; background:var(--panel)}
.m-row:hover{background:var(--panel-2)}
.m-model{color:var(--ink); font-size:12.5px}
.m-n{color:var(--ink-dim); font-size:11.5px}
.spark-row{display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:20px}
.spark{margin:0}
.spark figcaption{color:var(--ink-dim); font-size:11px; letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px}
.spark-svg{width:100%; overflow-x:auto}
.spark-svg svg{display:block; width:100%; height:auto}

/* ── Usage tab (ADR-0009) ───────────────────────────────────────────────────
   Same Apple system motif as the rest of the panel: hairline-separated rows,
   soft-shadowed strips, systemBlue for magnitude and systemPurple as the second
   series. Nothing here fetches; every figure below is rendered from /api/usage. */
.usage-bar{display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:18px}
.subseg{gap:2px}
.subseg .seg-btn[aria-selected="true"]{
  background:var(--thumb); box-shadow:0 1px 4px rgba(0,0,0,.18),0 0 0 .5px rgba(0,0,0,.04);
}
.seg-n{opacity:.6; font-size:11px}
.segbadge{
  min-width:16px; height:16px; padding:0 5px; border-radius:8px; background:var(--warn);
  color:#000; font-size:10.5px; font-weight:700; display:inline-flex;
  align-items:center; justify-content:center;
}
.segbadge[hidden]{display:none}
.filters{display:flex; gap:8px; flex-wrap:wrap; margin-left:auto}
.chipf{
  font-size:12px; padding:4px 11px; border-radius:100px; border:1px solid var(--line);
  background:var(--panel); color:var(--ink-2); cursor:pointer; font-family:inherit;
}
.chipf.on{border-color:var(--accent); color:var(--accent); background:var(--accent-soft)}
.chipf:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.view[hidden]{display:none}

/* hero KPIs */
.hero{display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(168px,1fr)); margin-bottom:14px}
.kpi{background:var(--panel); border:1px solid var(--line); border-radius:var(--r); padding:15px 16px; box-shadow:var(--shadow)}
.kpi .k{font-size:10.5px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-dim)}
.kpi .v{font-size:27px; font-weight:700; letter-spacing:-.028em; margin-top:5px; line-height:1.05}
.kpi .d{font-size:11.5px; color:var(--ink-2); margin-top:5px}
/* A parenthetical qualifier belongs on its own line, not wrapped mid-phrase.
   "297h summed (sessions" / "overlap)" split the caveat across the break and
   made the number harder to read than no caveat at all. */
.kpi .d-note{display:block; color:var(--ink-dim); font-size:11px; margin-top:2px}
.kpi.accent .v{color:var(--accent)}
.kpi.warnv .v{color:var(--warn)}
.note{
  display:flex; gap:9px; padding:10px 14px; margin-bottom:16px; border-radius:var(--r-sm);
  background:var(--accent-soft); color:var(--ink-2); font-size:12.5px; align-items:baseline;
}
.note b{color:var(--ink)}
.note .i{color:var(--accent); font-weight:700}
.sh{display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:14px}
.sh h2{font-size:15px; font-weight:600; letter-spacing:-.014em; margin:0}
.sh .n{color:var(--ink-dim); font-size:11.5px}
.two{display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
#panel-usage .strip{margin-top:0; margin-bottom:16px}

/* day bars */
.days{display:flex; gap:5px; align-items:flex-end; height:118px}
.daybar{flex:1; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; height:100%}
.db-fill{
  width:100%; border-radius:5px 5px 2px 2px;
  background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent) 35%,transparent));
  transition:filter .15s ease;
}
.daybar:hover .db-fill{filter:brightness(1.35)}
.db-lab{font-family:var(--mono); font-size:9.5px; color:var(--ink-dim); margin-top:6px}

/* punchcard */
.pc-row{display:flex; align-items:center; gap:3px; margin-bottom:3px}
.pc-day{font-family:var(--mono); font-size:10px; color:var(--ink-dim); width:28px; flex:none}
.pc{flex:1; height:13px; border-radius:3px; background:color-mix(in srgb,var(--accent) calc(var(--v)*100%),var(--panel-2))}
.pc-axis{display:flex; gap:3px; margin-left:31px; margin-top:5px}
.pc-axis span{flex:1; font-family:var(--mono); font-size:8.5px; color:var(--ink-dim); text-align:center}

/* magnitude rows (models / projects / categories) */
.mrow{
  display:grid; grid-template-columns:minmax(120px,1.5fr) 2fr 62px minmax(96px,auto);
  gap:11px; align-items:center; padding:7px 0; border-bottom:1px solid var(--line);
}
.mrow:last-child{border-bottom:0}
.mname{font-size:12.5px; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.mbar{height:7px; border-radius:4px; background:var(--panel-2); overflow:hidden}
.mbar i{display:block; height:100%; border-radius:4px; background:var(--accent)}
.mbar i.alt{background:var(--purple)}
.mval{font-size:12.5px; text-align:right; color:var(--ink)}
.msub{font-size:10.5px; color:var(--ink-dim); text-align:right}
.crow{
  display:grid; grid-template-columns:minmax(140px,1.4fr) 2fr 62px minmax(128px,auto);
  gap:11px; align-items:center; padding:7px 0; border-bottom:1px solid var(--line);
  cursor:pointer; font-family:inherit; text-align:left; background:transparent; border-left:0; border-right:0; border-top:0; width:100%; color:inherit;
}
.crow:last-child{border-bottom:0}
.crow:hover{background:var(--panel-2)}
.crow:focus-visible{outline:2px solid var(--accent); outline-offset:-2px}
.crow.uncl{opacity:.6}
.c-name{font-size:12.5px; display:flex; align-items:center; gap:7px; color:var(--ink)}
.conf{width:6px; height:6px; border-radius:50%; background:var(--ok); flex:none; display:inline-block}

/* provider split */
.psplit{display:flex; gap:10px; flex-wrap:wrap}
.pcard{flex:1; min-width:190px; border:1px solid var(--line); border-radius:var(--r-sm); padding:13px 15px; background:var(--panel-2)}
.pcard .ph{display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600; margin-bottom:9px}
.pdot{width:9px; height:9px; border-radius:50%}
.pdot.c{background:var(--warn)}
.pdot.x{background:var(--accent)}
.pcard .pv{font-size:21px; font-weight:700; letter-spacing:-.02em}
.pcard .pl{font-size:11.5px; color:var(--ink-dim); margin-top:4px}
.pcard.idle{opacity:.55}
.tokbar{display:flex; height:9px; border-radius:5px; overflow:hidden; margin-top:11px}
.tokbar i{display:block; height:100%}
.legend{display:flex; gap:14px; flex-wrap:wrap; margin-top:9px; font-size:11px; color:var(--ink-dim)}
.legend b{color:var(--ink); font-weight:600}
.lg{display:inline-flex; align-items:center; gap:5px}
.lg i{width:8px; height:8px; border-radius:2px; display:inline-block}

/* findings */
.ins-grid{display:grid; gap:11px; margin-bottom:11px}
/* Findings scrolls in place too, so the window keeps a fixed frame across all
   three list views instead of each one growing the document to a different
   height. Padding-right keeps the scrollbar off the card border. */
#u-insights{
  max-height:var(--listh);
  min-height:200px;
  overflow-y:auto;
  overscroll-behavior:contain;
  padding-right:4px;
  scrollbar-width:thin;
  scrollbar-color:var(--thumb) transparent;
}
#u-insights::-webkit-scrollbar{width:10px}
#u-insights::-webkit-scrollbar-thumb{background:var(--thumb); border-radius:6px; border:3px solid transparent; background-clip:content-box}
#u-insights::-webkit-scrollbar-track{background:transparent}

.icard{
  background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--sv,var(--accent));
  border-radius:var(--r-sm); padding:13px 15px; box-shadow:var(--shadow);
}
.icard[data-sev="warn"]{--sv:var(--warn)}
.icard[data-sev="info"]{--sv:var(--accent)}
.icard[data-sev="ok"]{--sv:var(--ok)}
.i-top{display:flex; align-items:center; gap:9px; margin-bottom:7px; flex-wrap:wrap}
.i-n{
  width:19px; height:19px; border-radius:50%; background:var(--sv); color:#000;
  font-size:11px; font-weight:700; display:inline-flex; align-items:center; justify-content:center; flex:none;
}
.i-title{font-size:14px; font-weight:600; letter-spacing:-.012em; color:var(--ink)}
.i-kind{font-size:9.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--ink-dim); border:1px solid var(--line); border-radius:100px; padding:1px 7px}
.i-imp{margin-left:auto; font-size:12.5px; font-weight:600; color:var(--sv); white-space:nowrap}
.i-imp.soft{color:var(--ink-dim); font-weight:400; font-size:11px}
.i-find{margin:0 0 5px; font-size:12.5px; color:var(--ink-2); line-height:1.52}
.i-ev{margin:0 0 9px; font-size:11.5px; color:var(--ink-dim); line-height:1.5}
.i-act{display:flex; gap:8px; font-size:12.5px; color:var(--ink); align-items:baseline; border-top:1px solid var(--line); padding-top:9px}
.i-arrow{color:var(--sv); font-weight:700}
.i-cmd{font-family:var(--mono); font-size:11.5px; color:var(--accent); background:var(--accent-soft); border-radius:5px; padding:1px 6px; white-space:nowrap}
.i-src{margin-top:9px; border-top:1px solid var(--line); padding-top:8px}
.i-src summary{font-size:11.5px; color:var(--ink-dim); cursor:pointer; list-style:none}
.i-src summary::-webkit-details-marker{display:none}
.i-src summary::before{content:"\\25B8 "; color:var(--accent)}
.i-src[open] summary::before{content:"\\25BE "}
.i-src ul{margin:8px 0 0; padding-left:16px}
.i-src li{font-size:11.5px; color:var(--ink-2); margin-bottom:4px}
.i-src a{color:var(--accent); text-decoration:none}
.i-src a:hover{text-decoration:underline}

/* tiered project tree */
.ptree{display:flex; flex-direction:column; gap:8px}
.pgroup{border:1px solid var(--line); border-radius:var(--r-sm); overflow:hidden; background:var(--panel)}
.phead{
  display:grid; grid-template-columns:16px minmax(120px,1.1fr) minmax(150px,1.6fr) 64px 44px 58px 66px;
  gap:10px; align-items:center; width:100%; padding:11px 13px; background:var(--panel-2);
  border:0; color:var(--ink); font-family:inherit; font-size:13px; cursor:pointer; text-align:left;
}
.phead:hover{background:var(--raised)}
.phead:focus-visible{outline:2px solid var(--accent); outline-offset:-2px}
.chev{color:var(--ink-dim); transition:transform .18s ease; display:inline-block}
.pgroup[data-open] .chev{transform:rotate(90deg); color:var(--accent)}
.pname{font-weight:600; letter-spacing:-.01em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.pchips{display:flex; gap:5px; flex-wrap:wrap; overflow:hidden}
.pchip{font-size:10px; color:var(--ink-dim); border:1px solid var(--line); border-radius:100px; padding:1px 7px; white-space:nowrap}
.pchip b{color:var(--ink-2); font-weight:600}
.pn{font-size:11.5px; color:var(--ink-dim); text-align:right}
.pcost{font-size:13px; font-weight:600; text-align:right; color:var(--ink)}
.pbody{display:none; background:var(--line); gap:1px; flex-direction:column}
/* Each expanded project scrolls INSIDE its own group. A project with 108
   sessions otherwise pushes every project below it off-screen and forces the
   whole window to scroll, so you lose the group headers you were comparing. */
.pgroup[data-open] .pbody{
  display:flex;
  max-height:var(--listh);
  overflow-y:auto;
  overscroll-behavior:contain;   /* reaching the end must not scroll the page */
  scrollbar-width:thin;
  scrollbar-color:var(--thumb) transparent;
}
.smore{background:var(--panel); padding:9px 13px; font-size:11.5px; color:var(--ink-dim)}
.smore button{background:transparent; border:0; color:var(--accent); cursor:pointer; font-family:inherit; font-size:11.5px; padding:0}
.cat{
  font-size:10px; border-radius:100px; padding:1px 8px; white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; border:1px solid color-mix(in srgb,var(--ok) 30%,transparent);
  color:var(--ok); background:color-mix(in srgb,var(--ok) 11%,transparent);
}
.cat[data-w="0"]{
  border-color:color-mix(in srgb,var(--warn) 30%,transparent);
  color:var(--warn); background:color-mix(in srgb,var(--warn) 10%,transparent);
}
.cat.uncl{border-color:var(--line); color:var(--ink-dim); background:transparent}

/* session rows */
/* The LEADING 18px column is the detail expander. It is deliberately first, so
   the caret sits outside the row's content and reads as an affordance on the
   row rather than on any one cell. Both grids below must carry it — a column
   added here and forgotten in the breakpoint shifts every mobile cell by one,
   which is silent: the row still renders, it just renders the wrong data under
   each heading. */
.srow{
  display:grid; grid-template-columns:18px 58px minmax(150px,2.1fr) minmax(90px,1fr) 106px 46px 60px 62px 68px 20px;
  gap:10px; align-items:center; padding:9px 13px; background:var(--panel); font-size:12.5px; cursor:pointer;
}
.srow:hover{background:var(--panel-2)}
.s-host{font-size:10px; font-weight:600; text-align:center; padding:2px 0; border-radius:100px; border:1px solid var(--line-2)}
.s-claude{color:var(--warn); background:color-mix(in srgb,var(--warn) 12%,transparent); border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.s-codex{color:var(--accent); background:var(--accent-soft); border-color:color-mix(in srgb,var(--accent) 35%,transparent)}
.s-title{overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.s-proj,.s-when,.s-dur,.s-turns,.s-tok{color:var(--ink-2); font-size:11.5px}
.s-cost{text-align:right; color:var(--ink); font-size:12px}
.s-tx{background:transparent; border:0; color:var(--ink-dim); font-size:14px; cursor:pointer; padding:0; border-radius:5px}
.s-tx:hover{color:var(--accent); background:var(--accent-soft)}

/* row expander — a real <button>, so it is tab-reachable and announced. The
   chevron rotation reuses the .phead .chev idiom rather than inventing a
   second vocabulary for "this opens". */
.s-exp{
  background:transparent; border:0; color:var(--ink-dim); font-size:13px; line-height:1; cursor:pointer;
  padding:0; border-radius:4px; transition:transform .18s ease, color .18s ease; display:inline-block;
}
.s-exp:hover{color:var(--accent)}
.s-exp:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.s-exp[aria-expanded="true"]{transform:rotate(90deg); color:var(--accent)}
/* ADR-0009 §4b — the repo answers "which project", this answers "which branch
   of it". Rendered only when there IS one, so its presence is the signal. */
.s-wt{
  margin-left:7px; font-size:9.5px; font-family:var(--mono); color:var(--purple); white-space:nowrap;
  border:1px solid color-mix(in srgb,var(--purple) 30%,transparent);
  background:color-mix(in srgb,var(--purple) 10%,transparent); border-radius:100px; padding:1px 6px;
}
/* The detail strip is a SIBLING of .srow inside .pbody, not a grid child of
   it — so it spans the full width instead of joining the column layout. No
   display is set here: the UA's [hidden] rule must keep working. */
.sdetail{background:var(--panel-2); padding:9px 13px 11px 41px; border-top:1px solid var(--line); font-size:11.5px}
.sdetail[hidden]{display:none}
/* Label and value are INLINE-level, not grid or flex tracks, and that is a
   readability decision rather than a layout one. This markup is divs and
   spans, not a real <dl> — so block-level cells would hand a screen reader two
   unrelated blocks with nothing pairing them, and split the label from its
   value for copy-paste and for anything else reading the rendered text. The
   classifier's reasoning is one statement and should survive as one. The
   fixed-width inline-block keeps the column alignment a grid would have given,
   so nothing is lost visually. */
.sd-line{padding:2px 0}
.sd-k{
  display:inline-block; width:74px; vertical-align:top; color:var(--ink-dim);
  font-size:10px; text-transform:uppercase; letter-spacing:.06em;
}
.sd-v{display:inline-block; vertical-align:top; max-width:calc(100% - 84px); color:var(--ink-2); word-break:break-word}
.sd-conf{color:var(--ink-dim)}

/* transcript reader */
/* The crumb stays put while the turns scroll beneath it — on a 2,216-turn
   session the header is exactly what you lose first when the page scrolls. */
.tcrumb{display:flex; align-items:center; gap:9px; font-size:12.5px; color:var(--ink-2); margin-bottom:14px; flex-wrap:wrap}
#u-turns{
  max-height:var(--listh);
  min-height:200px;
  overflow-y:auto;
  overscroll-behavior:contain;
  scrollbar-width:thin;
  scrollbar-color:var(--thumb) transparent;
}
/* WebKit needs its own scrollbar rules; keep them quiet and on-motif. */
#u-turns::-webkit-scrollbar,.pgroup[data-open] .pbody::-webkit-scrollbar{width:10px}
#u-turns::-webkit-scrollbar-thumb,.pgroup[data-open] .pbody::-webkit-scrollbar-thumb{
  background:var(--thumb); border-radius:6px; border:3px solid transparent; background-clip:content-box;
}
#u-turns::-webkit-scrollbar-track,.pgroup[data-open] .pbody::-webkit-scrollbar-track{background:transparent}
@media (max-width:700px){ :root{--listh:clamp(180px, calc(100vh - 340px), 460px)} }
.tcrumb button{
  background:var(--panel); border:1px solid var(--line); color:var(--ink-2); border-radius:100px;
  padding:4px 12px; font-family:inherit; font-size:12px; cursor:pointer;
}
.tcrumb button:hover{border-color:var(--line-2); color:var(--ink)}
.turn{display:grid; grid-template-columns:78px 1fr; gap:14px; padding:13px 0; border-bottom:1px solid var(--line)}
.turn:last-child{border-bottom:0}
.t-who{font-family:var(--mono); font-size:10.5px; color:var(--ink-dim); text-transform:uppercase; letter-spacing:.06em}
.t-user .t-who{color:var(--accent)}
/* Tool results and harness context ride the user ROLE in the Messages API but
   are not the person — purple ties them visually to the tool chips, and the
   accent stays reserved for turns the human actually typed. */
.t-tool .t-who{color:var(--purple)}
/* Harness sentinel markup, restyled (fmtHarness): a slash command renders as
   a chip, and system-reminder / caveat / stdout blocks get a labelled quiet
   panel — the wrapped content stays verbatim, only the XML wrappers go. */
.h-cmd{
  font-family:var(--mono); font-size:12px; color:var(--accent);
  border:1px solid color-mix(in srgb,var(--accent) 32%,transparent);
  background:color-mix(in srgb,var(--accent) 10%,transparent); border-radius:5px; padding:1px 7px;
}
.h-note{display:block; border-left:2px solid var(--line-2); padding:5px 10px; margin:5px 0; color:var(--ink-dim)}
.h-tag{
  display:block; font-style:normal; font-family:var(--mono); font-size:9.5px;
  text-transform:uppercase; letter-spacing:.06em; color:var(--ink-dim); opacity:.8; margin-bottom:2px;
}
.t-meta{display:block; font-size:9.5px; margin-top:3px; text-transform:none; letter-spacing:0}
.t-body{font-size:13px; color:var(--ink-2); white-space:pre-wrap; word-break:break-word; min-width:0}
.t-user .t-body{color:var(--ink)}
.chips{margin-top:8px; display:flex; gap:6px; flex-wrap:wrap}
.tool{
  font-family:var(--mono); font-size:10px; color:var(--purple);
  border:1px solid color-mix(in srgb,var(--purple) 32%,transparent);
  background:color-mix(in srgb,var(--purple) 11%,transparent); border-radius:5px; padding:2px 7px;
}
/* click-to-reveal, never a download: the bytes are already the user's, the risk
   is amplifying them into a screenshare (ADR-0009 §8). */
.masked{background:var(--fail); color:transparent; border-radius:3px; cursor:pointer; opacity:.75; padding:0 3px}
.masked:hover,.masked.shown{color:#fff; opacity:1}
.masked.shown{background:transparent; box-shadow:inset 0 0 0 1px var(--fail); color:var(--ink)}
/* Same "content was withheld" family as .masked, deliberately quieter: masking
   is a security measure, truncation is a designed limit. An alarm colour here
   would teach the reader to distrust a turn that is merely long. */
.t-trunc{
  display:block; margin-top:3px; font-size:9px; line-height:1.35; text-transform:none; letter-spacing:0;
  color:var(--ink-dim); border:1px solid var(--line-2); border-radius:4px; padding:1px 4px;
  background:var(--panel-2); cursor:help;
}

@media(max-width:720px){
  /* Four data columns → five, because .srow above gained a LEADING one.
     .cat joins the hidden set at the same time, and that is a FIX, not a
     side-effect: the shipped rule declared four columns while the row still
     rendered five visible cells, so .cat sat in the cost column, $-figures sat
     in the 20px glyph column and were clipped, and the transcript glyph wrapped
     onto a line of its own. Five columns for five cells is what makes the
     arithmetic close. The category is still reachable — it is on the project
     header chips and on the Scorecard's category rows. */
  .srow{grid-template-columns:18px 58px 1fr 68px 20px}
  .srow .s-proj,.srow .s-when,.srow .s-dur,.srow .s-turns,.srow .s-tok,.srow .cat{display:none}
  .phead{grid-template-columns:16px 1fr 58px 66px}
  .phead .pchips,.phead .p-h,.phead .p-tok{display:none}
}

/* ── footer ── */
.foot{margin-top:24px; padding-top:16px; border-top:1px solid var(--line); color:var(--ink-dim); font-size:12px}

.empty{color:var(--ink-dim); font-size:13px; padding:26px 4px}

@media (max-width:560px){
  .band{gap:12px}
  .band-verdict{margin-left:0; order:3; width:100%; justify-content:center}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none !important; transition:none !important}
  .card{opacity:1; transform:none}
}
`;

// ── Client script ────────────────────────────────────────────────────────────
// No backticks and no ${ } anywhere below — this whole string is embedded inside
// a server-side template literal, so those tokens would be misparsed. Plain
// string concatenation only.
const JS = `
(function(){
  "use strict";
  var root=document.documentElement;
  var LS="ak-dash-theme", LS_TAB="ak-dash-tab";

  // theme: stored choice wins; otherwise follow the OS.
  function sysTheme(){return window.matchMedia&&window.matchMedia("(prefers-color-scheme:light)").matches?"light":"dark";}
  var MOON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8z"/></svg>';
  var SUN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  function applyTheme(t){
    root.setAttribute("data-theme",t);
    var ic=document.getElementById("theme-icon"); if(ic)ic.innerHTML=(t==="dark"?MOON:SUN);
    var btn=document.getElementById("theme-toggle"); if(btn)btn.setAttribute("aria-label",t==="dark"?"switch to light theme":"switch to dark theme");
  }
  var stored=null; try{stored=localStorage.getItem(LS);}catch(e){}
  applyTheme(stored||sysTheme());
  var tbtn=document.getElementById("theme-toggle");
  if(tbtn)tbtn.addEventListener("click",function(){
    var next=root.getAttribute("data-theme")==="dark"?"light":"dark";
    applyTheme(next); try{localStorage.setItem(LS,next);}catch(e){}
    render(LAST); // re-tint the sparklines to the new palette
  });

  var LEVEL_WORD={ok:"all systems nominal",warn:"attention advised",fail:"action required",unknown:"status unknown"};
  var LAST=null, lastUpdated=0;

  function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}

  // ── tabs (segmented control) ──
  // Category map: every subsystem lands in exactly one tab; unknown/future
  // subsystems fall back to Runtime so nothing is ever dropped. Overview
  // aggregates all attention cards regardless of category.
  var TABS=["overview","hosts","providers","runtime","intel","usage"];
  var VIEWS=["score","limits","findings","sessions","transcript"];
  var CAT={
    hosts:"hosts", mcp:"hosts", "codex-mcp":"hosts", routing:"hosts",
    providers:"providers",
    learning:"intel", "ruvnet-brain":"intel", "ruvnet-brain-nightly":"intel", aqe:"intel", agentdb:"intel"
  };
  function catOf(s){return CAT[s]||"runtime";}

  var activeTab="overview";
  var usageView="score", usageSession=null, usageDays=14;
  try{var st=localStorage.getItem(LS_TAB); if(st&&TABS.indexOf(st)>=0)activeTab=st;}catch(e){}
  // deep-link: #providers etc. wins over the stored tab. Usage carries a second
  // segment: #usage/findings, #usage/sessions, or #usage/<sessionId> — anything
  // that is not a known view name is read as a session id.
  try{
    var parts=location.hash.slice(1).split("/");
    if(parts[0]&&TABS.indexOf(parts[0])>=0)activeTab=parts[0];
    if(parts[0]==="usage"&&parts[1]){
      if(VIEWS.indexOf(parts[1])>=0){usageView=parts[1];}
      else{usageView="transcript"; usageSession=decodeURIComponent(parts[1]);}
    }
  }catch(e){}

  function usageHash(){
    if(usageView==="transcript")return "#usage/"+(usageSession?encodeURIComponent(usageSession):"transcript");
    return usageView==="score"?"#usage":"#usage/"+usageView;
  }
  function syncHash(){
    try{if(history.replaceState)history.replaceState(null,"",activeTab==="usage"?usageHash():"#"+activeTab);}catch(e){}
  }

  function positionThumb(){
    var segEl=document.getElementById("seg"), thumb=document.getElementById("seg-thumb");
    if(!segEl||!thumb)return;
    var btn=segEl.querySelector('[data-tab="'+activeTab+'"]');
    if(!btn)return;
    thumb.style.left=btn.offsetLeft+"px";
    thumb.style.width=btn.offsetWidth+"px";
  }
  function setTab(id,focus){
    activeTab=id;
    try{localStorage.setItem(LS_TAB,id);}catch(e){}
    syncHash();
    // Usage is LAZY (ADR-0009 §2): the index is only read once the tab is
    // actually opened, never on the shared status poll.
    if(id==="usage"&&!usageLoaded)loadUsage();
    for(var i=0;i<TABS.length;i++){
      var t=TABS[i], on=(t===id);
      var btn=document.querySelector('[data-tab="'+t+'"]');
      var panel=document.getElementById("panel-"+t);
      if(btn){btn.setAttribute("aria-selected",on?"true":"false"); btn.tabIndex=on?0:-1; if(on&&focus)btn.focus();}
      if(panel)panel.hidden=!on;
    }
    positionThumb();
  }
  var seg=document.getElementById("seg");
  if(seg){
    seg.addEventListener("click",function(e){
      var b=e.target.closest?e.target.closest("[data-tab]"):null;
      if(b)setTab(b.getAttribute("data-tab"));
    });
    seg.addEventListener("keydown",function(e){
      if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;
      var i=TABS.indexOf(activeTab);
      i=(i+(e.key==="ArrowRight"?1:TABS.length-1))%TABS.length;
      setTab(TABS[i],true); e.preventDefault();
    });
  }
  window.addEventListener("resize",positionThumb);
  var mapEl=document.getElementById("statusmap");
  if(mapEl)mapEl.addEventListener("click",function(e){
    var t=e.target.closest?e.target.closest("[data-go]"):null;
    if(t)setTab(t.getAttribute("data-go"));
  });

  // severity rank for rollups + triage sort; preferred order breaks ties.
  var RANK={fail:3,warn:2,ok:1,info:0,unknown:0};
  var PREF=["versions","self","natives","security","learning","providers","hosts","routing","mcp","codex-mcp","ruvnet-brain","ruvnet-brain-nightly","aqe","daemons","blocks","statusline","npx"];

  // Collapse rows into one group per subsystem (kills repeated labels); the
  // group's level is the worst of its rows. Sort worst-first, then by PREF.
  function groupRows(rows){
    var map={}, seq=[];
    for(var i=0;i<rows.length;i++){
      var r=rows[i], k=r.subsystem||"other";
      if(!map[k]){map[k]={subsystem:k,rows:[],level:"info"};seq.push(k);}
      map[k].rows.push(r);
      if((RANK[r.level]||0)>(RANK[map[k].level]||0))map[k].level=r.level;
    }
    var groups=seq.map(function(k){return map[k];});
    groups.sort(function(a,b){
      var d=(RANK[b.level]||0)-(RANK[a.level]||0); if(d)return d;
      var ia=PREF.indexOf(a.subsystem), ib=PREF.indexOf(b.subsystem);
      return (ia<0?99:ia)-(ib<0?99:ib);
    });
    return groups;
  }

  function rowLine(r){
    var lvl=r.level||"info";
    var fix=r.fix?('<span class="row-fix"><span class="arrow">&rarr;</span><code>'+esc(r.fix)+"</code></span>"):"";
    return '<li class="row" data-level="'+esc(lvl)+'">'
      +'<span class="row-dot"></span>'
      +'<span class="row-msg">'+esc(r.message)+fix+"</span>"
    +"</li>";
  }

  function groupCard(g){
    var lvl=g.level||"info", calm=(lvl==="ok"||lvl==="info");
    var count=g.rows.length>1?('<span class="card-count">'+g.rows.length+"</span>"):"";
    var badge=calm?"":('<span class="card-level">'+esc(lvl)+"</span>");
    return '<article class="card" data-level="'+esc(lvl)+'">'
      +'<div class="card-top">'
        +'<span class="dot" data-level="'+esc(lvl)+'"></span>'
        +'<span class="card-name">'+esc(g.subsystem)+"</span>"
        +count+badge
      +"</div>"
      +'<ul class="rows">'+g.rows.map(rowLine).join("")+"</ul>"
    +"</article>";
  }

  function gridHtml(groups){
    return '<div class="grid">'+groups.map(groupCard).join("")+"</div>";
  }
  function stagger(el){
    var cards=el.querySelectorAll(".card");
    for(var i=0;i<cards.length;i++){cards[i].style.animationDelay=(i*40)+"ms";}
  }

  function renderSummary(groups){
    var el=document.getElementById("summary");
    var f=0,w=0,g=0;
    for(var i=0;i<groups.length;i++){var L=groups[i].level;if(L==="fail")f++;else if(L==="warn")w++;else g++;}
    if(!groups.length){el.hidden=true;el.innerHTML="";return;}
    var pills=[];
    if(f)pills.push('<span class="pill" data-level="fail"><span class="dot" data-level="fail"></span><b>'+f+"</b> failing</span>");
    if(w)pills.push('<span class="pill" data-level="warn"><span class="dot" data-level="warn"></span><b>'+w+"</b> warning"+(w>1?"s":"")+"</span>");
    pills.push('<span class="pill" data-tone="calm"><span class="dot" data-level="ok"></span><b>'+g+"</b> nominal</span>");
    el.innerHTML=pills.join("");
    el.hidden=false;
  }

  function renderBadges(cats){
    for(var c in cats){
      var el=document.getElementById("badge-"+c);
      if(!el)continue;
      var f=0,w=0;
      for(var i=0;i<cats[c].length;i++){
        var L=cats[c][i].level;
        if(L==="fail")f++; else if(L==="warn")w++;
      }
      var n=f+w;
      if(!n){el.hidden=true;el.textContent="";el.removeAttribute("data-tone");}
      else{el.hidden=false;el.textContent=String(n);el.setAttribute("data-tone",f?"fail":"warn");}
    }
  }

  function tile(g){
    return '<button class="tile" type="button" data-go="'+esc(catOf(g.subsystem))+'" title="open in its tab">'
      +'<span class="dot" data-level="'+esc(g.level)+'"></span>'
      +esc(g.subsystem)
      +'<span class="tile-go">&rsaquo;</span>'
    +"</button>";
  }

  function renderPanels(rows){
    var groups=groupRows(rows||[]);
    renderSummary(groups);

    // Overview: every attention card, in full, regardless of category.
    var attn=groups.filter(function(x){return x.level==="fail"||x.level==="warn";});
    var ael=document.getElementById("attention");
    if(!groups.length){
      ael.innerHTML='<div class="empty">no subsystem rows reported.</div>';
    }else if(attn.length){
      ael.innerHTML=gridHtml(attn); stagger(ael);
    }else{
      ael.innerHTML='<div class="allclear"><span class="dot" data-level="ok"></span>All systems nominal — nothing needs attention.</div>';
    }

    // Overview: compact status map of every subsystem; tiles jump to the tab.
    var mh=document.getElementById("map-head");
    document.getElementById("statusmap").innerHTML=groups.map(tile).join("");
    mh.hidden=!groups.length;

    // Category panels.
    var cats={hosts:[],providers:[],runtime:[],intel:[]};
    for(var i=0;i<groups.length;i++)cats[catOf(groups[i].subsystem)].push(groups[i]);
    for(var c in cats){
      var el=document.getElementById("cards-"+c);
      if(!el)continue;
      if(cats[c].length){el.innerHTML=gridHtml(cats[c]); stagger(el);}
      else{el.innerHTML='<div class="empty">nothing reported here.</div>';}
    }
    renderBadges(cats);
  }

  function renderVerdict(overall){
    var dot=document.getElementById("verdict-dot");
    var txt=document.getElementById("verdict-text");
    dot.setAttribute("data-level",overall||"unknown");
    dot.className="dot";
    txt.textContent=LEVEL_WORD[overall]||LEVEL_WORD.unknown;
  }

  // Update drift renders as a quiet notice line in Overview — no banner. The
  // versions cards still carry the per-tool detail.
  function renderNotice(drift){
    var b=document.getElementById("update-notice");
    var out=(drift||[]).filter(function(d){return d&&d.outdated;});
    if(!out.length){b.hidden=true;b.innerHTML="";return;}
    var parts=out.map(function(d){return "<b>"+esc(d.pkg)+"</b> "+esc(d.installed)+" &rarr; "+esc(d.latest);});
    b.innerHTML='<span class="up">&uarr;</span><span>'+out.length+" update"+(out.length>1?"s":"")
      +" available: "+parts.join(" &nbsp;·&nbsp; ")+" &mdash; run <code>ak sync</code></span>";
    b.hidden=false;
  }

  // ── sparkline (pure SVG) ──
  function accent(){return getComputedStyle(root).getPropertyValue("--accent").trim()||"#0a84ff";}
  function sparkline(values){
    var W=100,H=32,pad=3;
    if(!values.length)return "";
    var min=Math.min.apply(null,values),max=Math.max.apply(null,values);
    var span=max-min||1;
    var n=values.length;
    var x=function(i){return pad+(n===1?0:(i/(n-1))*(W-2*pad));};
    var y=function(v){return H-pad-((v-min)/span)*(H-2*pad);};
    var d="",area="";
    for(var i=0;i<n;i++){d+=(i?" L":"M")+x(i).toFixed(1)+" "+y(values[i]).toFixed(1);}
    area="M"+x(0).toFixed(1)+" "+(H-pad)+" L"+x(0).toFixed(1)+" "+y(values[0]).toFixed(1)
        +d.replace(/^M[^L]*/,"")+" L"+x(n-1).toFixed(1)+" "+(H-pad)+" Z";
    var col=accent(),lastX=x(n-1).toFixed(1),lastY=y(values[n-1]).toFixed(1);
    var gid="g"+Math.random().toString(36).slice(2,8);
    return '<svg viewBox="0 0 '+W+" "+H+'" preserveAspectRatio="none" role="img">'
      +'<defs><linearGradient id="'+gid+'" x1="0" x2="0" y1="0" y2="1">'
        +'<stop offset="0" stop-color="'+col+'" stop-opacity="0.28"/>'
        +'<stop offset="1" stop-color="'+col+'" stop-opacity="0"/>'
      +"</linearGradient></defs>"
      +'<path d="'+area+'" fill="url(#'+gid+')"/>'
      +'<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
      +'<circle cx="'+lastX+'" cy="'+lastY+'" r="1.9" fill="'+col+'"/>'
    +"</svg>";
  }
  function flat(msg){return '<div class="empty" style="padding:14px 0">'+esc(msg)+"</div>";}

  function renderHistory(data){
    var strip=document.getElementById("history");
    var note=document.getElementById("strip-note");
    var series=[];
    if(data.health&&data.health.length){series=data.health;}
    var pats=[],deltas=[];
    for(var i=0;i<series.length;i++){
      var s=series[i];
      if(typeof s.patternsLearned==="number")pats.push(s.patternsLearned);
      var dp=(typeof s.deltaPP==="number")?s.deltaPP:(s.improvement&&typeof s.improvement.deltaPP==="number"?s.improvement.deltaPP:null);
      if(dp!=null)deltas.push(dp);
    }
    // fall back to a single improvement snapshot for the Δpp spark
    if(!deltas.length&&data.improvement&&typeof data.improvement.deltaPP==="number"){deltas=[data.improvement.deltaPP];}

    if(!pats.length&&!deltas.length){strip.hidden=true;return;}
    strip.hidden=false;
    note.textContent=(series.length?series.length+" samples":"snapshot");
    document.getElementById("spark-patterns").innerHTML=pats.length>1?sparkline(pats):flat(pats.length?String(pats[0])+" (one sample)":"no data");
    document.getElementById("spark-delta").innerHTML=deltas.length>1?sparkline(deltas):flat(deltas.length?(deltas[0]>=0?"+":"")+deltas[0]+"pp (one sample)":"no data");
  }

  function renderRouting(rt){
    var strip=document.getElementById("routing");
    if(!rt||!rt.routes||!rt.routes.length){strip.hidden=true;return;}
    strip.hidden=false;
    var s=rt.summary||{}, byHost=s.byHost||{}, primary=rt.primaryHost||"claude";
    document.getElementById("routing-note").textContent=
      "primary: "+primary+" · "+(byHost.claude||0)+" claude · "+(byHost.codex||0)+" codex · "+(s.custom||0)+" custom · "+(s.vendors||0)+" vendors";
    var html="";
    for(var i=0;i<rt.routes.length;i++){
      var r=rt.routes[i];
      var tag=r.akOriginated?' <span class="r-tag">ak</span>':'';
      var escHtml=(r.escalate&&r.escalate.length)?'<span class="r-esc mono">↑ '+esc(r.escalate.join("→"))+"</span>":"";
      var primAttr=(r.host===primary)?' data-primary="1"':'';
      html+='<div class="r-row">'
        +'<span class="r-act mono">'+esc(r.activity)+tag+"</span>"
        +'<span class="r-host r-host-'+esc(r.host)+'"'+primAttr+' title="'+(r.host===primary?"primary host":"alternate host")+'">'+esc(r.host)+"</span>"
        +'<span class="r-model mono">'+esc(r.model)+"</span>"
        +'<span class="r-meta">'+escHtml+'<span class="r-src r-src-'+esc(r.source)+'">'+esc(r.source)+"</span></span>"
      +"</div>";
    }
    document.getElementById("route-matrix").innerHTML=html;
  }

  // Providers tab: the distinct host+model pairs the routing policy puts in
  // play, with how many activities each covers. Hidden without a dual policy.
  function renderModels(rt){
    var strip=document.getElementById("models");
    if(!rt||!rt.routes||!rt.routes.length){strip.hidden=true;return;}
    var seen={},list=[];
    for(var i=0;i<rt.routes.length;i++){
      var r=rt.routes[i];
      if(!r.model)continue;
      var k=r.host+"|"+r.model;
      if(!seen[k]){seen[k]={host:r.host,model:r.model,n:0};list.push(seen[k]);}
      seen[k].n++;
    }
    if(!list.length){strip.hidden=true;return;}
    strip.hidden=false;
    document.getElementById("models-note").textContent="primary: "+(rt.primaryHost||"claude");
    var html="";
    for(var j=0;j<list.length;j++){
      var m=list[j];
      html+='<div class="m-row">'
        +'<span class="r-host r-host-'+esc(m.host)+'">'+esc(m.host)+"</span>"
        +'<span class="m-model mono">'+esc(m.model)+"</span>"
        +'<span class="m-n">'+m.n+" activit"+(m.n>1?"ies":"y")+"</span>"
      +"</div>";
    }
    document.getElementById("model-list").innerHTML=html;
  }

  function render(data){
    if(!data)return;
    LAST=data;
    renderVerdict(data.overall);
    renderNotice(data.drift);
    renderPanels(data.rows);
    renderHistory(data);
    renderRouting(data.routing);
    renderModels(data.routing);
    positionThumb(); // badges can change segment widths
  }

  function ago(sec){
    if(sec<2)return "just now";
    if(sec<60)return sec+"s ago";
    var m=Math.floor(sec/60); if(m<60)return m+"m ago";
    var h=Math.floor(m/60); return h+"h ago";
  }
  function tickClock(){
    var el=document.getElementById("updated");
    if(el){
      if(!lastUpdated){el.textContent="—";}
      else{el.textContent=(pollOn?"updated ":"paused · ")+ago(Math.round((Date.now()-lastUpdated)/1000));}
    }
    // Manual refresh is live except while a fetch is in the air or inside the
    // cooldown — the button's own disabled state IS the visible cooldown.
    var btn=document.getElementById("poll-now");
    if(btn)btn.disabled=inflight||(Date.now()-lastAttempt)<POLL_COOLDOWN_MS;
  }

  // ══ poll control ═══════════════════════════════════════════════════════════
  // Governs EVERY tab, not just Usage (ADR-0009 §7). The old hardcoded 5 s poll
  // predated any expensive view; 30 s is the default now, and the whole range is
  // user-chosen and persisted. Every refresh path — automatic or manual — funnels
  // through refreshAll(), so the single-flight guard and the cooldown are
  // impossible to route around.
  var LS_POLL="ak-dash-poll";
  var POLL_DEFAULT_MS=30000;
  var POLL_COOLDOWN_MS=3000;
  var POLL_LABEL={15000:"15s",30000:"30s",60000:"1m",300000:"5m",900000:"15m",
    1800000:"30m",3600000:"1h",21600000:"6h",43200000:"12h",86400000:"24h"};
  var pollOn=true, pollMs=POLL_DEFAULT_MS, pollTimer=null, inflight=false, lastAttempt=0;

  try{
    var savedPoll=JSON.parse(localStorage.getItem(LS_POLL)||"null");
    if(savedPoll&&typeof savedPoll==="object"){
      if(typeof savedPoll.on==="boolean")pollOn=savedPoll.on;
      if(POLL_LABEL[savedPoll.intervalMs])pollMs=savedPoll.intervalMs;
    }
  }catch(e){}

  function savePoll(){
    try{localStorage.setItem(LS_POLL,JSON.stringify({on:pollOn,intervalMs:pollMs}));}catch(e){}
  }

  function pollStatus(){
    return fetch("/api/status",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
      lastUpdated=Date.now(); render(d); tickClock();
    }).catch(function(){
      var t=document.getElementById("verdict-text"); if(t)t.textContent="server unreachable";
    });
  }

  function refreshAll(){
    // single-flight: a refresh already in the air is joined, never duplicated.
    if(inflight)return;
    // cooldown: a double-click (or a held Enter) cannot stack requests.
    if(Date.now()-lastAttempt<POLL_COOLDOWN_MS)return;
    inflight=true; lastAttempt=Date.now();
    var btn=document.getElementById("poll-now");
    if(btn)btn.classList.add("spin");
    var jobs=[pollStatus()];
    if(activeTab==="usage")jobs.push(loadUsage(true));
    Promise.all(jobs).catch(function(){}).then(function(){
      inflight=false;
      if(btn)btn.classList.remove("spin");
      tickClock();
    });
  }

  function schedulePoll(){
    if(pollTimer){clearInterval(pollTimer); pollTimer=null;}
    if(pollOn)pollTimer=setInterval(refreshAll,pollMs);
    var pulse=document.getElementById("pulse");
    if(pulse)pulse.classList.toggle("off",!pollOn);
    var play=document.getElementById("poll-play");
    if(play){
      play.classList.toggle("on",pollOn);
      play.innerHTML=pollOn?"&#9208;":"&#9654;";
      play.title=pollOn?"polling on — click to pause":"polling paused — click to resume";
      play.setAttribute("aria-label",pollOn?"pause polling":"resume polling");
    }
    var ivl=document.getElementById("poll-ivl");
    if(ivl){
      ivl.innerHTML=POLL_LABEL[pollMs]+' <span class="caret" aria-hidden="true">&#9662;</span>';
      ivl.style.opacity=pollOn?1:.55;
    }
    var menu=document.getElementById("poll-menu");
    if(menu){
      var opts=menu.querySelectorAll("[data-ms]");
      for(var i=0;i<opts.length;i++){
        var on=(Number(opts[i].getAttribute("data-ms"))===pollMs);
        opts[i].classList.toggle("sel",on);
        opts[i].innerHTML=POLL_LABEL[opts[i].getAttribute("data-ms")]+(on?" <span>&#10003;</span>":"");
      }
    }
    tickClock();
  }

  function wirePoll(){
    var play=document.getElementById("poll-play");
    var ivl=document.getElementById("poll-ivl");
    var now=document.getElementById("poll-now");
    var menu=document.getElementById("poll-menu");
    if(play)play.addEventListener("click",function(){pollOn=!pollOn; savePoll(); schedulePoll();});
    // Manual refresh survives the pause — that is the whole point of the off
    // state: stale on purpose, refreshable on demand.
    if(now)now.addEventListener("click",refreshAll);
    if(ivl&&menu)ivl.addEventListener("click",function(e){
      e.stopPropagation();
      menu.hidden=!menu.hidden;
      ivl.setAttribute("aria-expanded",menu.hidden?"false":"true");
    });
    document.addEventListener("click",function(){
      if(menu&&!menu.hidden){menu.hidden=true; if(ivl)ivl.setAttribute("aria-expanded","false");}
    });
    if(menu)menu.addEventListener("click",function(e){
      var b=e.target.closest?e.target.closest("[data-ms]"):null;
      if(!b)return;
      pollMs=Number(b.getAttribute("data-ms"))||POLL_DEFAULT_MS;
      if(!pollOn)pollOn=true;          // picking an interval implies resume
      savePoll(); schedulePoll();
      menu.hidden=true; if(ivl)ivl.setAttribute("aria-expanded","false");
    });
  }

  // ══ Usage tab ══════════════════════════════════════════════════════════════
  var USAGE=null, usageLoaded=false, usageBusy=false, TRANSCRIPT=null;

  function fmtUsd(n){
    n=Number(n)||0;
    if(n>=1000)return "$"+Math.round(n).toLocaleString();
    if(n>=10)return "$"+n.toFixed(0);
    return "$"+n.toFixed(2);
  }
  function fmtNum(n){return (Number(n)||0).toLocaleString();}
  function fmtTok(n){
    n=Number(n)||0;
    if(n>=1e9)return (n/1e9).toFixed(1)+"B";
    if(n>=1e6)return (n/1e6).toFixed(1)+"M";
    if(n>=1e3)return (n/1e3).toFixed(1)+"K";
    return String(Math.round(n));
  }
  function fmtHours(sec){var h=(Number(sec)||0)/3600; return (h>=10?Math.round(h):h.toFixed(1))+"h";}
  function fmtMins(m){m=Number(m)||0; return m>=60?Math.round(m/60)+"h":Math.round(m)+"m";}
  function fld(v,k){
    if(v==null)return 0;
    if(typeof v==="number")return k==="cost"?v:0;
    return Number(v[k])||0;
  }
  function pct(a,b){return b?(a/b*100):0;}
  function entries(map,key){
    var out=[];
    for(var k in (map||{}))out.push({name:k,v:map[k],cost:fld(map[k],key||"cost")});
    out.sort(function(a,b){return b.cost-a.cost;});
    return out;
  }

  function loadUsage(force){
    if(usageBusy)return Promise.resolve();
    usageBusy=true;
    var jobs=[fetch("/api/usage?days="+usageDays,{cache:"no-store"}).then(function(r){return r.json();})
      .then(function(d){USAGE=d; usageLoaded=true;})];
    if(usageView==="transcript"&&usageSession&&(force||!TRANSCRIPT||TRANSCRIPT.id!==usageSession))
      jobs.push(loadTranscript(usageSession));
    return Promise.all(jobs).catch(function(){
      USAGE={error:"usage index unavailable"};
    }).then(function(){usageBusy=false; renderUsage();});
  }

  function loadTranscript(id){
    return fetch("/api/session/"+encodeURIComponent(id),{cache:"no-store"})
      .then(function(r){return r.json();})
      .then(function(d){TRANSCRIPT=d&&!d.error?{id:id,meta:d.meta,turns:d.turns||[]}:{id:id,error:(d&&d.error)||"unreadable"};});
  }

  function setUsageView(v,session){
    usageView=v;
    if(session!==undefined)usageSession=session;
    var btns=document.querySelectorAll("#usage-seg [data-view]");
    for(var i=0;i<btns.length;i++)btns[i].setAttribute("aria-selected",btns[i].getAttribute("data-view")===v?"true":"false");
    for(var j=0;j<VIEWS.length;j++){
      var el=document.getElementById("v-"+VIEWS[j]);
      if(el)el.hidden=(VIEWS[j]!==v);
    }
    syncHash();
    if(v==="transcript"&&usageSession&&(!TRANSCRIPT||TRANSCRIPT.id!==usageSession)){
      loadTranscript(usageSession).then(renderTranscript);
    }
    // Limits is LAZY like the tab itself: the Codex side may spawn one vendor
    // subprocess server-side, so it runs when the view is opened, not on poll.
    if(v==="limits"&&!LIMITS)loadLimits();
  }

  // titleTxt is optional and goes on the OUTER .kpi, so the whole card is the
  // hover target — a tooltip anchored to the number alone would be a 40px
  // target for a 200px card. Omitted entirely when not passed, so no card
  // gains an empty title="".
  function kpi(k,v,d,cls,titleTxt){
    return '<div class="kpi '+cls+'"'+(titleTxt?' title="'+esc(titleTxt)+'"':"")
      +'><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div>'
      +'<div class="d">'+d+"</div></div>";
  }
  function bar(label,valueTxt,subTxt,share,alt,extra){
    return '<div class="mrow"'+(extra||"")+'><span class="mname'+(alt?"":" mono")+'">'+label+"</span>"
      +'<span class="mbar"><i class="'+(alt?"alt":"")+'" style="width:'+share.toFixed(1)+'%"></i></span>'
      +'<span class="mval mono">'+esc(valueTxt)+"</span>"
      +'<span class="msub mono">'+esc(subTxt)+"</span></div>";
  }

  // ADR-0009 §4 — all three time tiers, as the asserted ordering
  // engaged <= open <= summed. The visible KPI still leads with the honest
  // figure; this is the SUPPORTING EVIDENCE for it, which is why it lives in a
  // tooltip and not in the hero row. Hover is a weak channel (undiscoverable by
  // accident, absent on touch) and the ADR records that trade-off: a reader who
  // never hovers is less informed, not misled. Every figure comes from totals —
  // nothing here is computed a second way.
  function ladder(t){
    return "engaged "+fmtHours(t.engagedSeconds)
      +" ≤ open "+fmtHours(t.spanUnionSeconds)
      +" ≤ summed "+fmtHours((Number(t.spanMinutes)||0)*60)+"\\n"
      +"engaged unions active sub-intervals split at 15-min silences; "
      +"open unions whole session spans; summed double-counts overlap.";
  }

  function renderScore(d){
    var t=d.totals||{};
    var cacheShare=pct(t.cacheRead,t.tokens);
    document.getElementById("u-hero").innerHTML=
      kpi("sessions",fmtNum(t.sessions),esc(fmtNum(t.responses))+" assistant turns","")
      +kpi("api-equivalent",fmtUsd(t.cost),"list price &middot; not plan billing","accent")
      +kpi("tokens",fmtTok(t.tokens),esc(fmtTok(t.output))+" out &middot; "+esc(fmtTok(t.cacheRead))+" cached","")
      +kpi("engaged time",fmtHours(t.engagedSeconds),
        esc(fmtMins(t.spanMinutes))+" summed"
        +'<span class="d-note">sessions overlap</span>',"",ladder(t))
      +kpi("cache read",cacheShare.toFixed(1)+"%","priced at 0.1&times; input","warnv");
    document.getElementById("u-asof").textContent=d.pricesAsOf?("rates as of "+d.pricesAsOf):"";

    // cost per day
    var days=[],k;
    for(k in (d.byDay||{}))days.push({day:k,v:d.byDay[k]});
    days.sort(function(a,b){return a.day<b.day?-1:1;});
    var maxDay=0;
    for(var i=0;i<days.length;i++)maxDay=Math.max(maxDay,fld(days[i].v,"cost"));
    document.getElementById("u-days-note").textContent="api-equivalent · "+usageDays+"-day window";
    document.getElementById("u-daybars").innerHTML=days.length?days.map(function(x){
      var c=fld(x.v,"cost"), h=maxDay?Math.max(2,c/maxDay*100):2;
      var tip=x.day+" · "+fmtUsd(c)+" · "+fmtTok(fld(x.v,"tokens"))+" tok · "+fmtNum(fld(x.v,"sessions"))+" sessions";
      return '<div class="daybar" title="'+esc(tip)+'"><div class="db-fill" style="height:'+h.toFixed(1)+'%"></div>'
        +'<span class="db-lab">'+esc(x.day.slice(8))+"</span></div>";
    }).join(""):'<div class="empty">no days in window.</div>';

    // by host
    var prov=d.byProvider||{};
    var order=["claude","codex"];
    for(k in prov)if(order.indexOf(k)<0)order.push(k);
    document.getElementById("u-hosts").innerHTML=order.map(function(name){
      var v=prov[name], cost=fld(v,"cost"), sess=fld(v,"sessions"), tok=fld(v,"tokens");
      var idle=!sess&&!cost;
      return '<div class="pcard'+(idle?" idle":"")+'"><div class="ph"><span class="pdot '
        +(name==="codex"?"x":"c")+'"></span>'+esc(name)+"</div>"
        +'<div class="pv mono">'+esc(fmtUsd(cost))+"</div>"
        +'<div class="pl">'+(idle?"no sessions in window":esc(fmtNum(sess))+" sessions &middot; "+esc(fmtTok(tok))+" tokens")+"</div></div>";
    }).join("");

    var segs=[["cache read",t.cacheRead,"var(--warn)"],["cache write",t.cacheWrite,"var(--purple)"],
      ["output",t.output,"var(--accent)"],["input",t.input,"var(--ok)"]];
    document.getElementById("u-tokbar").innerHTML=segs.map(function(sg){
      return '<i style="width:'+pct(sg[1],t.tokens).toFixed(2)+"%;background:"+sg[2]+'"></i>';
    }).join("");
    document.getElementById("u-toklegend").innerHTML=segs.map(function(sg){
      return '<span class="lg"><i style="background:'+sg[2]+'"></i>'+esc(sg[0])+" <b>"+esc(fmtTok(sg[1]))+"</b></span>";
    }).join("");

    // punchcard — dow 0 = Mon
    var DOW=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], pcMax=0, key;
    for(key in (d.punchcard||{}))pcMax=Math.max(pcMax,Number(d.punchcard[key])||0);
    var pcHtml="";
    for(var dw=0;dw<7;dw++){
      pcHtml+='<div class="pc-row"><span class="pc-day">'+DOW[dw]+"</span>";
      for(var hr=0;hr<24;hr++){
        var n=Number((d.punchcard||{})[dw+"-"+hr])||0;
        var v=pcMax?(n/pcMax):0;
        pcHtml+='<i class="pc" style="--v:'+v.toFixed(3)+'" title="'+DOW[dw]+" "+(hr<10?"0":"")+hr
          +':00 — '+n+' responses"></i>';
      }
      pcHtml+="</div>";
    }
    pcHtml+='<div class="pc-axis">';
    for(var ax=0;ax<24;ax++)pcHtml+="<span>"+(ax%3===0?ax:"")+"</span>";
    pcHtml+="</div>";
    document.getElementById("u-punch").innerHTML=pcMax?pcHtml:'<div class="empty">no responses in window.</div>';

    // models + projects
    var models=entries(d.byModel), mMax=models.length?models[0].cost:0;
    document.getElementById("u-models").innerHTML=models.length?models.map(function(m){
      return bar(esc(m.name),fmtUsd(m.cost),fmtTok(fld(m.v,"tokens"))+" · "+fmtNum(fld(m.v,"responses"))+" resp",
        pct(m.cost,mMax),false);
    }).join(""):'<div class="empty">no models in window.</div>';
    // Dropped-connection / rate-limit / auth-failure turns never resolve to a
    // model — excluded from this list entirely rather than shown as a $0 row
    // (see docs/USAGE-SCORECARD-METRICS.md §10). Surfaced here instead, only
    // when nonzero, so they stay visible rather than silently vanishing.
    var exc=fld(t,"exceptions");
    document.getElementById("u-models-note").textContent=exc?(" · "+fmtNum(exc)+" dropped/errored turn"+(exc===1?"":"s")+" excluded"):"";

    var projects=entries(d.byProject), pMax=projects.length?projects[0].cost:0;
    var shown=projects.slice(0,8);
    document.getElementById("u-projects-note").textContent=
      projects.length>8?("top 8 of "+projects.length):(projects.length+" project"+(projects.length===1?"":"s"));
    document.getElementById("u-projects").innerHTML=shown.length?shown.map(function(pr){
      return bar(esc(pr.name),fmtUsd(pr.cost),fmtNum(fld(pr.v,"sessions"))+" sess · "+fmtMins(fld(pr.v,"minutes")),
        pct(pr.cost,pMax),true);
    }).join(""):'<div class="empty">no projects in window.</div>';

    // categories — confidence is DISPLAYED, and Unclassified is never hidden.
    var cats=entries(d.byCategory), cMax=cats.length?cats[0].cost:0;
    document.getElementById("u-cats").innerHTML=cats.length?cats.map(function(c){
      var sess=fld(c.v,"sessions")||1, conf=fld(c.v,"confidence");
      var uncl=(c.name==="Unclassified");
      var dot=uncl?"":'<i class="conf" style="opacity:'+(0.5+conf*0.5).toFixed(2)
        +'" title="mean classifier confidence '+conf.toFixed(2)+'"></i>';
      return '<button type="button" class="crow'+(uncl?" uncl":"")+'" data-cat="'+esc(c.name)+'" title="click to filter sessions">'
        +'<span class="c-name">'+esc(c.name)+dot+"</span>"
        +'<span class="mbar"><i style="width:'+pct(c.cost,cMax).toFixed(1)+"%;background:"+(uncl?"var(--ink-dim)":"var(--accent)")+'"></i></span>'
        +'<span class="mval mono">'+esc(fmtUsd(c.cost))+"</span>"
        +'<span class="msub mono">'+esc(fmtNum(fld(c.v,"sessions"))+" sess · "+fmtUsd(c.cost/sess)+"/sess")+"</span></button>";
    }).join(""):'<div class="empty">nothing classified in window.</div>';
  }

  // ══ Limits view (ADR-0010) ═════════════════════════════════════════════════
  var LIMITS=null, limitsBusy=false;

  function loadLimits(){
    if(limitsBusy)return;
    limitsBusy=true;
    fetch("/api/limits?days="+usageDays,{cache:"no-store"})
      .then(function(r){return r.json();})
      .then(function(d){LIMITS=d&&!d.error?d:{error:(d&&d.error)||"limits unavailable"};})
      .catch(function(){LIMITS={error:"limits unavailable"};})
      .then(function(){limitsBusy=false; renderLimits();});
  }

  // "as of 3m ago" — an epoch-ms fetchedAt against the browser clock. Stale is
  // LABELLED, never hidden: a yesterday's-number bar with no timestamp is a lie
  // of omission.
  function limAge(ms){
    if(!ms||!isFinite(ms))return "";
    var m=Math.max(0,Math.round((Date.now()-ms)/60000));
    if(m<1)return "just now";
    if(m<60)return m+"m ago";
    var h=Math.round(m/60);
    return h<48?h+"h ago":Math.round(h/24)+"d ago";
  }
  function limStale(ms,freshMs){return !ms||!isFinite(ms)||(Date.now()-ms)>freshMs;}
  function resetTxt(sec){
    if(!sec||!isFinite(sec))return "";
    var d=new Date(sec*1000);
    if(isNaN(d))return "";
    return "resets "+d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
  }
  // One utilization row on the shared .mrow grid; fill color says how close to
  // the cap this window is (ok <70, warn ≥70, fail ≥90).
  function limRow(label,usedPercent,resetSec,sub){
    var p=Math.max(0,Math.min(100,Number(usedPercent)||0));
    var col=p>=90?"var(--fail)":(p>=70?"var(--warn)":"var(--ok)");
    return '<div class="mrow"><span class="mname">'+esc(label)+"</span>"
      +'<span class="mbar"><i style="width:'+p.toFixed(1)+"%;background:"+col+'"></i></span>'
      +'<span class="mval mono">'+p.toFixed(0)+"%</span>"
      +'<span class="msub mono">'+esc(sub||resetTxt(resetSec))+"</span></div>";
  }

  function renderLimits(){
    var claudeEl=document.getElementById("u-lim-claude");
    var codexEl=document.getElementById("u-lim-codex");
    if(!claudeEl||!codexEl)return;
    if(!LIMITS){claudeEl.innerHTML='<div class="empty">loading&hellip;</div>'; codexEl.innerHTML='<div class="empty">loading&hellip;</div>'; return;}
    if(LIMITS.error){claudeEl.innerHTML='<div class="empty">'+esc(LIMITS.error)+"</div>"; codexEl.innerHTML=""; return;}

    var c=LIMITS.claude;
    var cn=document.getElementById("u-lim-claude-note");
    if(c&&c.windows&&c.windows.length){
      // Claude's tee is push-only: FRESH means a session wrote it in the last
      // 10 minutes; anything older gets the stale badge rather than silence.
      if(cn)cn.textContent="statusline tee · "+limAge(c.fetchedAt)+(limStale(c.fetchedAt,600000)?" · stale":"");
      claudeEl.innerHTML=c.windows.map(function(w){
        return limRow("claude · "+(w.label||w.id),w.usedPercent,w.resetsAt);
      }).join("");
    }else{
      if(cn)cn.textContent="no data";
      claudeEl.innerHTML='<div class="empty">no Claude limit data yet &mdash; it arrives while a Claude Code session runs '
        +"with the kit's managed statusline (Pro/Max plans only). Run one session, then revisit.</div>";
    }

    var x=LIMITS.codex;
    var xn=document.getElementById("u-lim-codex-note");
    if(x&&x.lanes&&x.lanes.length){
      if(xn)xn.textContent=(x.planType?("plan "+x.planType+" · "):"")+"app-server · "+limAge(x.fetchedAt);
      var html="";
      for(var i=0;i<x.lanes.length;i++){
        var lane=x.lanes[i];
        for(var j=0;j<(lane.windows||[]).length;j++){
          var w=lane.windows[j];
          html+=limRow(lane.name+" · "+(w.label||""),w.usedPercent,w.resetsAt);
        }
        if(!(lane.windows||[]).length)html+=limRow(lane.name,0,null,"no window reported");
      }
      var rc=x.resetCredits;
      if(rc&&rc.availableCount>0){
        html+='<div class="legend" style="margin-top:11px"><span class="lg"><i style="background:var(--ok)"></i>'
          +esc(fmtNum(rc.availableCount))+" rate-limit reset credit"+(rc.availableCount===1?"":"s")
          +" available &middot; redeem via codex /usage</span></div>";
      }
      codexEl.innerHTML=html;
    }else{
      if(xn)xn.textContent="no data";
      codexEl.innerHTML='<div class="empty">no Codex limit data &mdash; codex is not installed, not logged in, '
        +"or app-server did not answer.</div>";
    }

    var ins=Array.isArray(LIMITS.insights)?LIMITS.insights:[];
    document.getElementById("u-lim-insights").innerHTML=ins.length
      ?ins.map(insightCard).join("")
      :'<div class="empty">no limit findings &mdash; nothing is ahead of pace and no arbitrage is open.</div>';
  }

  function renderFindings(d){
    var ins=Array.isArray(d.insights)?d.insights:[];
    var badge=document.getElementById("u-findings-n");
    var warns=ins.filter(function(x){return x.severity==="warn";}).length;
    if(badge){if(warns){badge.hidden=false; badge.textContent=String(warns);}else{badge.hidden=true;}}
    document.getElementById("u-findings-note").innerHTML=
      ins.length+" finding"+(ins.length===1?"":"s")+", ranked by estimated impact. A finding only claims a "
      +"dollar figure when it can compute one from your data &mdash; the rest say <b>no $ claimed</b> rather "
      +"than inventing a number. Recommendations that depend on model-capability claims carry their sources.";
    document.getElementById("u-insights").innerHTML=ins.length
      ?ins.map(insightCard).join("")
      :'<div class="empty">no findings — nothing in this window crossed a detector threshold.</div>';
  }

  // One finding card. Shared by the Findings view and the Limits view — both
  // render the same Insight contract, so they must render it the same way.
  function insightCard(f,i){
    var imp=(typeof f.impact==="number")
      ? '<span class="i-imp mono">~'+esc(fmtUsd(f.impact))+"/window</span>"
      : '<span class="i-imp mono soft">no $ claimed</span>';
    var cmd=f.command?' <code class="i-cmd">'+esc(f.command)+"</code>":"";
    var src="";
    if(f.sources&&f.sources.length){
      src='<details class="i-src"><summary>grounding &mdash; '+f.sources.length+" source"
        +(f.sources.length===1?"":"s")+"</summary><ul>"
        +f.sources.map(function(sc){
          return "<li><a href=\\""+esc(sc.url)+"\\" target=\\"_blank\\" rel=\\"noreferrer noopener\\">"+esc(sc.label)+"</a></li>";
        }).join("")+"</ul></details>";
    }
    return '<article class="icard" data-sev="'+esc(f.severity||"info")+'">'
      +'<div class="i-top"><span class="i-n">'+(i+1)+"</span>"
      +'<span class="i-title">'+esc(f.title)+"</span>"
      +'<span class="i-kind">'+esc(f.kind==="trend"?"trend":"coaching")+"</span>"+imp+"</div>"
      +'<p class="i-find">'+esc(f.finding)+"</p>"
      +(f.evidence?'<p class="i-ev">'+esc(f.evidence)+"</p>":"")
      +'<div class="i-act"><span class="i-arrow">&rarr;</span><span>'+esc(f.action)+cmd+"</span></div>"
      +src+"</article>";
  }

  // A missing signal renders as an em dash and is NEVER omitted: a line that
  // disappears when the value is null teaches the reader that the field does
  // not exist, when in fact it was measured and found absent (ADR-0009 §5).
  function dash(v){return (v==null||v==="")?"—":String(v);}

  /* The ten fields that shipped on the wire and rendered nowhere. Everything
     here comes from the row the browser already holds — no route, no fetch. */
  function sdetail(sx){
    // basis is a STRING contract. Only null/empty falls back, so a non-string
    // still renders as itself and trips the harness's [object Object] net —
    // coercing it here would hide exactly the bug the net exists to catch.
    var basis=(sx.basis==null||sx.basis==="")?"no signal":sx.basis;
    var conf=(typeof sx.confidence==="number")
      ? ' <span class="sd-conf">(conf '+esc(sx.confidence.toFixed(2))+")</span>" : "";
    var models=(Array.isArray(sx.models)&&sx.models.length)?sx.models.join(", "):"—";
    var toks="in "+fmtTok(sx.input)+" · out "+fmtTok(sx.output)
      +" · cache r "+fmtTok(sx.cacheRead)+" / w "+fmtTok(sx.cacheWrite)
      // Codex-only detail: reasoning tokens are a SUBSET of output (they bill
      // as output), so this annotates the split without changing any sum.
      +((Number(sx.reasoningOutput)||0)>0?" · reasoning "+fmtTok(sx.reasoningOutput)+" (in out)":"");
    var tmap=(sx.tools&&typeof sx.tools==="object"&&!Array.isArray(sx.tools))?sx.tools:{};
    var tl=[],tk;
    for(tk in tmap)tl.push({n:tk,c:Number(tmap[tk])||0});
    tl.sort(function(a,b){return b.c-a.c;});
    var tools=tl.length?tl.slice(0,6).map(function(x){return x.n+" "+x.c;}).join(" · "):"—";
    var flags="skill "+dash(sx.skill)+" · plugin "+dash(sx.plugin)
      +" · sidechain "+(sx.sidechain==null?"—":(sx.sidechain?"yes":"no"))
      +" · worktree "+dash(sx.worktree);
    var rows=[["basis",esc(basis)+conf],["models",esc(models)],["tokens",esc(toks)],
      ["tools",esc(tools)],["flags",esc(flags)]];
    return '<div class="sdetail" id="sd-'+esc(sx.id)+'" hidden>'
      +rows.map(function(r){
        // The literal space is load-bearing, not formatting: adjacent
        // inline-blocks with no whitespace between them collapse into one
        // unbroken word in the rendered text ("FLAGSskill"), destroying the
        // word boundary that anything reading it depends on.
        return '<div class="sd-line"><span class="sd-k">'+r[0]+'</span> <span class="sd-v">'+r[1]+"</span></div>";
      }).join("")+"</div>";
  }

  // Returns TWO siblings: the grid row, then its detail strip. The strip is a
  // block-level sibling inside .pbody, not a grid child of .srow, so it spans
  // the full width without joining the column layout.
  function sessionRow(sx){
    var host=(sx.provider==="codex")?"codex":"claude";
    var cat=sx.category||"Unclassified";
    var uncl=(cat==="Unclassified");
    var weak=(typeof sx.confidence==="number"&&sx.confidence<0.6)?"0":"1";
    var when=sx.start?new Date(sx.start):null;
    var whenTxt=when&&!isNaN(when)?when.toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"—";
    // Session ids are validated against [A-Za-z0-9._-]{1,128} by parseSessionId
    // before they are ever indexed, so they are safe AND unique as DOM ids.
    var sid=esc(sx.id);
    var wt=sx.worktree!=null?'<span class="s-wt" title="git worktree — the repo is the project">⑂'+esc(sx.worktree)+"</span>":"";
    return '<div class="srow" data-id="'+sid+'" title="open transcript">'
      +'<button class="s-exp" type="button" aria-expanded="false" aria-controls="sd-'+sid+'"'
        +' title="show session detail" aria-label="show session detail">&rsaquo;</button>'
      +'<span class="s-host s-'+host+'">'+esc(host)+"</span>"
      +'<span class="s-title">'+esc(sx.title||"(untitled)")+wt+"</span>"
      +'<span class="cat'+(uncl?" uncl":"")+'" data-w="'+weak+'">'+esc(cat)+"</span>"
      +'<span class="s-when mono">'+esc(whenTxt)+"</span>"
      +'<span class="s-dur mono">'+esc(fmtMins(sx.minutes))+"</span>"
      +'<span class="s-turns mono">'+esc((sx.prompts||0)+"/"+(sx.responses||0))+"</span>"
      +'<span class="s-tok mono">'+esc(fmtTok(sx.tokens))+"</span>"
      +'<span class="s-cost mono">'+esc(fmtUsd(sx.cost))+"</span>"
      +'<button class="s-tx" type="button" data-tx="'+sid+'" title="open transcript" aria-label="open transcript">&#9707;</button>'
    +"</div>"+sdetail(sx);
  }

  function renderSessions(d){
    var tree=Array.isArray(d.projectTree)?d.projectTree:[];
    var n=document.getElementById("u-sessions-n");
    if(n)n.textContent=tree.length?" "+fmtNum((d.totals||{}).sessions):"";
    document.getElementById("u-tree").innerHTML=tree.length?tree.map(function(g){
      var chips="";
      // usage-index emits categories as a COST-RANKED ARRAY of
      // {category, sessions, cost} — already ordered, so no re-sort here. The
      // keyed-map fallback below is for older cached payloads only; treating an
      // array as a map yields Object.keys() === ["0","1"...] and renders
      // "0 [object Object]", so the shape check is load-bearing, not defensive noise.
      var cs=g.categories;
      if(Array.isArray(cs)){
        for(var i=0;i<cs.length&&i<3;i++){
          var c=cs[i]||{};
          chips+='<span class="pchip">'+esc(c.category)+" <b>"+esc(String(c.sessions))+"</b></span>";
        }
      }else if(cs&&typeof cs==="object"){
        var ck=Object.keys(cs).sort(function(a,b){return (cs[b]||0)-(cs[a]||0);}).slice(0,3);
        for(var j=0;j<ck.length;j++)chips+='<span class="pchip">'+esc(ck[j])+" <b>"+esc(String(cs[ck[j]]))+"</b></span>";
      }
      var rows=Array.isArray(g.rows)?g.rows:[];
      var body=rows.length?rows.slice(0,25).map(sessionRow).join(""):'<div class="smore">no sessions loaded for this project.</div>';
      if(rows.length>25||g.sessions>rows.length){
        body+='<div class="smore">showing '+Math.min(25,rows.length)+" of "+fmtNum(g.sessions)
          +' · <button type="button" data-more="'+esc(g.project)+'">load all</button></div>';
      }
      // Every project starts COLLAPSED. Auto-opening the first one pushed the
      // remaining projects below the fold, which defeats the point of the
      // aggregate view — the comparison across projects IS the top-level answer.
      return '<div class="pgroup">'
        +'<button class="phead" type="button"><span class="chev">&rsaquo;</span>'
        +'<span class="pname">'+esc(g.project)+"</span>"
        +'<span class="pchips">'+chips+"</span>"
        +'<span class="pn mono">'+esc(fmtNum(g.sessions))+" sess</span>"
        +'<span class="pn mono p-h">'+esc(fmtMins(g.minutes))+"</span>"
        +'<span class="pn mono p-tok">'+esc(fmtTok(g.tokens))+"</span>"
        +'<span class="pcost mono">'+esc(fmtUsd(g.cost))+"</span></button>"
        +'<div class="pbody" data-body="'+esc(g.project)+'">'+body+"</div></div>";
    }).join(""):'<div class="empty">no sessions in window.</div>';
  }

  // Secrets are masked SERVER-side (ADR-0009 §8) — nothing here can un-redact
  // what never left the process. This only makes the redactions visible as
  // redactions, so a reader can see that something was withheld.
  // The masker emits "<prefix>\u2026redacted" (sk-\u2026redacted, Bearer \u2026redacted).
  // This used to hunt for ***, \u2022\u2022\u2022 or [REDACTED] \u2014 sentinels nothing ever
  // produced \u2014 so no .masked span was ever created and the styling below was
  // dead code. There is deliberately NO click-to-reveal: masking happens
  // server-side and the original never reaches the browser, so there is nothing
  // here to reveal. Marking it is the whole feature.
  function markRedactions(text){
    return esc(text).replace(/([A-Za-z_.-]*\u2026redacted)/g,function(m){
      return '<span class="masked" title="masked server-side \u2014 the original was never sent to this page">'+m+"</span>";
    });
  }

  // Harness sentinel markup \u2014 the XML wrappers Claude Code writes into
  // transcript text (<command-name>, <system-reminder>, <local-command-*>) \u2014
  // rendered as styled structure instead of literal angle-bracket soup.
  // PRESENTATION ONLY: the wrapped content is kept verbatim (ADR-0009 \u00a78's
  // no-silent-alteration rule); only the wrapper tags become styling. Runs on
  // ESCAPED html (after markRedactions), so patterns match &lt;tag&gt;. An
  // unmatched tag (e.g. cut mid-sentinel by turn truncation) is left raw.
  var H_TAGS={"system-reminder":"system reminder","local-command-caveat":"caveat",
    "local-command-stdout":"command output","local-command-stderr":"command stderr",
    "bash-stdout":"bash output","bash-stderr":"bash stderr","task-notification":"task notification"};
  function fmtHarness(html){
    return html
      .replace(/&lt;command-name&gt;([\\s\\S]*?)&lt;\\/command-name&gt;\\s*(?:&lt;command-message&gt;([\\s\\S]*?)&lt;\\/command-message&gt;\\s*)?(?:&lt;command-args&gt;([\\s\\S]*?)&lt;\\/command-args&gt;)?/g,
        function(_,name,msg,args){
          var n=name.trim(), a=(args||"").trim(), m=(msg||"").trim();
          return '<span class="h-cmd"'+(m&&m!==n.replace(/^\\//,"")?' title="'+m+'"':"")
            +'>'+n+(a?" "+a:"")+"</span>";
        })
      // bash-input is the person's own "! command" — a chip, prefixed so it
      // reads as the shell invocation it was, not as prose.
      .replace(/&lt;bash-input&gt;([\\s\\S]*?)&lt;\\/bash-input&gt;/g,
        function(_,cmd){return '<span class="h-cmd" title="shell command run with the ! prefix">! '+cmd.trim()+"</span>";})
      .replace(/&lt;(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|task-notification)&gt;\\s*([\\s\\S]*?)\\s*&lt;\\/\\1&gt;/g,
        function(_,tag,body){
          return '<span class="h-note"><i class="h-tag">'+H_TAGS[tag]+"</i>"+body+"</span>";
        });
  }

  // ADR-0009 §8 — an abridged turn must not be readable as a complete one, and
  // "truncated" alone is not enough: a reader who cannot tell 1% loss from 90%
  // loss knows something is missing and nothing about whether it matters.
  //
  // The SHOWN figure is DERIVED, never hardcoded. MAX_TURN_CHARS lives in
  // usage-index.mjs and the browser never sees it, so a literal 40000 here
  // would silently desync the day someone changes the constant — which is the
  // failure mode this whole ADR exists to prevent. We subtract the marker the
  // producer appends from the text we actually received.
  var TRUNC_MARK="\\n…[truncated]";
  function truncBadge(tn){
    if(!tn||tn.truncated!==true)return "";
    var shown=String(tn.text==null?"":tn.text);
    var n=shown.length-(shown.slice(-TRUNC_MARK.length)===TRUNC_MARK?TRUNC_MARK.length:0);
    // A cached payload can carry truncated:true with no originalChars. Say so,
    // rather than inventing a denominator or dropping the badge — §6's rule
    // about claiming a figure only when you can compute one.
    if(typeof tn.originalChars!=="number"||!isFinite(tn.originalChars)||tn.originalChars<=0)
      return '<span class="t-trunc" title="this turn was abridged before it was sent to this page; '
        +'the original length was not recorded">truncated</span>';
    return '<span class="t-trunc" title="'
      +esc(fmtNum(n)+" of "+fmtNum(tn.originalChars)
        +" characters shown; the rest was not sent to this page")+'">truncated · '
      +esc(fmtTok(n))+" of "+esc(fmtTok(tn.originalChars))+"</span>";
  }

  function renderTranscript(){
    var crumb=document.getElementById("u-crumb"), body=document.getElementById("u-turns");
    if(!usageSession){
      crumb.innerHTML='<button type="button" data-back="1">&lsaquo; sessions</button><span>no session selected</span>';
      body.innerHTML='<div class="empty">pick a session in the Sessions view to read it here.</div>';
      return;
    }
    var t=TRANSCRIPT&&TRANSCRIPT.id===usageSession?TRANSCRIPT:null;
    var m=(t&&t.meta)||{};
    crumb.innerHTML='<button type="button" data-back="1">&lsaquo; sessions</button>'
      +'<b style="color:var(--ink)">'+esc(m.title||usageSession)+"</b>"
      +'<span class="mono">'+esc([m.project,fmtMins(m.minutes),
        (m.prompts||0)+" prompts / "+(m.responses||0)+" responses",fmtTok(m.tokens),fmtUsd(m.cost)]
        .filter(Boolean).join(" · "))+"</span>";
    if(!t){body.innerHTML='<div class="empty">loading transcript…</div>'; return;}
    if(t.error){body.innerHTML='<div class="empty">'+esc(t.error)+"</div>"; return;}
    body.innerHTML=t.turns.length?t.turns.map(function(tn){
      var user=(tn.role==="user");
      var text=tn.text!=null?tn.text:(tn.body!=null?tn.body:(tn.content!=null?tn.content:""));
      var tools=(tn.tools&&tn.tools.length)
        ?'<div class="chips">'+tn.tools.map(function(x){return '<span class="tool">'+esc(x)+"</span>";}).join("")+"</div>":"";
      var meta=truncBadge(tn)
        +(tn.output?'<span class="t-meta mono">'+esc(fmtNum(tn.output))+" out</span>":"");
      // role "user" ≠ "the human typed this": the Messages API records tool
      // results and harness context injections under the user role, and the
      // parser marks WHICH via tn.kind. Only kind "prompt" earns "you" — a
      // tool result labeled "you" attributes the harness's work to the person.
      // Fallback for a turn without kind: the prompt flag (false ⇒ tool
      // feedback was the overwhelmingly dominant non-prompt case).
      var kind=tn.kind||(user?(tn.prompt===false?"tool-result":"prompt"):"");
      var who,cls,title="";
      if(!user){who=tn.model||tn.role||"assistant"; cls="t-asst";}
      else if(kind==="tool-result"){who="tool result"; cls="t-tool"; title="output returned to the model by the tooling — not typed by you";}
      else if(kind==="context"){who="context"; cls="t-tool"; title="context injected by the harness — not typed by you";}
      else{who="you"; cls="t-user";}
      return '<div class="turn '+cls+'"><div class="t-who"'+(title?' title="'+esc(title)+'"':"")+'>'
        +esc(who)+meta+"</div>"
        +'<div class="t-body">'+fmtHarness(markRedactions(String(text)))+tools+"</div></div>";
    }).join(""):'<div class="empty">this session has no readable turns.</div>';
  }

  function renderUsage(){
    if(!USAGE)return;
    if(USAGE.error){
      document.getElementById("u-hero").innerHTML='<div class="empty">'+esc(USAGE.error)+"</div>";
      return;
    }
    renderScore(USAGE);
    renderFindings(USAGE);
    renderSessions(USAGE);
    if(usageView==="transcript")renderTranscript();
  }

  function wireUsage(){
    var seg=document.getElementById("usage-seg");
    if(seg)seg.addEventListener("click",function(e){
      var b=e.target.closest?e.target.closest("[data-view]"):null;
      if(b)setUsageView(b.getAttribute("data-view"));
    });
    var chips=document.getElementById("usage-days");
    if(chips)chips.addEventListener("click",function(e){
      var b=e.target.closest?e.target.closest("[data-days]"):null;
      if(!b)return;
      usageDays=Number(b.getAttribute("data-days"))||14;
      var all=chips.querySelectorAll("[data-days]");
      for(var i=0;i<all.length;i++)all[i].classList.toggle("on",all[i]===b);
      usageLoaded=false; loadUsage(true);
      // limit findings are computed against the same window; refetch on change.
      LIMITS=null; if(usageView==="limits")loadLimits();
    });
    var panel=document.getElementById("panel-usage");
    if(panel)panel.addEventListener("click",function(e){
      var tgt=e.target;
      var head=tgt.closest?tgt.closest(".phead"):null;
      if(head){
        var g=head.parentElement;
        if(g.hasAttribute("data-open"))g.removeAttribute("data-open"); else g.setAttribute("data-open","1");
        return;
      }
      var more=tgt.closest?tgt.closest("[data-more]"):null;
      if(more){loadProjectSessions(more.getAttribute("data-more")); return;}
      // MUST come before the [data-id] branch below: the caret lives INSIDE the
      // row, so closest("[data-id]") matches it too. stopPropagation() first,
      // then toggle — the row's click-to-open-transcript path is shipped
      // behaviour and this must not disturb it. State is ephemeral by design:
      // not persisted, not in the hash (a poll refresh re-renders collapsed).
      var exp=tgt.closest?tgt.closest(".s-exp"):null;
      if(exp){
        e.stopPropagation();
        var wasOpen=exp.getAttribute("aria-expanded")==="true";
        exp.setAttribute("aria-expanded",wasOpen?"false":"true");
        var det=document.getElementById(exp.getAttribute("aria-controls"));
        if(det)det.hidden=wasOpen;
        return;
      }
      // the glyph is the explicit affordance, but the whole row is a target too —
      // a 14px icon is a cruel click target for a row you can already see.
      var row=tgt.closest?tgt.closest("[data-id]"):null;
      if(row){setUsageView("transcript",row.getAttribute("data-id")); return;}
      var cat=tgt.closest?tgt.closest("[data-cat]"):null;
      if(cat){filterByCategory(cat.getAttribute("data-cat")); return;}
      var back=tgt.closest?tgt.closest("[data-back]"):null;
      if(back){setUsageView("sessions",null); return;}
      var mask=tgt.closest?tgt.closest(".masked"):null;
      if(mask)mask.classList.toggle("shown");
    });
  }

  function loadProjectSessions(project){
    fetch("/api/sessions?days="+usageDays+"&project="+encodeURIComponent(project)+"&limit=1000",{cache:"no-store"})
      .then(function(r){return r.json();}).then(function(d){
        var el=document.querySelector('[data-body="'+project.replace(/"/g,"")+'"]');
        if(!el)return;
        el.innerHTML=(d.sessions||[]).map(sessionRow).join("")
          ||'<div class="smore">no sessions.</div>';
      }).catch(function(){});
  }

  function filterByCategory(cat){
    setUsageView("sessions");
    fetch("/api/sessions?days="+usageDays+"&category="+encodeURIComponent(cat)+"&limit=1000",{cache:"no-store"})
      .then(function(r){return r.json();}).then(function(d){
        document.getElementById("u-tree").innerHTML=
          '<div class="pgroup" data-open="1"><button class="phead" type="button">'
          +'<span class="chev">&rsaquo;</span><span class="pname">'+esc(cat)+"</span>"
          +'<span class="pchips"><span class="pchip">filtered <b>'+fmtNum(d.total||0)+"</b></span></span>"
          +'<span class="pn mono"></span><span class="pn mono"></span><span class="pn mono"></span>'
          +'<span class="pcost mono"></span></button>'
          +'<div class="pbody">'+((d.sessions||[]).map(sessionRow).join("")
            ||'<div class="smore">no sessions in this category.</div>')+"</div></div>";
      }).catch(function(){});
  }

  setTab(activeTab);
  setUsageView(usageView);
  wirePoll();
  wireUsage();
  schedulePoll();
  lastAttempt=Date.now(); inflight=true;
  Promise.all([pollStatus()].concat(activeTab==="usage"?[loadUsage()]:[]))
    .catch(function(){}).then(function(){inflight=false; tickClock();});
  setInterval(tickClock,1000);
})();
`;
