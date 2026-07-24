// admin-server.mjs — the loopback HTTP server for `ak x admin`.
//
// Adapted from the RuvNet Brain explainer admin (stuinfla/ruvnet-brain
// explainer/{admin.html,api/admin-stats.mjs}, MIT © 2026 Stuart Kerr /
// Isovision.ai). Where the reference is a hosted Vercel page gated by a static
// ADMIN_TOKEN, this is a local-first sibling of the dashboard: zero-dep node:http,
// bound to 127.0.0.1, minting a fresh per-session token at startup (ADR-0007).
//
// Two routes:
//   GET /                → the ONE self-contained document (inline CSS + model +
//                          view as a single module scope). CSP forbids every
//                          external fetch; the only network call the page makes is
//                          a same-origin fetch('/api/admin-stats').
//   GET /api/admin-stats → the typed payload, behind an x-admin-token check
//                          (constant-time, length-guarded). 401 JSON on mismatch,
//                          carrying no data fields.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRepoSlug, defaultCollect } from './admin-collect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Constant-time token compare with a length guard. timingSafeEqual THROWS on
 *  unequal length, which is itself a length/timing oracle — the guard turns
 *  unequal length into a plain `false`. No secret ⇒ never open (fail-closed). */
export function tokenMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The page makes ZERO external fetches; the browser enforces it via this header.
const CSP = [
  "default-src 'none'",           // deny everything not explicitly allowed
  "script-src 'unsafe-inline'",   // the two inline module scripts (model+view)
  "style-src 'unsafe-inline'",    // the one inline <style>
  "connect-src 'self'",           // the ONLY network call: same-origin fetch()
  "img-src 'none'",               // sparklines are inline SVG, not <img>
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Remove the single `import { … } from './admin-model.mjs';` line from the view
 *  source so model + view concatenate into one inline module scope on the page.
 *  On disk the import stays, keeping the view node --check / eslint clean. */
function stripModelImport(src) {
  return src.replace(/^\s*import\s*\{[^}]*\}\s*from\s*['"]\.\/admin-model\.mjs['"];?\s*$/m, '');
}

/**
 * Start the admin server, bound to loopback only.
 * @param {{ port?: number, collect?: () => Promise<any>,
 *           resolveToken?: () => Promise<{token:string}>, pkg?: any }} [opts]
 * @returns {Promise<{ url: string, urlWithToken: string, port: number, token: string, close: () => Promise<void> }>}
 */
export function startAdmin({ port = 7432, collect, resolveToken, pkg: injectedPkg } = {}) {
  // Identity from the kit's own package.json (FR-2). Fail closed on EC-8: refuse
  // to start rather than query the wrong repository.
  const pkg = injectedPkg ?? readJsonSafe(path.join(PKG_ROOT, 'package.json'));
  const repoSlug = parseRepoSlug(pkg && pkg.repository && pkg.repository.url);
  if (!repoSlug) {
    throw new Error('admin: cannot parse a GitHub owner/repo from package.json repository.url ('
      + JSON.stringify(pkg && pkg.repository && pkg.repository.url) + '). Refusing to start rather than query the wrong repository.');
  }
  const npmPkg = pkg && pkg.name;

  // Per-session auth secret (FR-3): 256-bit, fresh each start, URL-safe so it
  // rides cleanly in the launch URL's # fragment. There is no unauth mode.
  const token = crypto.randomBytes(32).toString('base64url');

  // Assemble the ONE self-contained document once (NFR-2, AC-5). Only first-party
  // source (model + view + CSS) is interpolated — no third-party data reaches the
  // served HTML, so the document is static and self-contained.
  const modelSrc = fs.readFileSync(path.join(HERE, 'admin-model.mjs'), 'utf8');
  const viewSrc = stripModelImport(fs.readFileSync(path.join(HERE, 'admin-view.mjs'), 'utf8'));
  const html = renderPage({ modelSrc, viewSrc });

  const provide = collect || defaultCollect({ repoSlug, npmPkg, resolveToken });

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end('method not allowed'); return; }

    // DNS-rebinding guard (carried from dashboard-server): the socket binds
    // loopback, but a hostile page can rebind ITS hostname to 127.0.0.1 and read
    // our API cross-origin (the SOP keys on the NAME). Only loopback literals are
    // legitimate Hosts.
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden (unexpected Host)');
      return;
    }

    const url = (req.url || '/').split('?')[0];

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': CSP,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      res.end(html);
      return;
    }

    if (url === '/api/admin-stats') {
      if (!tokenMatches(req.headers['x-admin-token'], token)) {
        // 401 body carries NO data fields (AC-1). nosniff so a browser cannot be
        // coaxed into re-interpreting the JSON body as another content type.
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify({ error: 'Wrong or missing admin token.' }));
        return;
      }
      let payload;
      try { payload = await provide(); }
      catch (e) { payload = { generatedAt: new Date().toISOString(), error: String((e && e.message) || e) }; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject); // EADDRINUSE bubbles to the caller (EC-5)
    server.listen(port, '127.0.0.1', () => { // loopback literal ONLY (NFR-2)
      const addr = server.address();
      const actual = addr && typeof addr === 'object' ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        urlWithToken: `http://127.0.0.1:${actual}/#token=${token}`, // FR-3 fragment bootstrap
        port: actual,
        token,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ── the page. One document, everything inline. Only first-party source is
// interpolated: `${CSS}` (the style), `${modelSrc}` + `${viewSrc}` (the one
// module scope). The client fetches /api/admin-stats and renders live. ─────────
function renderPage({ modelSrc, viewSrc }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>agentic-kit · admin</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
  <div class="head">
    <h1>agentic-kit — admin</h1>
    <span class="stamp mono" data-stamp></span>
  </div>
  <p class="sub">What moved since you last looked, who moved it, and what is waiting on you. Every number is read live from GitHub or npm — nothing here is stored, assumed, or estimated. Maintainer-only, localhost-only, deliberate egress.</p>

  <div class="gate" data-gate>
    <p>Maintainer dashboard. Paste the one-time session token printed in your terminal (it also rode in on the launch URL's <code>#</code> fragment).</p>
    <input type="password" placeholder="admin token" data-token-input autocomplete="off" spellcheck="false">
    <button class="primary" data-token-go>Open dashboard</button>
    <p class="err" data-err></p>
  </div>

  <div data-dash hidden>
    <div class="controls">
      <button data-refresh>Refresh now</button>
      <label><input type="checkbox" data-auto> auto-refresh every 60s</label>
      <button data-mark-review>Mark all reviewed</button>
      <button class="undo" data-undo-review hidden>Undo mark reviewed</button>
      <button class="right" data-logout>Forget token</button>
    </div>

    <section class="sec first">
      <h2>How many people <span class="qual mono" data-reach-qual></span></h2>
      <p class="lead">The closest honest answer to "how many people use this". Each tile says what it counts <em>and</em> what it cannot — three of the four are machine-side, so the tile that means <em>humans</em> is the first.</p>
      <div class="reach" data-reach></div>
      <p class="note" data-reach-note></p>
    </section>

    <section class="sec">
      <h2>Momentum <span class="qual mono">last 7 days vs the 7 before — direction, not totals</span></h2>
      <p class="lead">Computed inside each source's own daily series, so both halves cover an equal window. These are machine counters; read them for <em>shape</em> and the humans below for truth.</p>
      <div class="mom" data-momentum></div>
      <p class="note" data-momentum-note></p>
    </section>

    <section class="sec">
      <h2>Since you last looked</h2>
      <div class="since" data-since></div>
    </section>

    <section class="sec">
      <h2>Waiting on you</h2>
      <p class="lead">Open issues and PRs opened by someone other than you, oldest first. Closing the loop <em>is</em> the work.</p>
      <div data-todo></div>
    </section>

    <section class="sec">
      <h2>The humans <span class="qual mono" data-people-qual></span></h2>
      <p class="lead">Everyone outside you who filed an issue, opened a PR, or forked — ranked by how recently they showed up, not alphabetically.</p>
      <div data-people></div>
    </section>

    <section class="sec">
      <h2>Every human event <span class="qual mono" data-feed-qual></span></h2>
      <p class="lead">The one place the conversation lives. Titles link straight into the thread; this page deliberately does not paraphrase the sentiment (see "Not instrumented yet").</p>
      <div data-feed></div>
    </section>

    <section class="sec">
      <h2>Where they arrived from <span class="qual mono">rolling 14 days</span></h2>
      <div class="tbl-scroll"><table class="adm" data-referrers></table></div>
      <p class="note" data-referrers-note></p>
    </section>

    <section class="sec">
      <h2>Not instrumented yet</h2>
      <p class="lead">Things this page genuinely cannot see — listed rather than estimated. A dashboard that fills a gap with a plausible number is worse than one that admits it.</p>
      <ul class="gaps" data-gaps></ul>
    </section>

    <section class="sec">
      <h2>Doors</h2>
      <p class="doors" data-doors></p>
    </section>
  </div>

  <footer class="foot mono">maintainer-only · 127.0.0.1 · deliberate GitHub/npm egress · the credential never reaches this page</footer>
</main>
<script type="module">${modelSrc}
${viewSrc}</script>
</body>
</html>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────
// Reproduced from scratch in the reference's visual language (RuvNet Brain
// "amber substrate"): a graphite substrate lit by an amber mind, cyan signal,
// green "grounded" — editorial serif display, humanist body, technical mono.
// Self-contained: system font stacks only, NO external fonts (AC-5).
const CSS = `
:root{
  color-scheme:dark;
  --bg:#0a0c10; --bg-2:#0e1116; --surface:#13171e; --ridge:#2a3140;
  --ink:#ece8dc; --ink-2:#c3c2b6; --muted:#8b8f9c; --faint:#5a5f6e; --on-accent:#0a0c10;
  --accent:#f0a830; --accent-2:#5ad6ff; --accent-3:#5fd38a; --bad:#ff6b5e;
  --display:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
  --sans:system-ui,-apple-system,"Segoe UI","Helvetica Neue",sans-serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,"Cascadia Code",monospace;
  --spectrum:linear-gradient(96deg,#f0a830 0%,#ffce6a 22%,#5ad6ff 55%,#5fd38a 100%);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;min-height:100vh;overflow-x:hidden}
.mono{font-family:var(--mono)}
.wrap{max-width:1120px;margin:0 auto;padding:44px clamp(16px,4vw,28px) 90px}
.head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:8px}
.head h1{font-family:var(--display);font-weight:600;font-size:1.9rem;letter-spacing:-.012em;color:var(--ink);margin:0}
.head::after{content:"";flex-basis:100%;height:2px;background:var(--spectrum);opacity:.9;border-radius:2px;margin-top:6px}
.stamp{font-size:12px;color:var(--faint)}
.sub{color:var(--muted);font-size:14px;margin:14px 0 26px;max-width:80ch}

.gate{max-width:460px;background:var(--surface);border:1px solid var(--ridge);border-radius:12px;padding:26px 28px}
.gate p{font-size:14px;color:var(--ink-2);margin:0 0 14px}
.gate code{font-family:var(--mono);color:var(--accent);font-size:12.5px}
.gate input{width:100%;background:var(--bg-2);border:1px solid var(--ridge);border-radius:10px;color:var(--ink);font-family:var(--mono);font-size:14px;padding:10px 12px;margin-bottom:12px}
.gate input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.err{color:var(--bad);font-size:13.5px;margin:10px 0 0;min-height:1.2em}
button{cursor:pointer;background:var(--surface);color:var(--ink);border:1px solid var(--ridge);border-radius:8px;font-family:var(--mono);font-size:12.5px;padding:6px 14px}
button:hover{border-color:var(--accent)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.primary{background:var(--accent);color:var(--on-accent);border:0;border-radius:10px;font-weight:700;font-size:14px;padding:10px 18px;font-family:var(--sans)}
.controls{display:flex;align-items:center;gap:12px;margin-bottom:24px;font-family:var(--mono);font-size:12.5px;color:var(--muted);flex-wrap:wrap}
.controls label{display:flex;align-items:center;gap:6px;cursor:pointer}
.controls .undo{border-color:color-mix(in srgb,var(--accent) 50%,transparent);color:var(--accent)}
.controls .right{margin-left:auto}

.sec{margin-top:38px}
.sec.first{margin-top:8px}
.sec h2{font-family:var(--display);font-weight:600;font-size:1.25rem;color:var(--ink);margin:0 0 4px}
.sec h2 .qual{font-size:11px;color:var(--faint);font-weight:400;letter-spacing:.03em}
.sec .lead{font-size:13px;color:var(--muted);margin:0 0 12px;max-width:80ch}
.sec .note{font-size:12.5px;color:var(--faint);margin:12px 0 0;max-width:80ch;line-height:1.55}
.sec .lead em,.sub em{color:var(--ink-2);font-style:italic}

.reach{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px}
.rcell{border:1px solid var(--ridge);border-radius:12px;padding:16px 18px;background:var(--surface);min-width:0}
.rcell.hero{border-color:color-mix(in srgb,var(--accent-3) 55%,var(--ridge))}
.rcell b{display:block;font-family:var(--display);font-weight:600;font-size:32px;line-height:1.05;color:var(--ink)}
.rcell.hero b{color:var(--accent-3)}
.rcell.unknown b{color:var(--faint);font-size:22px}
.rcell .lbl{display:block;margin-top:6px;font-family:var(--mono);font-size:11.5px;letter-spacing:.03em;color:var(--ink-2);line-height:1.4}
.rcell .win{display:block;margin-top:3px;font-family:var(--mono);font-size:10.5px;color:var(--faint)}
.rcell .caveat{display:block;margin-top:9px;padding-top:9px;border-top:1px solid var(--ridge);font-size:11.5px;color:var(--muted);line-height:1.5}

.mom{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}
.mcell{border:1px solid var(--ridge);border-radius:12px;padding:15px 17px;background:var(--surface);min-width:0}
.mcell .top{display:flex;align-items:baseline;gap:8px}
.mcell .top b{font-family:var(--display);font-weight:600;font-size:25px;color:var(--ink);line-height:1.1}
.mcell .arrow{font-family:var(--mono);font-size:12px}
.mcell .arrow.up{color:var(--accent-3)} .mcell .arrow.down{color:var(--bad)} .mcell .arrow.flat{color:var(--faint)}
.mcell span{display:block;margin-top:5px;font-family:var(--mono);font-size:11px;letter-spacing:.03em;color:var(--muted);line-height:1.4}
.mcell .faint{color:var(--faint)}
.mcell svg{display:block;width:100%;height:30px;margin-top:9px}
.mcell.unknown b{color:var(--faint);font-size:20px}

.since{background:var(--surface);border:1px solid var(--ridge);border-radius:14px;padding:22px 24px}
.since .headline{font-family:var(--display);font-weight:600;font-size:1.25rem;color:var(--ink);margin:0 0 6px;line-height:1.34}
.since .headline b{color:var(--accent)}
.since .headline .flat{color:var(--muted)}
.since-when{font-family:var(--mono);font-size:11.5px;color:var(--faint);margin:0 0 18px}
.since-foot{font-size:12.5px;color:var(--faint);margin:14px 0 0;max-width:80ch;line-height:1.55}
.dstrip{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.dcell{border:1px solid var(--ridge);border-radius:10px;padding:13px 15px;background:var(--bg-2);min-width:0}
.dcell b{display:block;font-family:var(--display);font-weight:600;font-size:24px;line-height:1.1;color:var(--muted)}
.dcell.up b{color:var(--accent-3)} .dcell.down b{color:var(--bad)}
.dcell.unknown b{color:var(--faint);font-size:20px}
.dcell span{display:block;margin-top:5px;font-family:var(--mono);font-size:10.5px;letter-spacing:.03em;color:var(--muted);line-height:1.4}
.dcell em{display:block;margin-top:4px;font-style:normal;font-family:var(--mono);font-size:10px;color:var(--faint)}

.todo,.tl{border:1px solid var(--ridge);border-radius:12px;background:var(--surface);overflow:hidden;margin-top:12px}
.todo-row{display:flex;gap:14px;align-items:baseline;padding:13px 16px;border-bottom:1px solid var(--ridge)}
.todo-row:last-child{border-bottom:none}
.todo-row .age{font-family:var(--mono);font-size:11.5px;color:var(--bad);white-space:nowrap;min-width:74px}
.todo-row .age.fresh{color:var(--accent)}
.todo-row .body{min-width:0;flex:1}
.todo-row .body a{color:var(--accent-2);text-decoration:none;font-size:14px}
.todo-row .body a:hover{text-decoration:underline}
.todo-row .body .by{display:block;margin-top:3px;font-family:var(--mono);font-size:11px;color:var(--faint)}
.inbox-zero{border:1px solid color-mix(in srgb,var(--accent-3) 40%,var(--ridge));border-radius:12px;background:var(--surface);padding:18px 20px;margin-top:12px;font-size:14px;color:var(--ink-2)}
.inbox-zero.ridge{border-color:var(--ridge)}
.inbox-zero b{color:var(--accent-3)}

.ppl{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.pcard{border:1px solid var(--ridge);border-radius:12px;padding:15px 17px;background:var(--surface)}
.pcard.active{border-color:color-mix(in srgb,var(--accent-3) 55%,var(--ridge))}
.pcard .who{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pcard .who a{font-family:var(--display);font-weight:600;font-size:1.05rem;color:var(--accent-2);text-decoration:none}
.pcard .span{margin:9px 0 0;font-family:var(--mono);font-size:11px;color:var(--faint);line-height:1.5}
.badge{font-family:var(--mono);font-size:10.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--ridge);color:var(--muted);white-space:nowrap}
.badge.live{background:color-mix(in srgb,var(--accent-3) 15%,transparent);border-color:var(--accent-3);color:var(--accent-3)}
.badge.new{background:color-mix(in srgb,var(--accent) 16%,transparent);border-color:var(--accent);color:var(--accent)}
.badge.open{border-color:var(--accent);color:var(--accent)}
.note{color:var(--faint);font-size:12px}

.tl-row{display:flex;gap:13px;align-items:baseline;padding:11px 16px;border-bottom:1px solid var(--ridge);font-size:13.5px}
.tl-row:last-child{border-bottom:none}
.tl-row.is-new{background:color-mix(in srgb,var(--accent) 7%,transparent)}
.tl-row .when{font-family:var(--mono);font-size:11.5px;color:var(--faint);white-space:nowrap;min-width:82px}
.tl-row .kind{font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:nowrap;min-width:34px}
.tl-row .what{min-width:0;flex:1;color:var(--ink-2);line-height:1.45}
.tl-row .what a{color:var(--accent-2);text-decoration:none}
.tl-row .what a:hover{text-decoration:underline}
.tl-row .what .who{font-family:var(--mono);font-size:11px;color:var(--faint)}
.more-btn{cursor:pointer;background:none;border:0;color:var(--accent-2);font-family:var(--mono);font-size:12px;padding:11px 16px}
.more-btn:hover{color:var(--ink)}

.tbl-scroll{overflow-x:auto;border:1px solid var(--ridge);border-radius:12px;background:var(--surface);margin-top:12px}
table.adm{width:100%;border-collapse:collapse;font-size:13.5px}
table.adm th{text-align:left;font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);padding:12px 14px;border-bottom:1px solid var(--ridge)}
table.adm td{padding:10px 14px;border-bottom:1px solid var(--ridge);color:var(--ink-2);vertical-align:top}
table.adm tr:last-child td{border-bottom:none}
table.adm td.num{font-family:var(--mono)}

.gaps{border:1px dashed var(--ridge);border-radius:12px;background:var(--bg-2);padding:6px 20px;margin-top:12px}
.gaps li{list-style:none;padding:13px 0;border-bottom:1px solid var(--ridge);font-size:13.5px;color:var(--ink-2);line-height:1.55}
.gaps li:last-child{border-bottom:none}
.gaps li b{color:var(--ink);font-weight:500}
.gaps li .fix{display:block;margin-top:4px;font-family:var(--mono);font-size:11.5px;color:var(--faint)}
.gaps li .tag{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.07em;padding:2px 7px;border-radius:4px;margin-right:8px;border:1px solid var(--ridge);color:var(--muted)}
.gaps li .tag.config{border-color:color-mix(in srgb,var(--accent) 50%,transparent);color:var(--accent)}
.gaps li .tag.code{border-color:color-mix(in srgb,var(--accent-2) 50%,transparent);color:var(--accent-2)}
.gaps li .tag.design{border-color:color-mix(in srgb,var(--accent-3) 50%,transparent);color:var(--accent-3)}

.doors{font-size:14px;color:var(--ink-2);background:var(--surface);border:1px solid var(--ridge);border-radius:12px;padding:16px 20px;margin-top:12px}
.doors a{color:var(--accent-2)}
.foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--ridge);color:var(--faint);font-size:11.5px}

@media (max-width:880px){
  .dstrip,.mom,.reach{grid-template-columns:1fr 1fr}
  .ppl{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
