// admin-model.mjs — the pure client model for `ak x admin`.
//
// Adapted from the RuvNet Brain explainer admin (stuinfla/ruvnet-brain
// explainer/admin.js, MIT © 2026 Stuart Kerr / Isovision.ai). The three
// correctness rules below were earned the hard way there; we keep them verbatim.
//
// This file IMPORTS NOTHING — no Node builtin, no DOM. That is load-bearing
// (ADR-0007 §5/§6): it makes the module both browser-safe (embedded verbatim in
// the served page) AND node-importable (exercised directly by
// tests/admin-model.test.cjs), so the tested code is byte-for-byte the shipped
// code. A future edit that adds an import here breaks both properties.
//
// Three rules this file is built around:
//   1. UNKNOWN IS NOT ZERO. Every metric passes through metric() and comes out
//      {known:true,v} or {known:false,why}. null/'' are rejected BEFORE Number()
//      coercion — both coerce to a finite 0 and would otherwise report a
//      confident zero for a merely-absent source.
//   2. NEVER DIFF A ROLLING WINDOW. Cumulative counters get current−baseline
//      deltas (snapshot/cumDelta); rolling series get equal-window momentum()
//      inside their own daily series.
//   3. NO CONTROL WITHOUT AN EXECUTOR AND AN UNDO. (Enforced by the view; the
//      model gives it a byte-for-byte snapshot to stash and restore.)

const DAY_MS = 86400000;

// Bots are noise in a "how many humans care" count, and the server only strips
// the owner. dependabot[bot] / github-actions[bot] file real items, so without
// this the human count reads too high.
const BOT_RE = /\[bot\]$|^(dependabot|renovate|github-actions|codecov|greenkeeper|snyk-bot)$/i;

// ── escaping + URL safety (NFR-7) ─────────────────────────────────────────────

/** HTML-escape for text and attribute contexts. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Every href on the page is built from third-party data (issue titles, logins,
// html_urls). esc() kills the quote but would happily pass `javascript:`, which
// still fires on click. So schemes are ALLOW-LISTED, not merely escaped.
export function safeUrl(u) {
  const s = String(u ?? '').trim();
  return /^https?:\/\//i.test(s) ? esc(s) : '#';
}

// ── metric — Rule 1: unknown is NOT zero (NFR-4.1, AC-2) ──────────────────────

export function metric(raw, why) {
  // Absence is rejected BEFORE coercion: Number(null)===0 and Number('')===0
  // both pass Number.isFinite, so the naive isFinite(Number(x)) reports a
  // confident ZERO for a merely-absent source. undefined and NaN already fail
  // isFinite; null and '' are the two that must be named here.
  if (raw === null || raw === undefined || raw === '') {
    return { known: false, why: why ?? 'no configured source provides this' };
  }
  const n = Number(raw);
  if (Number.isFinite(n)) return { known: true, v: n };
  return { known: false, why: why ?? 'no configured source provides this' };
}

// ── series helpers + momentum — Rule 2: never diff a rolling window (AC-6) ─────

/** Normalise any daily series to ASCENDING by date, returning bare values. The
 *  payload's order is inconsistent on purpose (GitHub oldest-first, others
 *  vary); trusting incoming order would silently invert a momentum arrow. */
export function ascend(rows, dateKey, valueKey) {
  if (!Array.isArray(rows)) return null;
  return rows
    .map((r) => ({ t: Date.parse(r[dateKey]), v: Number(r[valueKey]) || 0 }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t)
    .map((r) => r.v);
}

export function sum(a) { return a.reduce((x, y) => x + y, 0); }

/** Last 7 days vs the prior 7, computed inside one source's own series so both
 *  halves are equal-length windows. <4 points or an empty prior window → null
 *  ("not enough history"), never a fabricated ratio (AC-6). */
export function momentum(series) {
  if (!Array.isArray(series) || series.length < 4) return null;
  const recent = series.slice(-7);
  const prior = series.slice(-14, -7);
  if (prior.length === 0) return null;
  const r = sum(recent);
  const p = sum(prior);
  // Equal-length or scale the shorter one — otherwise the ratio is meaningless.
  const pScaled = prior.length === recent.length ? p : (p / prior.length) * recent.length;
  const dir = r > pScaled * 1.05 ? 'up' : r < pScaled * 0.95 ? 'down' : 'flat';
  const pct = pScaled > 0 ? Math.round(((r - pScaled) / pScaled) * 100) : null; // never divide by a 0 base
  return { recent: r, prior: Math.round(pScaled), dir, pct, series };
}

// ── bots + dates ──────────────────────────────────────────────────────────────

export function isBot(login) { return BOT_RE.test(String(login || '')); }

export function daysAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

export function agoLabel(iso) {
  const d = daysAgo(iso);
  if (d == null) return 'undated';
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  return d < 31 ? d + 'd ago' : Math.floor(d / 30) + 'mo ago';
}

// ── shape — payload → humans + dated events (AC-4) ────────────────────────────

/** One stable id per thread, so "have I seen this?" survives title/state edits. */
export function itemId(it) { return (it.isPR ? 'p' : 'i') + it.number; }

export function shape(d) {
  const p = d.people ?? {};
  const contributors = (p.contributors || []).filter((c) => !isBot(c.login));
  const botItems = (p.contributors || []).filter((c) => isBot(c.login))
    .reduce((n, c) => n + (c.items || []).length, 0);
  const forks = (p.forks || []).filter((f) => !isBot(f.login));

  // Every DATED human event. Stars have no date (the stargazers call omits the
  // star+json Accept header carrying starred_at), so they are absent by design.
  const events = [];
  for (const c of contributors) {
    for (const it of (c.items || [])) {
      events.push({ id: itemId(it), kind: it.isPR ? 'PR' : 'issue', login: c.login, title: it.title, url: it.url, at: it.at, state: it.state });
    }
  }
  for (const f of forks) {
    events.push({ id: 'f:' + f.login, kind: 'fork', login: f.login, title: 'forked the repo', url: 'https://github.com/' + f.login, at: f.at, state: null });
  }
  events.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  // Per-person roll-up, ranked by RECENCY — someone who wrote yesterday outranks
  // a higher-lifetime contributor who vanished weeks ago.
  const people = contributors.map((c) => {
    let dates = (c.items || []).map((i) => i.at).filter(Boolean).sort();
    const forked = forks.find((f) => f.login === c.login);
    if (forked) dates = dates.concat([forked.at]).sort();
    return {
      login: c.login, issues: c.issues || 0, prs: c.prs || 0,
      open: (c.items || []).filter((i) => i.state === 'open').length,
      first: dates[0] ?? null, last: dates[dates.length - 1] ?? null,
      forked: Boolean(forked), association: c.association,
    };
  });
  // Forkers who never filed anything are still humans who engaged.
  for (const f of forks) {
    if (!people.some((x) => x.login === f.login)) {
      people.push({ login: f.login, issues: 0, prs: 0, open: 0, first: f.at, last: f.at, forked: true, association: 'NONE' });
    }
  }
  people.sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));

  const openItems = [];
  for (const c of contributors) {
    for (const it of (c.items || [])) {
      if (it.state === 'open') openItems.push({ login: c.login, number: it.number, title: it.title, url: it.url, at: it.at, isPR: it.isPR });
    }
  }
  openItems.sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''))); // oldest first

  // Distinguishes "all closed" from "none ever existed" — opposite facts.
  const threadCount = contributors.reduce((n, c) => n + (c.items || []).length, 0);

  return { people, events, openItems, botItems, forks, threadCount };
}

// ── snapshot + cumDelta — baseline memory, Rule 2 enforced (AC-4) ─────────────

/** ONLY cumulative counters — rolling windows are excluded on purpose (Rule 2).
 *  No `tel` field: ak has no opt-in counter store (deviation, see ADR-0007). */
export function snapshot(d, s) {
  return {
    at: new Date().toISOString(),
    ids: s.events.map((e) => e.id),         // to count NEW threads next visit
    people: s.people.map((pp) => pp.login), // to count NEW people next visit
    stars: d.repo ? d.repo.stars : null,
    forks: d.repo ? d.repo.forks : null,
    downloads: d.totalAssetDownloads == null ? null : d.totalAssetDownloads,
  };
}

/** A cumulative delta, or an explicit "no baseline" — never a fabricated zero.
 *  A known current value with no stored baseline arises two ways and the copy
 *  must match which: a genuine first visit, or a counter that came online after
 *  the snapshot was taken. */
export function cumDelta(cur, baseVal, why, firstVisit) {
  const m = metric(cur, why);
  if (!m.known) return m; // unknown current ⇒ unknown delta (never 0)
  if (baseVal == null || !Number.isFinite(Number(baseVal))) {
    return { known: false, why: firstVisit
      ? 'first visit — baseline captured now'
      : 'counter appeared after your last visit — no baseline for it yet' };
  }
  return { known: true, v: m.v - Number(baseVal) };
}
