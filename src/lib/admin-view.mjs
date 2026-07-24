// admin-view.mjs — the browser controller for `ak x admin`.
//
// Adapted from the RuvNet Brain explainer admin (stuinfla/ruvnet-brain
// explainer/admin.js, MIT © 2026 Stuart Kerr / Isovision.ai) — the DOM/fetch/event
// half, with every number-shaping decision delegated to admin-model.mjs so the
// tested code is the shipped code (ADR-0007 §5).
//
// This file is NEVER node-imported. admin-server.mjs reads it as text, STRIPS the
// single model-import line below, and concatenates it after the model source into
// one inline `<script type="module">` scope — so on the page `esc`, `shape`, etc.
// are already in scope. On disk the import keeps the file `node --check`/eslint
// clean and makes the dependency explicit.
import { esc, safeUrl, metric, ascend, momentum, daysAgo, agoLabel, shape, snapshot, cumDelta } from './admin-model.mjs';

const TOKEN_STORE = 'ak-admin-token';
const BASE_STORE = 'ak-admin-baseline';
const BASE_PREV = 'ak-admin-baseline-prev';
const FEED_STEP = 25;

const $ = (s) => document.querySelector(s);
const num = (v) => Number(v).toLocaleString();

let LAST = null;
let feedShown = FEED_STEP;
let autoTimer = null;

// ── token bootstrap (FR-3): fragment → localStorage, then strip ────────────────
// The fragment is never sent to the server, never logged, never proxied. We lift
// it into localStorage, wipe it from the address bar, and thereafter send it ONLY
// as the x-admin-token header — no query-param fallback anywhere.
function bootToken() {
  const m = String(location.hash || '').match(/token=([A-Za-z0-9_-]+)/);
  if (m) {
    try { localStorage.setItem(TOKEN_STORE, m[1]); } catch { /* private mode */ }
    try { history.replaceState(null, '', location.pathname); } catch { /* older browsers */ }
  }
  try { return localStorage.getItem(TOKEN_STORE) || ''; } catch { return ''; }
}
const savedToken = () => { try { return localStorage.getItem(TOKEN_STORE) || ''; } catch { return ''; } };

function showGate() { $('[data-gate]').hidden = false; $('[data-dash]').hidden = true; }
function showError(msg) { $('[data-err]').textContent = msg; }
function clearError() { $('[data-err]').textContent = ''; }

function readBaseline() {
  try { return JSON.parse(localStorage.getItem(BASE_STORE) || 'null'); } catch { return null; }
}

// ── tiny presentation helpers (SVG sparkline, delta cell) ─────────────────────
function sparkline(series, stroke) {
  if (!Array.isArray(series) || series.length < 2) return '';
  const max = Math.max.apply(null, series.concat([1]));
  const w = 120, h = 30;
  const pts = series.map((v, i) => (i * (w / (series.length - 1))).toFixed(1) + ',' + (h - 2 - (v / max) * (h - 6)).toFixed(1)).join(' ');
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">'
    + '<polyline points="' + pts + '" fill="none" stroke="' + stroke + '" stroke-width="1.5" /></svg>';
}

function dcell(label, delta, footnote) {
  if (!delta.known) {
    return '<div class="dcell unknown"><b>—</b><span>' + esc(label) + '</span><em>' + esc(delta.why) + '</em></div>';
  }
  const cls = delta.v > 0 ? 'up' : delta.v < 0 ? 'down' : '';
  const txt = delta.v > 0 ? '+' + num(delta.v) : delta.v < 0 ? '−' + num(Math.abs(delta.v)) : 'no change';
  return '<div class="dcell ' + cls + '"><b>' + txt + '</b><span>' + esc(label) + '</span>'
    + (footnote ? '<em>' + esc(footnote) + '</em>' : '') + '</div>';
}

// ── reach: four headline tiles, each carrying its own caveat as structure ─────
function rcell(o) {
  if (!o.value.known) {
    return '<div class="rcell unknown"><b>—</b><span class="lbl">' + esc(o.label) + '</span>'
      + '<span class="win">' + esc(o.value.why) + '</span><span class="caveat">' + esc(o.caveat) + '</span></div>';
  }
  return '<div class="rcell' + (o.hero ? ' hero' : '') + '"><b>' + num(o.value.v) + '</b>'
    + '<span class="lbl">' + esc(o.label) + '</span><span class="win">' + esc(o.window) + '</span>'
    + '<span class="caveat">' + esc(o.caveat) + '</span></div>';
}

function renderReach(d) {
  const t = d.traffic || {};
  const trafficWhy = t.configured ? 'no data in the current 14-day window' : 'no GitHub token — traffic API needs push access';
  const rels = Array.isArray(d.releases) ? d.releases : [];
  const newest = rels.filter((r) => r.assets && r.assets.length)[0] || null;
  const newestDl = newest ? newest.assets.reduce((n, a) => n + (a.downloads || 0), 0) : null;

  $('[data-reach]').innerHTML = [
    rcell({ hero: true, label: 'unique repo visitors', window: 'rolling 14 days · github.com',
      value: metric(t.views && t.views.uniques, trafficWhy),
      caveat: 'The only tile here that counts PEOPLE. GitHub de-duplicates by visitor — humans who opened the repo, not machines or CI.' }),
    rcell({ label: 'bundle downloads', window: 'lifetime, all releases',
      value: metric(d.totalAssetDownloads, 'no release data returned'),
      caveat: 'Downloads, NOT people — GitHub exposes no unique-downloader field for assets. One machine can count many times.' }),
    rcell({ label: newest ? 'pulled ' + newest.tag : 'newest release pulls', window: newest ? 'since ' + String(newest.publishedAt || '').slice(0, 10) : 'no published release found',
      value: metric(newestDl, 'no assets on the newest release'),
      caveat: 'The closest read on the ACTIVE installed base: every live machine pulls the current bundle once. An estimate of machines.' }),
    rcell({ label: 'opted-in installs', window: 'lifetime · consenting machines only',
      value: metric(null, 'ak ships no opt-in counter — an honest gap, not a zero'),
      caveat: 'ak has no telemetry to count this. It renders "—" on purpose; see "Not instrumented yet" below.' }),
  ].join('');

  const stars = d.repo ? d.repo.stars : null;
  $('[data-reach-qual]').textContent = Number.isFinite(Number(stars))
    ? '★ ' + num(stars) + ' stars · ' + num((d.repo && d.repo.forks) || 0) + ' forks'
    : 'repo metadata unavailable';
  $('[data-reach-note]').textContent = 'No counter here is a headcount, and the gap between them is the point: visitors are people, '
    + 'bundle pulls are machines. npm downloads are excluded from this row — mirrors dominate them — and appear only in Momentum, as shape.';
}

// ── momentum: 7d vs prior 7d inside each source's own series ───────────────────
function mcell(label, mom, stroke, unknownWhy) {
  if (!mom) {
    return '<div class="mcell unknown"><div class="top"><b>—</b></div><span>' + esc(label) + '</span>'
      + '<span class="faint">' + esc(unknownWhy || 'not enough daily history to compare') + '</span></div>';
  }
  const arrow = mom.dir === 'up' ? '▲' : mom.dir === 'down' ? '▼' : '▬';
  const pct = mom.pct == null ? '' : (mom.pct > 0 ? '+' : '') + mom.pct + '%';
  return '<div class="mcell"><div class="top"><b>' + num(mom.recent) + '</b>'
    + '<span class="arrow ' + mom.dir + '">' + arrow + ' ' + esc(pct) + '</span></div>'
    + '<span>' + esc(label) + '<br>' + num(mom.prior) + ' in the prior 7d</span>'
    + sparkline(mom.series, stroke) + '</div>';
}

function renderMomentum(d) {
  const t = d.traffic || {};
  const trafficWhy = t.configured ? 'no data in the current 14-day window' : 'no GitHub token — traffic API needs push access';
  const viewSeries = t.views ? ascend(t.views.daily, 'timestamp', 'uniques') : null;
  const cloneSeries = t.clones ? ascend(t.clones.daily, 'timestamp', 'uniques') : null;
  const npmSeries = d.npm ? ascend(d.npm.daily, 'day', 'downloads') : null;
  // Ordered nearest-to-a-human first; npm last with its mirror caveat.
  $('[data-momentum]').innerHTML = [
    mcell('unique repo visitors, last 7d', momentum(viewSeries), 'var(--accent-2)', trafficWhy),
    mcell('unique cloners, last 7d', momentum(cloneSeries), 'var(--accent-2)', trafficWhy),
    mcell('npm downloads, last 7d', momentum(npmSeries), 'var(--accent-3)', 'npm range unavailable'),
  ].join('');
  $('[data-momentum-note]').textContent = 'Left to right, each tile sits further from a human. Unique visitors are people; cloners are machines '
    + '(ak\'s own CI among them); npm downloads are dominated by mirrors and move with release cadence, not adoption — its last day is partial.';
}

// ── since you last looked: cumulative deltas only (Rule 2) ────────────────────
function renderSince(d, s, base) {
  const box = $('[data-since]');
  const firstVisit = !base;
  const newIds = firstVisit ? [] : s.events.filter((e) => base.ids.indexOf(e.id) === -1);
  const newPeople = firstVisit ? [] : s.people.filter((p) => base.people.indexOf(p.login) === -1);

  let headline, when;
  if (firstVisit) {
    headline = '<span class="flat">First visit — baseline captured just now.</span> Deltas start next visit; everything below is live regardless.';
    when = 'no prior snapshot on this browser';
  } else if (newIds.length || newPeople.length) {
    const bits = [];
    if (newPeople.length) bits.push('<b>' + newPeople.length + ' new ' + (newPeople.length === 1 ? 'person' : 'people') + '</b>');
    if (newIds.length) bits.push('<b>' + newIds.length + ' new ' + (newIds.length === 1 ? 'thread' : 'threads') + '</b>');
    headline = bits.join(' and ') + ' since you last looked'
      + (newPeople.length ? ' — ' + newPeople.slice(0, 4).map((p) => '@' + esc(p.login)).join(', ') + '.' : '.');
    when = 'baseline: ' + esc(base.at.slice(0, 16).replace('T', ' ')) + ' UTC · ' + agoLabel(base.at);
  } else {
    headline = '<span class="flat">No new people or threads since you last looked.</span> Counter movement, if any, is below.';
    when = 'baseline: ' + esc(base.at.slice(0, 16).replace('T', ' ')) + ' UTC · ' + agoLabel(base.at);
  }

  const cells = [
    dcell('new threads (issues + PRs)', firstVisit ? { known: false, why: 'first visit — baseline captured now' } : { known: true, v: newIds.length }),
    dcell('GitHub stars', cumDelta(d.repo && d.repo.stars, base && base.stars, 'repo metadata unavailable', firstVisit), d.repo ? num(d.repo.stars) + ' total' : ''),
    dcell('forks', cumDelta(d.repo && d.repo.forks, base && base.forks, 'repo metadata unavailable', firstVisit), d.repo ? num(d.repo.forks) + ' total' : ''),
    dcell('release bundle downloads', cumDelta(d.totalAssetDownloads, base && base.downloads, 'no release data returned', firstVisit), d.totalAssetDownloads == null ? '' : num(d.totalAssetDownloads) + ' lifetime'),
    dcell('new humans engaged', firstVisit ? { known: false, why: 'first visit — baseline captured now' } : { known: true, v: newPeople.length }),
  ];

  box.innerHTML = '<p class="headline">' + headline + '</p><p class="since-when">' + when + '</p>'
    + '<div class="dstrip">' + cells.join('') + '</div>'
    + '<p class="since-foot">Only cumulative counters appear above. Rolling 14-day and 7-day windows (clones, views, npm) live in Momentum — '
    + 'subtracting two readings of a rolling window compares two different time spans, so it can fall while the project grows.</p>';
  return { newIds: newIds.map((e) => e.id), firstVisit };
}

function renderTodo(s) {
  const host = $('[data-todo]');
  if (!s.openItems.length) {
    host.innerHTML = s.threadCount
      ? '<div class="inbox-zero"><b>Nothing open from anyone outside you.</b> All ' + s.threadCount + ' external threads are closed — read from the live issue list, not a placeholder.</div>'
      : '<div class="inbox-zero ridge">No one outside you has opened an issue or PR yet, so there is nothing waiting. Not a cleared queue — an empty one.</div>';
    return;
  }
  host.innerHTML = '<div class="todo">' + s.openItems.map((it) => {
    const age = daysAgo(it.at);
    const cls = age != null && age > 3 ? '' : 'fresh';
    return '<div class="todo-row"><span class="age ' + cls + '">' + esc(age == null ? '—' : age + 'd open') + '</span>'
      + '<span class="body"><a href="' + safeUrl(it.url) + '" target="_blank" rel="noopener">'
      + (it.isPR ? 'PR ' : '#') + esc(it.number) + ' — ' + esc(it.title) + '</a>'
      + '<span class="by">@' + esc(it.login) + ' · opened ' + esc(it.at) + '</span></span></div>';
  }).join('') + '</div>';
}

function renderPeople(d, s, base) {
  const host = $('[data-people]');
  const qual = $('[data-people-qual]');
  const known = s.people.length;
  const stars = d.repo ? d.repo.stars : null;
  const namedStars = (d.people && d.people.stargazers) || [];
  let starNote = '';
  if (Number.isFinite(Number(stars)) && Number(stars) > 0 && namedStars.length === 0) {
    starNote = num(stars) + ' stars exist, but GitHub returns the stargazer list only to an authenticated caller — set GITHUB_TOKEN to see who. '
      + 'Their absence here is a missing credential, not a missing person.';
  } else if (namedStars.length) {
    // Built UNESCAPED — the sink esc()'s the whole starNote once (single-escape at
    // the sink, the house rule; the logins were being double-escaped otherwise).
    starNote = 'Plus ' + namedStars.length + ' stargazer' + (namedStars.length === 1 ? '' : 's') + ' with no dated activity: '
      + namedStars.slice(0, 20).map((l) => '@' + l).join(', ') + '.';
  }
  qual.textContent = known + ' named · bots excluded' + (s.botItems ? ' (' + s.botItems + ' bot items hidden)' : '');
  if (!known) {
    host.innerHTML = '<div class="inbox-zero ridge">No external humans have filed an issue, opened a PR, or forked yet.' + (starNote ? ' ' + esc(starNote) : '') + '</div>';
    return;
  }
  host.innerHTML = '<div class="ppl">' + s.people.map((p) => {
    const recent = p.last && daysAgo(p.last) != null && daysAgo(p.last) <= 7;
    const isNew = base && base.people.indexOf(p.login) === -1;
    let badges = '';
    if (isNew) badges += '<span class="badge new">new</span>';
    if (recent) badges += '<span class="badge live">active this week</span>';
    if (p.open) badges += '<span class="badge open">' + p.open + ' open</span>';
    if (p.association && p.association !== 'NONE') badges += '<span class="badge">' + esc(String(p.association).toLowerCase()) + '</span>';
    const counts = [];
    if (p.issues) counts.push(p.issues + ' issue' + (p.issues === 1 ? '' : 's'));
    if (p.prs) counts.push(p.prs + ' PR' + (p.prs === 1 ? '' : 's'));
    if (p.forked) counts.push('forked');
    return '<div class="pcard' + (recent ? ' active' : '') + '"><div class="who"><a href="https://github.com/' + esc(p.login) + '" target="_blank" rel="noopener">@' + esc(p.login) + '</a>' + badges + '</div>'
      + '<p class="span">' + esc(counts.join(' · ') || 'engaged') + '<br>last seen ' + esc(agoLabel(p.last)) + ' · first seen ' + esc(agoLabel(p.first)) + '</p></div>';
  }).join('') + '</div>' + (starNote ? '<p class="note">' + esc(starNote) + '</p>' : '');
}

function renderFeed(s, newIds) {
  const host = $('[data-feed]');
  const qual = $('[data-feed-qual]');
  qual.textContent = s.events.length + ' dated events';
  if (!s.events.length) { host.innerHTML = '<div class="inbox-zero ridge">No dated human events yet.</div>'; return; }
  const slice = s.events.slice(0, feedShown);
  const rows = slice.map((e) => {
    const fresh = newIds.indexOf(e.id) !== -1;
    const link = e.kind === 'fork'
      ? '<a href="' + safeUrl(e.url) + '" target="_blank" rel="noopener">@' + esc(e.login) + '</a> forked the repo'
      : '<a href="' + safeUrl(e.url) + '" target="_blank" rel="noopener">' + esc(e.title) + '</a> <span class="who">@' + esc(e.login) + (e.state ? ' · ' + esc(e.state) : '') + '</span>';
    return '<div class="tl-row' + (fresh ? ' is-new' : '') + '"><span class="when">' + esc(e.at || '—') + '</span>'
      + '<span class="kind">' + esc(e.kind) + '</span><span class="what">' + (fresh ? '<span class="badge new">new</span> ' : '') + link + '</span></div>';
  }).join('');
  const more = s.events.length > feedShown
    ? '<button class="more-btn" data-feed-more>Show ' + Math.min(FEED_STEP, s.events.length - feedShown) + ' older →</button>'
    : (feedShown > FEED_STEP ? '<button class="more-btn" data-feed-less>← Collapse back to ' + FEED_STEP + '</button>' : '');
  host.innerHTML = '<div class="tl">' + rows + more + '</div>';
}

function renderReferrers(d) {
  const t = d.traffic || {};
  if (Array.isArray(t.referrers) && t.referrers.length) {
    $('[data-referrers]').innerHTML = '<tr><th>referrer</th><th>views, 14d</th><th>uniques</th></tr>'
      + t.referrers.map((x) => '<tr><td>' + esc(x.referrer) + '</td><td class="num">' + num(x.count) + '</td><td class="num">' + num(x.uniques) + '</td></tr>').join('');
    $('[data-referrers-note]').textContent = 'GitHub "popular referrers" — where repo visitors arrived from.';
  } else {
    $('[data-referrers]').innerHTML = '<tr><td>' + esc(t.configured ? 'No referrer data in the current 14-day window.' : (t.note || 'No GitHub token — referrers need push access.')) + '</td></tr>';
    $('[data-referrers-note]').textContent = '';
  }
}

// The honesty section — three kinds of entry: config (fixable now) / code (not
// built) / design (kept on purpose). ak's real gaps, named rather than guessed.
function renderGaps(d) {
  const out = [];
  const t = d.traffic || {};
  if (!t.configured) out.push(['config', 'Clones, views, and referrers are dark.', 'No GITHUB_TOKEN / GH_TOKEN / gh auth token with push access resolved. Every traffic panel says so rather than showing 0.']);
  if (d.repo && d.repo.stars > 0 && !((d.people && d.people.stargazers) || []).length) out.push(['config', 'The ' + num(d.repo.stars) + ' stargazers are counted but unnamed.', 'GET /stargazers answers 401 without a token — the count is public, the list is not.']);
  out.push(['code', 'Opt-in install / search telemetry.', 'ak ships no phone-home counter, so "opted-in installs" reads "—". Building one is a code change, not a config toggle — hence a gap, never a fabricated zero.']);
  out.push(['code', 'The actual words people wrote.', 'The collector maps each thread to {number,title,state,isPR,url,at} and drops comment bodies, reactions, and sentiment. This page proves a conversation happened and links to it — it does not quote or score it.']);
  out.push(['code', 'GitHub Discussions activity.', 'The Discussions API is GraphQL-only; the collector speaks REST, so Discussions are linked but never read.']);
  out.push(['code', 'npm downloads split by version, and when each star happened.', 'api.npmjs.org returns one total per day; the stargazers call omits starred_at, so stars cannot be placed on the timeline. Forks can, and are.']);
  out.push(['design', 'Any remote hosting of this page. Deliberate, and staying that way.', 'admin is loopback-only, foreground, per-session-token. It exists to reach GitHub/npm on your behalf — never to be reachable itself.']);
  const TAG = { config: 'fixable now', code: 'not built yet', design: 'by design' };
  $('[data-gaps]').innerHTML = out.map((g) => '<li><span class="tag ' + g[0] + '">' + TAG[g[0]] + '</span><b>' + esc(g[1]) + '</b><span class="fix">' + esc(g[2]) + '</span></li>').join('');
}

function renderDoors(d) {
  const f = d.feedback || {};
  $('[data-doors]').innerHTML = 'Feedback → <a href="' + safeUrl(f.discussions) + '" target="_blank" rel="noopener">GitHub Discussions</a> · '
    + 'bugs → <a href="' + safeUrl(f.issues) + '" target="_blank" rel="noopener">Issues</a>.';
}

// ── orchestration ─────────────────────────────────────────────────────────────
function render(d) {
  LAST = d;
  $('[data-gate]').hidden = true;
  $('[data-dash]').hidden = false;
  $('[data-stamp]').textContent = 'live read ' + String(d.generatedAt || '').slice(0, 19).replace('T', ' ') + ' UTC';
  const s = shape(d);
  const base = readBaseline();
  renderReach(d);
  const since = renderSince(d, s, base);
  renderTodo(s);
  renderPeople(d, s, base);
  renderFeed(s, since.newIds);
  renderMomentum(d);
  renderReferrers(d);
  renderGaps(d);
  renderDoors(d);
  // First visit ONLY: seed the baseline so the NEXT visit has an honest diff.
  // Never auto-advanced — that would consume the very deltas this page exists for.
  if (!base) { try { localStorage.setItem(BASE_STORE, JSON.stringify(snapshot(d, s))); } catch { /* private mode */ } }
  $('[data-undo-review]').hidden = !savedBaselinePrev();
}
function savedBaselinePrev() { try { return localStorage.getItem(BASE_PREV); } catch { return null; } }

async function load(token, opts) {
  const silent = opts && opts.silent;
  clearError();
  let r, j;
  try {
    r = await fetch('/api/admin-stats', { headers: { 'x-admin-token': token }, cache: 'no-store' });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    if (!silent) showError('Network error: ' + e.message);
    return;
  }
  if (!r.ok) {
    if (!silent) {
      showError(j.error || ('HTTP ' + r.status));
      try { localStorage.removeItem(TOKEN_STORE); } catch { /* private mode */ }
      showGate();
    }
    return;
  }
  try { localStorage.setItem(TOKEN_STORE, token); } catch { /* private mode */ }
  render(j);
}

// ── controls — each an executor + inverse (NFR-4.3, FR-6) ─────────────────────
function wire() {
  $('[data-token-go]').addEventListener('click', () => load($('[data-token-input]').value.trim()));
  $('[data-token-input]').addEventListener('keydown', (e) => { if (e.key === 'Enter') load($('[data-token-input]').value.trim()); });
  $('[data-refresh]').addEventListener('click', () => load(savedToken(), { silent: true }));
  $('[data-logout]').addEventListener('click', () => { try { localStorage.removeItem(TOKEN_STORE); } catch { /* private mode */ } location.reload(); });

  $('[data-mark-review]').addEventListener('click', () => {
    if (!LAST) return;
    try {
      const prev = localStorage.getItem(BASE_STORE);
      if (prev) localStorage.setItem(BASE_PREV, prev);         // stash for the inverse
      localStorage.setItem(BASE_STORE, JSON.stringify(snapshot(LAST, shape(LAST))));
    } catch { /* private mode */ }
    render(LAST);
  });
  $('[data-undo-review]').addEventListener('click', () => {
    let prev;
    try { prev = localStorage.getItem(BASE_PREV); } catch { prev = null; }
    if (!prev) return;
    try { localStorage.setItem(BASE_STORE, prev); localStorage.removeItem(BASE_PREV); } catch { /* private mode */ }
    if (LAST) render(LAST);
  });

  $('[data-auto]').addEventListener('change', (e) => {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (e.target.checked) autoTimer = setInterval(() => load(savedToken(), { silent: true }), 60000);
  });

  // Feed paging is its own undo (show more ⇄ collapse).
  document.addEventListener('click', (e) => {
    const el = e.target;
    if (!el || !el.getAttribute) return;
    if (el.hasAttribute('data-feed-more')) { feedShown += FEED_STEP; if (LAST) render(LAST); }
    if (el.hasAttribute('data-feed-less')) { feedShown = FEED_STEP; if (LAST) render(LAST); }
  });
}

wire();
const boot = bootToken();
if (boot) load(boot); else showGate();
