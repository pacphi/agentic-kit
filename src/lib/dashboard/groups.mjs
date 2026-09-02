// Pure status-row classification, grouping, and card/notice HTML for the
// dashboard. This module is the ONE source of truth for both consumers:
//   - node unit tests import it directly (deterministic, no DOM, no browser);
//   - the browser bundle in client.mjs interpolates these exact function
//     sources + JSON-serialized tables into the served <script>, so the tested
//     code and the shipped code can never drift.
// Every function must therefore stay SELF-CONTAINED: no imports, no module
// scope, no DOM — only parameters and the sibling names below.

/** HTML-escape any value rendered into the page, after REMOVING the control
 *  and bidi characters that escaping does not touch.
 *
 *  Security review SEC-9: `esc` replaced only [&<>"'], so a 24-character label
 *  carrying U+202E and a raw ESC cleared `isValidLabelName` and rendered six
 *  control/bidi codepoints into the DOM — one of them inside a `title=`
 *  attribute — where the override reverses the rest of the cell and a row can
 *  be made to read as a different label than the one it is. Spoofing, not
 *  execution; this boundary therefore applies the same defense in depth.
 *
 *  Strip BEFORE escaping: the passes are independent, and in this order no
 *  stripped character can be reintroduced by an entity.
 *
 *  The ranges are the ones text-safety.mjs owns and documents — C0 minus TAB
 *  and LF, DEL and C1, then the zero-width marks, bidi overrides and bidi
 *  isolates, as inclusive `[lo, hi]` pairs. They are rebuilt from NUMBERS
 *  here, rather than imported, because client.mjs ships this function by
 *  injecting its own `esc.toString()` into the browser bundle, so every
 *  function in this module must stay self-contained — and because a source
 *  file carrying raw control bytes is unreviewable in a diff. */
export function esc(s) {
  const ranges = [0x00, 0x08, 0x0b, 0x1f, 0x7f, 0x9f, 0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069];
  let cls = '';
  for (let i = 0; i < ranges.length; i += 2) {
    cls += `${String.fromCharCode(ranges[i])}-${String.fromCharCode(ranges[i + 1])}`;
  }
  return String(s == null ? '' : s).replace(new RegExp(`[${cls}]`, 'g'), '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Category map: every subsystem lands in exactly one tab; unknown/future
 *  subsystems fall back to Runtime so nothing is ever dropped. Overview
 *  aggregates all attention cards regardless of category. */
export const CAT = {
  hosts: 'hosts', mcp: 'hosts', 'codex-mcp': 'hosts', 'codex-plugins': 'hosts', opencode: 'hosts', routing: 'hosts',
  providers: 'providers',
  learning: 'intel', memory: 'intel', 'deja-vu': 'intel', 'ruvnet-brain': 'intel', 'ruvnet-brain-nightly': 'intel', aqe: 'intel', agentdb: 'intel',
  ruvector: 'intel',
};

/** Which tab group a subsystem belongs to ('hosts' | 'providers' | 'runtime' | 'intel'). */
export function catOf(s) { return CAT[s] || 'runtime'; }

/** Severity rank for rollups + triage sort; PREF breaks ties (display order). */
export const RANK = { fail: 3, warn: 2, ok: 1, info: 0, unknown: 0 };
export const PREF = ['versions', 'self', 'natives', 'security', 'learning', 'memory', 'deja-vu', 'providers', 'hosts', 'routing', 'mcp', 'codex-mcp', 'codex-plugins', 'opencode', 'ruvnet-brain', 'ruvnet-brain-nightly', 'ruvector', 'aqe', 'daemons', 'blocks', 'statusline', 'npx'];

/** Collapse rows into one group per subsystem (kills repeated labels); the
 *  group's level is the worst of its rows. Sort worst-first, then by PREF. */
export function groupRows(rows) {
  const map = {}; const seq = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const k = r.subsystem || 'other';
    if (!map[k]) { map[k] = { subsystem: k, rows: [], level: 'info' }; seq.push(k); }
    map[k].rows.push(r);
    if ((RANK[r.level] || 0) > (RANK[map[k].level] || 0)) map[k].level = r.level;
  }
  const groups = seq.map((k) => map[k]);
  groups.sort((a, b) => {
    const d = (RANK[b.level] || 0) - (RANK[a.level] || 0); if (d) return d;
    const ia = PREF.indexOf(a.subsystem); const ib = PREF.indexOf(b.subsystem);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return groups;
}

/** One status row as an <li>: level dot + message + optional →fix. */
export function rowLine(r) {
  const lvl = r.level || 'info';
  const fix = r.fix ? ('<span class="row-fix"><span class="arrow">&rarr;</span><code>' + esc(r.fix) + '</code></span>') : '';
  return '<li class="row" data-level="' + esc(lvl) + '">'
    + '<span class="row-dot"></span>'
    + '<span class="row-msg">' + esc(r.message) + fix + '</span>'
    + '</li>';
}

/** One subsystem group as a card: level dot + name + rows. */
export function groupCard(g) {
  const lvl = g.level || 'info'; const calm = (lvl === 'ok' || lvl === 'info');
  const count = g.rows.length > 1 ? ('<span class="card-count">' + g.rows.length + '</span>') : '';
  const badge = calm ? '' : ('<span class="card-level">' + esc(lvl) + '</span>');
  return '<article class="card" data-level="' + esc(lvl) + '">'
    + '<div class="card-top">'
    + '<span class="dot" data-level="' + esc(lvl) + '"></span>'
    + '<span class="card-name">' + esc(g.subsystem) + '</span>'
    + count + badge
    + '</div>'
    + '<ul class="rows">' + g.rows.map(rowLine).join('') + '</ul>'
    + '</article>';
}

/** A grid of group cards — what every tab panel renders. */
export function gridHtml(groups) {
  return '<div class="grid">' + groups.map(groupCard).join('') + '</div>';
}

/** The update notice (drift banner) inner HTML, or '' when nothing is
 *  outdated. Only entries the drift report already flagged as outdated count —
 *  an external (non-npm) install never appears here, because the report never
 *  claims ak owns its update. */
export function noticeHtml(drift) {
  const out = (drift || []).filter((d) => d && d.outdated);
  if (!out.length) return '';
  const parts = out.map((d) => '<b>' + esc(d.pkg) + '</b> ' + esc(d.installed) + ' &rarr; ' + esc(d.latest));
  return '<span class="up">&uarr;</span><span>' + out.length + ' update' + (out.length > 1 ? 's' : '')
    + ' available: ' + parts.join(' &nbsp;·&nbsp; ') + ' &mdash; run <code>ak sync</code></span>';
}
