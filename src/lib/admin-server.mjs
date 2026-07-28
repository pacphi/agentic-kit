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
import { ADMIN_CSS } from './admin-styles.mjs';
import { ADMIN_THEME_JS } from './admin-theme.mjs';

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
  "script-src 'unsafe-inline'",   // the one inline module (theme+model+view)
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
  // source (theme + model + view + CSS) is interpolated — no third-party data reaches the
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
// interpolated: `${ADMIN_CSS}` (the style), theme + model + view (the one
// module scope). The client fetches /api/admin-stats and renders live.
//
// Layout: the dashboard's sticky segmented control (ADR-0005) splits the panel
// into five views — Overview (reach + momentum), Review (since you last looked +
// waiting on you), Humans, Activity (feed + referrers), Gaps — so each view fits
// a viewport instead of one long scroll. Attention never hides behind a tab:
// Review/Humans/Activity carry count badges when something needs eyes. ─────────
function renderPage({ modelSrc, viewSrc }) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark light">
<title>agentic-kit · admin</title>
<style>${ADMIN_CSS}</style>
</head>
<body>
<main class="wrap">
  <div class="head">
    <div class="mark" aria-hidden="true"></div>
    <h1>agentic-kit — admin</h1>
    <span class="stamp mono" data-stamp></span>
    <button class="theme-toggle" data-theme-toggle type="button" aria-label="switch to light theme" title="toggle theme">☾</button>
  </div>

  <div class="gate" data-gate>
    <p>What moved since you last looked, who moved it, and what is waiting on you. Every number is read live from GitHub or npm — nothing here is stored, assumed, or estimated.</p>
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

    <nav class="tabbar">
      <div class="seg" role="tablist" aria-label="admin sections" data-seg>
        <span class="seg-thumb" data-seg-thumb aria-hidden="true"></span>
        <button class="seg-btn" role="tab" id="tab-overview" data-tab="overview" aria-selected="true" aria-controls="panel-overview" type="button">Overview</button>
        <button class="seg-btn" role="tab" id="tab-review" data-tab="review" aria-selected="false" aria-controls="panel-review" type="button">Review<span class="tbadge" data-badge="review" hidden></span></button>
        <button class="seg-btn" role="tab" id="tab-humans" data-tab="humans" aria-selected="false" aria-controls="panel-humans" type="button">Humans<span class="tbadge" data-badge="humans" hidden></span></button>
        <button class="seg-btn" role="tab" id="tab-activity" data-tab="activity" aria-selected="false" aria-controls="panel-activity" type="button">Activity<span class="tbadge" data-badge="activity" hidden></span></button>
        <button class="seg-btn" role="tab" id="tab-gaps" data-tab="gaps" aria-selected="false" aria-controls="panel-gaps" type="button">Gaps</button>
      </div>
    </nav>

    <section class="panel" id="panel-overview" data-panel="overview" role="tabpanel" aria-labelledby="tab-overview">
      <section class="sec first">
        <h2>How many people <span class="qual mono" data-reach-qual></span></h2>
        <p class="lead">The closest honest answer to "how many people use this". Each tile says what it counts <em>and</em> what it cannot — three of the four are machine-side, so the tile that means <em>humans</em> is the first.</p>
        <div class="reach" data-reach></div>
        <p class="note" data-reach-note></p>
      </section>

      <section class="sec">
        <h2>Momentum <span class="qual mono">last 7 days vs the 7 before — direction, not totals</span></h2>
        <p class="lead">Computed inside each source's own daily series, so both halves cover an equal window. These are machine counters; read them for <em>shape</em> and the humans in their tab for truth.</p>
        <div class="mom" data-momentum></div>
        <p class="note" data-momentum-note></p>
      </section>
    </section>

    <section class="panel" id="panel-review" data-panel="review" role="tabpanel" aria-labelledby="tab-review" hidden>
      <section class="sec first">
        <h2>Since you last looked</h2>
        <div class="since" data-since></div>
      </section>

      <section class="sec">
        <h2>Waiting on you</h2>
        <p class="lead">Open issues and PRs opened by someone other than you, oldest first. Closing the loop <em>is</em> the work.</p>
        <div data-todo></div>
      </section>
    </section>

    <section class="panel" id="panel-humans" data-panel="humans" role="tabpanel" aria-labelledby="tab-humans" hidden>
      <section class="sec first">
        <h2>The humans <span class="qual mono" data-people-qual></span></h2>
        <p class="lead">Everyone outside you who filed an issue, opened a PR, or forked — ranked by how recently they showed up, not alphabetically.</p>
        <div data-people></div>
      </section>
    </section>

    <section class="panel" id="panel-activity" data-panel="activity" role="tabpanel" aria-labelledby="tab-activity" hidden>
      <section class="sec first">
        <h2>Every human event <span class="qual mono" data-feed-qual></span></h2>
        <p class="lead">The one place the conversation lives. Titles link straight into the thread; this page deliberately does not paraphrase the sentiment (see the Gaps tab).</p>
        <div data-feed></div>
      </section>

      <section class="sec">
        <h2>Where they arrived from <span class="qual mono">rolling 14 days</span></h2>
        <div class="tbl-scroll"><table class="adm" data-referrers></table></div>
        <p class="note" data-referrers-note></p>
      </section>
    </section>

    <section class="panel" id="panel-gaps" data-panel="gaps" role="tabpanel" aria-labelledby="tab-gaps" hidden>
      <section class="sec first">
        <h2>Not instrumented yet</h2>
        <p class="lead">Things this page genuinely cannot see — listed rather than estimated. A dashboard that fills a gap with a plausible number is worse than one that admits it.</p>
        <ul class="gaps" data-gaps></ul>
      </section>

      <section class="sec">
        <h2>Doors</h2>
        <p class="doors" data-doors></p>
      </section>
    </section>
  </div>

  <footer class="foot mono">maintainer-only · 127.0.0.1 · deliberate GitHub/npm egress · the credential never reaches this page</footer>
</main>
<script type="module">${ADMIN_THEME_JS}
${modelSrc}
${viewSrc}</script>
</body>
</html>`;
}
