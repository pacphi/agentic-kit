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
  };
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
      <div class="kit-sub"><span class="mono ver">v${escapeHtml(version)}</span><span class="sep">·</span><span class="mono">local diagnostic panel</span></div>
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

<div class="drift-banner" id="drift-banner" hidden></div>

<main class="wrap">
  <div class="summary" id="summary" hidden></div>
  <section id="cards" aria-live="polite"></section>

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
// Design: "refined technical instrument". Editorial serif for display, a mono
// stack for all data/labels — that serif+mono contrast is the signature. One
// slate ground + a single teal signal accent; status semantics carry their own
// calm green / amber / red / muted. CSS variables drive BOTH themes.
const CSS = `
:root{
  --serif:"Iowan Old Style","Palatino Linotype","Palatino","Georgia",serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Code","Menlo",monospace;
  --r:14px; --r-sm:9px;
}
:root[data-theme="dark"]{
  --bg:#0d1017; --bg-2:#0a0c11;
  --panel:#151b23; --panel-2:#1a212b; --raised:#1e2732;
  --ink:#e8e4d8; --ink-2:#b7bdc6; --ink-dim:#7f8895;
  --line:rgba(255,255,255,.075); --line-2:rgba(255,255,255,.13);
  --accent:#4fb6a8; --accent-soft:rgba(79,182,168,.16);
  --ok:#5fbf82; --warn:#e0a83e; --fail:#e46b64; --info:#8a93a0;
  --shadow:0 1px 0 rgba(255,255,255,.03),0 12px 30px -12px rgba(0,0,0,.7);
  --grain:rgba(255,255,255,.018);
}
:root[data-theme="light"]{
  --bg:#f2efe6; --bg-2:#eae6da;
  --panel:#fbfaf5; --panel-2:#f5f2ea; --raised:#ffffff;
  --ink:#242830; --ink-2:#454b54; --ink-dim:#767c85;
  --line:rgba(20,24,30,.10); --line-2:rgba(20,24,30,.18);
  --accent:#2c8578; --accent-soft:rgba(44,133,120,.13);
  --ok:#2f8b52; --warn:#a9741a; --fail:#c04a44; --info:#6c727b;
  --shadow:0 1px 0 rgba(255,255,255,.6),0 14px 30px -16px rgba(40,40,50,.35);
  --grain:rgba(20,24,30,.02);
}
@media (prefers-color-scheme:light){
  :root:not([data-theme]){ color-scheme:light; }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg);
  color:var(--ink);
  font-family:var(--mono);
  font-size:14px; line-height:1.55;
  -webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums;
  min-height:100vh;
  overflow-x:hidden;
  background-image:
    radial-gradient(1200px 600px at 15% -10%, var(--accent-soft), transparent 60%),
    radial-gradient(900px 500px at 110% 0%, rgba(0,0,0,.10), transparent 55%);
  background-attachment:fixed;
}
body::before{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:0;
  background-image:radial-gradient(var(--grain) 1px, transparent 1px);
  background-size:3px 3px; opacity:.9;
}
.mono{font-family:var(--mono)}

/* ── header band ── */
.band{
  position:relative; z-index:1;
  display:flex; align-items:center; gap:20px; flex-wrap:wrap;
  padding:20px clamp(16px,4vw,40px);
  border-bottom:1px solid var(--line);
  background:linear-gradient(180deg,var(--panel),transparent);
}
.band-lead{display:flex; align-items:center; gap:15px; min-width:0}
.mark{
  width:34px; height:34px; flex:none; border-radius:9px;
  background:
    linear-gradient(145deg,var(--accent),transparent 70%),
    var(--raised);
  border:1px solid var(--line-2);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.03), 0 6px 16px -8px var(--accent);
  position:relative;
}
.mark::after{
  content:""; position:absolute; inset:9px; border-radius:3px;
  border:1.5px solid var(--accent); opacity:.85;
}
.band-titles{min-width:0}
.kit-name{
  font-family:var(--serif); font-weight:600; font-style:italic;
  font-size:clamp(20px,2.6vw,27px); line-height:1.05; margin:0;
  letter-spacing:.2px;
}
.kit-sub{color:var(--ink-dim); font-size:12px; display:flex; gap:8px; align-items:center; margin-top:3px}
.kit-sub .sep{opacity:.5}
.ver{color:var(--accent)}
.band-verdict{
  display:flex; align-items:center; gap:10px; margin-left:auto;
  padding:8px 15px; border:1px solid var(--line); border-radius:100px;
  background:var(--panel-2);
}
.verdict-text{font-size:13px; letter-spacing:.3px}
.band-tools{display:flex; align-items:center; gap:16px}
.refresh{display:flex; align-items:center; gap:8px; color:var(--ink-dim); font-size:12px}
.pulse{
  width:8px; height:8px; border-radius:50%; background:var(--accent);
  box-shadow:0 0 0 0 var(--accent); animation:pulse 2.4s ease-out infinite;
}
@keyframes pulse{
  0%{box-shadow:0 0 0 0 var(--accent-soft)}
  70%{box-shadow:0 0 0 7px transparent}
  100%{box-shadow:0 0 0 0 transparent}
}
.toggle{
  display:inline-flex; align-items:center; justify-content:center;
  width:36px; height:36px; padding:0;
  color:var(--ink-2); background:var(--panel-2);
  border:1px solid var(--line); border-radius:50%; cursor:pointer;
  transition:border-color .2s ease, color .2s ease, background .2s ease;
}
.toggle:hover{border-color:var(--line-2); color:var(--accent); background:var(--raised)}
.toggle:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.toggle .icon{display:inline-flex}
.toggle .icon svg{width:17px; height:17px; display:block}

/* ── drift banner ── */
.drift-banner{
  position:relative; z-index:1;
  margin:14px clamp(16px,4vw,40px) 0;
  padding:11px 16px; border-radius:var(--r-sm);
  border:1px solid var(--warn); color:var(--ink);
  background:linear-gradient(180deg,rgba(224,168,62,.12),transparent);
  font-size:13px; display:flex; gap:10px; align-items:baseline;
}
.drift-banner b{color:var(--warn); font-family:var(--mono)}

/* ── layout ── */
.wrap{position:relative; z-index:1; padding:clamp(16px,4vw,40px); max-width:1180px; margin:0 auto}
.grid{
  display:grid; gap:14px;
  grid-template-columns:repeat(auto-fill,minmax(272px,1fr));
}

/* ── card ── */
.card{
  position:relative;
  background:var(--panel); border:1px solid var(--line);
  border-radius:var(--r); padding:16px 17px 15px;
  box-shadow:var(--shadow);
  opacity:0; transform:translateY(8px);
  animation:rise .5s cubic-bezier(.2,.7,.3,1) forwards;
  overflow:hidden;
}
.card::before{
  content:""; position:absolute; left:0; top:0; bottom:0; width:3px;
  background:var(--lvl,var(--info)); opacity:.75;
}
@keyframes rise{to{opacity:1; transform:none}}
.card-top{display:flex; align-items:center; gap:10px; margin-bottom:9px}
.dot{
  width:11px; height:11px; border-radius:50%; flex:none;
  background:var(--lvl,var(--info));
  box-shadow:0 0 0 3px color-mix(in srgb,var(--lvl,var(--info)) 22%, transparent),
             0 0 10px -1px var(--lvl,var(--info));
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
.card-name{
  font-family:var(--serif); font-size:17px; font-weight:600;
  letter-spacing:.2px; color:var(--ink);
}
.card-level{
  margin-left:auto; font-size:10.5px; letter-spacing:.14em; text-transform:uppercase;
  color:var(--lvl,var(--info));
}
.card-msg{color:var(--ink-2); font-size:13px; line-height:1.5; word-break:break-word}
.card-fix{
  margin-top:10px; padding-top:9px; border-top:1px solid var(--line);
  font-size:12px; color:var(--ink-dim); display:flex; gap:7px; align-items:baseline;
}
.card-fix .arrow{color:var(--accent)}
.card-fix code{color:var(--ink-2)}

/* ── triage summary strip ── */
.summary{
  position:relative; z-index:1;
  display:flex; flex-wrap:wrap; gap:9px; align-items:center;
  margin-bottom:18px; font-size:12.5px;
}
.pill{
  display:inline-flex; align-items:center; gap:7px;
  padding:5px 12px; border-radius:100px;
  border:1px solid var(--line); background:var(--panel);
  color:var(--ink-2); letter-spacing:.2px;
}
.pill .dot{width:8px; height:8px}
.pill b{color:var(--ink); font-family:var(--mono)}
.pill[data-level="fail"]{border-color:color-mix(in srgb,var(--fail) 55%,transparent)}
.pill[data-level="warn"]{border-color:color-mix(in srgb,var(--warn) 50%,transparent)}
.pill[data-tone="calm"]{opacity:.7}

/* ── grouped subsystem card ── */
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
.row-fix code{color:var(--ink-2)}

/* healthy section: present but recessed so problems dominate the eye */
.section-label{
  grid-column:1/-1;
  display:flex; align-items:center; gap:12px;
  margin:28px 0 4px; color:var(--ink-dim); font-size:11px;
  letter-spacing:.16em; text-transform:uppercase;
}
.section-label::after{content:""; flex:1; height:1px; background:var(--line)}
.grid.calm .card{opacity:.62; transition:opacity .2s ease}
.grid.calm .card:hover,.grid.calm .card:focus-within{opacity:1}

/* ── history strip ── */
.strip{
  margin-top:26px; padding:20px clamp(16px,3vw,26px);
  background:var(--panel); border:1px solid var(--line);
  border-radius:var(--r); box-shadow:var(--shadow);
}
.strip-head{display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:14px}
.strip-title{font-family:var(--serif); font-size:18px; font-weight:600; margin:0; letter-spacing:.2px}
.strip-note{color:var(--ink-dim); font-size:12px}
.spark-row{display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:20px}
.spark figcaption{color:var(--ink-dim); font-size:11px; letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px}
.spark-svg{width:100%; overflow-x:auto}
.spark-svg svg{display:block; width:100%; height:auto}

/* ── footer ── */
.foot{margin-top:24px; padding-top:16px; border-top:1px solid var(--line); color:var(--ink-dim); font-size:12px}

.empty{color:var(--ink-dim); font-size:13px; padding:30px 4px}

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
  var LS="ak-dash-theme";

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

  // severity rank for rollups + triage sort; preferred order breaks ties.
  var RANK={fail:3,warn:2,ok:1,info:0,unknown:0};
  var PREF=["versions","self","natives","security","learning","providers","hosts","mcp","ruvnet-brain","ruvnet-brain-nightly","aqe","daemons","blocks","statusline","npx"];

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

  function gridHtml(groups,calm){
    return '<div class="grid'+(calm?" calm":"")+'">'+groups.map(groupCard).join("")+"</div>";
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

  function renderCards(rows){
    var el=document.getElementById("cards");
    if(!rows||!rows.length){el.innerHTML='<div class="empty">no subsystem rows reported.</div>';return;}
    var groups=groupRows(rows);
    renderSummary(groups);
    var attn=groups.filter(function(x){return x.level==="fail"||x.level==="warn";});
    var calm=groups.filter(function(x){return x.level!=="fail"&&x.level!=="warn";});
    var html="";
    if(attn.length)html+=gridHtml(attn,false);
    if(calm.length)html+=(attn.length?'<div class="section-label">healthy · '+calm.length+" subsystems</div>":"")+gridHtml(calm,true);
    el.innerHTML=html;
    // staggered reveal, attention cards first
    var cards=el.querySelectorAll(".card");
    for(var i=0;i<cards.length;i++){cards[i].style.animationDelay=(i*40)+"ms";}
  }

  function renderVerdict(overall){
    var dot=document.getElementById("verdict-dot");
    var txt=document.getElementById("verdict-text");
    dot.setAttribute("data-level",overall||"unknown");
    dot.className="dot";
    txt.textContent=LEVEL_WORD[overall]||LEVEL_WORD.unknown;
  }

  function renderDrift(drift){
    var b=document.getElementById("drift-banner");
    var out=(drift||[]).filter(function(d){return d&&d.outdated;});
    if(!out.length){b.hidden=true;b.innerHTML="";return;}
    var parts=out.map(function(d){return "<b>"+esc(d.pkg)+"</b> "+esc(d.installed)+" &rarr; "+esc(d.latest);});
    b.innerHTML='<span>&#9053;</span><span>update available: '+parts.join(" &nbsp;·&nbsp; ")+' &mdash; run <b>ak sync</b></span>';
    b.hidden=false;
  }

  // ── sparkline (pure SVG) ──
  function accent(){return getComputedStyle(root).getPropertyValue("--accent").trim()||"#4fb6a8";}
  function dimc(){return getComputedStyle(root).getPropertyValue("--ink-dim").trim()||"#7f8895";}
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

  function render(data){
    if(!data)return;
    LAST=data;
    renderVerdict(data.overall);
    renderDrift(data.drift);
    renderCards(data.rows);
    renderHistory(data);
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

  poll();
  setInterval(poll,5000);
  setInterval(tickClock,1000);
})();
`;
