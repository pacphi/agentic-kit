// dashboard-server.mjs — a read-only, localhost-only web dashboard for the kit.
//
// Zero runtime deps: a plain node:http server bound to 127.0.0.1. Two routes:
//   GET /            → one self-contained HTML document (all CSS + JS inline,
//                      no external fetches — offline-first, matches the kit ethos)
//   GET /api/status  → JSON: the same subsystem rows `ak status --json` emits,
//                      PLUS version drift, the project's .claude-flow/improvement.json
//                      (if present), and the health-history ring (if present).
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

/**
 * Start the dashboard HTTP server, bound to loopback only.
 * @param {{ port?: number, cwd?: string, fetchStatus?: () => Promise<any> }} [opts]
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export function startDashboard({ port = 7431, cwd = process.cwd(), fetchStatus } = {}) {
  const provide = fetchStatus || shellOutStatus(cwd);
  const html = renderPage({ name: '@pacphi/agentic-kit', version: kitVersion() });

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
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
    <div class="refresh" title="live — polling every 5s">
      <span class="pulse" id="pulse"></span>
      <span class="mono" id="updated">—</span>
    </div>
    <button class="toggle" id="theme-toggle" type="button" aria-label="toggle theme" title="toggle theme">
      <span class="icon" id="theme-icon" aria-hidden="true"></span>
    </button>
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
        <h2 class="strip-title">models in play</h2>
        <span class="mono strip-note" id="models-note"></span>
      </div>
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
}
:root[data-theme="dark"]{
  --bg:#000000; --panel:#1c1c1e; --panel-2:#2c2c2e; --raised:#3a3a3c; --thumb:#48484a;
  --ink:#f5f5f7; --ink-2:rgba(235,235,245,.64); --ink-dim:rgba(235,235,245,.38);
  --line:rgba(255,255,255,.09); --line-2:rgba(255,255,255,.17);
  --accent:#0a84ff; --accent-soft:rgba(10,132,255,.16);
  --ok:#30d158; --warn:#ff9f0a; --fail:#ff453a; --info:#98989d;
  --material:rgba(16,16,18,.72);
  --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -20px rgba(0,0,0,.9);
}
:root[data-theme="light"]{
  --bg:#f5f5f7; --panel:#ffffff; --panel-2:#f2f2f7; --raised:#ffffff; --thumb:#ffffff;
  --ink:#1d1d1f; --ink-2:rgba(60,60,67,.68); --ink-dim:rgba(60,60,67,.42);
  --line:rgba(60,60,67,.12); --line-2:rgba(60,60,67,.22);
  --accent:#007aff; --accent-soft:rgba(0,122,255,.12);
  --ok:#34c759; --warn:#ff9500; --fail:#ff3b30; --info:#8e8e93;
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
.band-tools{display:flex; align-items:center; gap:16px}
.refresh{display:flex; align-items:center; gap:8px; color:var(--ink-dim); font-size:12px}
.pulse{
  width:8px; height:8px; border-radius:50%; background:var(--accent);
  animation:pulse 2.4s ease-out infinite;
}
@keyframes pulse{
  0%{box-shadow:0 0 0 0 var(--accent-soft)}
  70%{box-shadow:0 0 0 7px transparent}
  100%{box-shadow:0 0 0 0 transparent}
}
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
  var TABS=["overview","hosts","providers","runtime","intel"];
  var CAT={
    hosts:"hosts", mcp:"hosts", "codex-mcp":"hosts", routing:"hosts",
    providers:"providers",
    learning:"intel", "ruvnet-brain":"intel", "ruvnet-brain-nightly":"intel", aqe:"intel", agentdb:"intel"
  };
  function catOf(s){return CAT[s]||"runtime";}

  var activeTab="overview";
  try{var st=localStorage.getItem(LS_TAB); if(st&&TABS.indexOf(st)>=0)activeTab=st;}catch(e){}
  // deep-link: #providers etc. wins over the stored tab
  try{var h=location.hash.slice(1); if(h&&TABS.indexOf(h)>=0)activeTab=h;}catch(e){}

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
    try{if(history.replaceState)history.replaceState(null,"","#"+id);}catch(e){}
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
    if(!lastUpdated){el.textContent="—";return;}
    el.textContent="updated "+ago(Math.round((Date.now()-lastUpdated)/1000));
  }

  function poll(){
    fetch("/api/status",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
      lastUpdated=Date.now(); render(d); tickClock();
    }).catch(function(){
      var t=document.getElementById("verdict-text"); if(t)t.textContent="server unreachable";
    });
  }

  setTab(activeTab);
  poll();
  setInterval(poll,5000);
  setInterval(tickClock,1000);
})();
`;
