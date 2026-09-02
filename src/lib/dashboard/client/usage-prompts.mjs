// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.

// Pure string-building panels for the Usage tab's Prompts view (METRICS.md §21).
// Split out of usage.mjs on the usage-rhythm.mjs precedent: no DOM access, no
// fetch, no module-level state — every function takes the payload's `prompts`
// block in and returns markup out, so the panels are unit-testable as real
// ESM while shipping as part of the one concatenated bundle.
//
// EVERY FIGURE COMES FROM `prompts.patterns`, the single projection
// usage-aggregate.mjs builds from the records it holds. Nothing here re-derives
// a count the projection already publishes: the dashboard and `ak usage
// prompts` read the same object, so they cannot disagree about what a cluster
// is or how many there are.
//
// THE PRIVACY CONTRACT IS UPSTREAM OF THIS FILE. Nothing here could render
// prompt text if it wanted to: the projection carries counts, hashes, spans,
// hosts, and names drawn from a deterministic vocabulary, and no field on it
// holds anything a person typed. `esc` is applied to every interpolated value
// anyway — the payload is server-shaped, not server-trusted.
//
// `esc` is copied from ./groups.mjs's real implementation rather than
// imported, for the same reason usage-rhythm.mjs copies it: bootstrap.mjs's
// own `esc` is a build-time PLACEHOLDER, so importing it here would pull in
// the stub. client.mjs strips this copy from the bundle (RHYTHM_ESC there).
import { rankedRows, sparklineSvg } from './usage-rhythm.mjs';

function esc(s) {
  var ranges = [0x00, 0x08, 0x0b, 0x1f, 0x7f, 0x9f, 0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069];
  var cls = '';
  for (var i = 0; i < ranges.length; i += 2) {
    cls += String.fromCharCode(ranges[i]) + '-' + String.fromCharCode(ranges[i + 1]);
  }
  return String(s == null ? '' : s).replace(new RegExp('[' + cls + ']', 'g'), '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ── formatting ──────────────────────────────────────────────────────────────

function num(n) { return (Number(n) || 0).toLocaleString(); }

// A share as a percent. `null` in — the shape every share on this payload
// takes when its denominator was empty — renders the ABSENT mark, never
// "0%": a window that measured nothing did not measure zero.
function share(v) {
  if (v == null || !isFinite(v)) return '—';
  var p = v * 100;
  return (p >= 10 ? Math.round(p) : Math.round(p * 10) / 10) + '%';
}

function ratio(a, b) { return b > 0 ? a / b : null; }

/** "1 day" / "9 days", as PLAIN TEXT — callers that interpolate into markup
 *  escape it themselves, and callers passing it to an escaping slot do not
 *  double-escape. Counts on this view routinely come back as 1, and "1 days"
 *  is the tell that a number was pasted into a sentence rather than written
 *  into one. */
function plural(n, word) {
  var v = Number(n) || 0;
  return num(v) + ' ' + word + (v === 1 ? '' : 's');
}

/** The projection, or null when this window has no fingerprint layer at all.
 *  Every panel gates on this rather than reaching into a missing object. */
function pat(p) { return (p && p.patterns) || null; }

// ── the KPI strip (METRICS.md §21) ──────────────────────────────────────────

// Each tile states its formula and, on the second line, what it does NOT
// model. The second line is the load-bearing half: every one of these numbers
// describes a SHAPE of prompt, and a reader who takes a shape for a judgement
// is the failure mode this view has to design against.
var TIP_TYPED = 'Turns whose provenance says a person typed them, over every fingerprinted user-role '
  + 'turn in the window.\nThe rest is agent-to-agent traffic, control records and tool-authored '
  + 'templates, filtered out before anything on this page is computed.\n'
  + 'Does not model: intent or quality. Only authorship.';
var TIP_QUESTIONS = 'Prompts that ask rather than instruct, by a published rule: ends with "?", opens '
  + 'with a wh-word, or opens with an auxiliary and contains "?".\n'
  + 'Does not model: rhetorical questions — and the instruction/feedback split is not measured per '
  + 'prompt, so this is the question share, not a ratio between three classes.';
var TIP_TAPS = 'Prompts of at most 4 normalized tokens — approvals and nudges rather than '
  + 'instructions — as a share of what you typed.\nCompared against your own trailing-90d p75 for '
  + 'each host, never a fixed number.\nCost, when stated, is modelled: taps × median context, '
  + 'order-of-magnitude and mostly cache-priced.\n'
  + 'Does not model: whether the tap was necessary. Some taps are legitimate approvals.';
var TIP_REPEATED = 'Prompts inside a near-duplicate cluster spanning at least 3 sessions OR at least '
  + '2 days.\nClustering is loose on purpose: phrasing variance is the signal, so eleven wordings of '
  + 'one request outrank eleven identical ones.\n'
  + 'Does not model: whether the repetition was deliberate.';
var TIP_HEADLESS = 'Responses from sessions with no human-typed prompt at all — delegated work nobody '
  + 'sat through.\nA session carrying no fingerprint layer is excluded from BOTH halves of the '
  + 'fraction rather than assumed headless: unknowable is not headless.\n'
  + 'This is a reframe, not a criticism — it is the share of the bill that rides on briefs.';

/**
 * One KPI tile. EVERY caller-supplied value is text and is escaped here — the
 * helper has no raw-HTML slot for a caller to reach through.
 *
 * `o.chips` is the one exception and it is not a slot: it takes the output of
 * `hostChips` and nothing else, which is markup this file builds and escapes
 * itself. An earlier signature took the whole detail line as raw HTML so a
 * caller could pass `<span class="d-note">…</span>`; that worked only because
 * all five callers happened to be careful, and it is exactly the helper a
 * sixth caller passes a payload string to.
 */
function promptKpiCard(k, v, tip, o) {
  var d = esc(o.detail == null ? '' : o.detail);
  if (o.note) d += '<span class="d-note">' + esc(o.note) + '</span>';
  if (o.chips) d += '<span class="d-note">' + o.chips + '</span>';
  return '<div class="kpi" title="' + esc(tip) + '">'
    + '<div class="k">' + esc(k) + '</div>'
    + '<div class="v">' + esc(v) + '</div>'
    + '<div class="d">' + d + '</div></div>';
}

/**
 * Prompts inside a recurring cluster. Summed over the WHOLE cluster list, which
 * is why the projection ships it uncapped: a top-N slice would report a smaller
 * repeated share the more repetition it found.
 */
function recurringPrompts(p) {
  var c = pat(p) ? pat(p).clusters : null;
  if (!Array.isArray(c)) return null;
  var n = 0;
  for (var i = 0; i < c.length; i++) n += Number(c[i].count) || 0;
  return n;
}

/**
 * The window's question share, weighted across hosts.
 *
 * Read from the SHIPPED per-host `questionShare` rather than recomputed: the
 * pattern projection publishes no per-prompt question count, and the per-host
 * share is the same `q` flag counted at the same layer as the tap share beside
 * it. `null` when no host reported one.
 */
function questionShare(p) {
  var by = (p && p.byHost) || {}, typed = 0, questions = 0, seen = false;
  for (var host in by) if (Object.prototype.hasOwnProperty.call(by, host)) {
    var row = by[host], t = Number(row.typed) || 0;
    if (row.questionShare == null || !t) continue;
    seen = true; typed += t; questions += row.questionShare * t;
  }
  return seen && typed > 0 ? questions / typed : null;
}

/**
 * The five-tile strip. `p` is the payload's `prompts` block.
 *
 * EMPTY-CORPUS HONESTY: with nothing typed in the window every tile renders
 * its absent state. A zero here would claim a measurement — "0% of your
 * prompts were taps" — that the absence of data does not support.
 */
export function promptKpis(p) {
  var pp = pat(p);
  var corpus = pp ? pp.corpus : null;
  var typed = corpus ? Number(corpus.typed) || 0 : Number(p && p.typed) || 0;
  if (!typed) {
    return '<div class="empty">no typed prompts in this window &mdash; nothing here was measured. '
      + 'Sessions with no human-typed turn still appear in Sessions and Scorecard.</div>';
  }
  var recurring = recurringPrompts(p);
  var q = questionShare(p);
  var h = (p && p.headless) || {};
  return [
    promptKpiCard('Typed prompts', num(typed), TIP_TYPED,
      { detail: share(ratio(typed, corpus && corpus.fingerprints)) + ' of fingerprinted turns' }),
    promptKpiCard('Questions', share(q), TIP_QUESTIONS,
      q == null
        ? { detail: 'no host reported a share' }
        : { note: 'fingerprints do not infer an instruction / feedback split' }),
    promptKpiCard('Supervision taps', share(p.tapShare), TIP_TAPS,
      { detail: num(p.taps) + ' of ' + num(typed) + ' typed', chips: hostChips(p) }),
    promptKpiCard('Repeated share', recurring == null ? '—' : share(ratio(recurring, typed)),
      TIP_REPEATED,
      { detail: recurring == null ? 'patterns not computed'
        : num(pp.clusters.length) + ' recurring cluster' + (pp.clusters.length === 1 ? '' : 's') }),
    promptKpiCard('Headless share', share(h.share), TIP_HEADLESS,
      { detail: plural(h.sessions, 'session') + ' · '
        + num(h.responses) + ' of ' + num(h.measuredResponses) + ' responses' }),
  ].join('');
}

// One per-host tap chip, read against that host's OWN trailing baseline.
// A host with no baseline gets its share and an explicit "no baseline",
// which is the honest reading — not a comparison against an invented normal.
function tapHostChip(host, row, baseline) {
  var b = baseline && baseline[host] ? baseline[host].tapShareP75_trailing90d : null;
  var s = row.tapShare;
  if (s == null) return '';
  var tone = b == null ? 'flat' : (s > b ? 'bad' : 'good');
  // Kept short deliberately: the chip is one line inside a ~200px KPI card,
  // and a longer note ellipsised on the host whose share printed as three
  // characters rather than two. The tile's tooltip carries the long form.
  var note = b == null ? 'no baseline' : 'your p75 ' + share(b);
  return '<span class="pr-chip" data-tone="' + tone + '">' + esc(host) + ' ' + esc(share(s))
    + ' <i>' + esc(note) + '</i></span>';
}

function hostChips(p) {
  var by = (p && p.byHost) || {}, out = [];
  for (var host in by) if (Object.prototype.hasOwnProperty.call(by, host)) {
    out.push(tapHostChip(host, by[host], p.baselines));
  }
  return out.join('') || '<span class="pr-chip" data-tone="flat">no per-host split</span>';
}

// ── how you steer ───────────────────────────────────────────────────────────

/**
 * The measured half of the steer split. The spec's full taxonomy (interrogative
 * / imperative / declarative-feedback) needs a lexicon that has not shipped, so
 * this panel renders ONLY what the fingerprint layer actually carries: whether
 * a prompt asks, and whether it is short enough to be an approval. The residue
 * is named "statements and instructions" rather than split into a guess, and
 * the panel's own caveat says the split is partial, so these three bars never
 * read as the full taxonomy.
 */
export function steerPanel(p) {
  var pp = pat(p);
  var typed = pp && pp.corpus ? Number(pp.corpus.typed) || 0 : 0;
  if (!typed) return '<div class="empty">nothing typed in this window to classify.</div>';
  var taps = Number(p.taps) || 0;
  var q = questionShare(p);
  var questions = q == null ? 0 : Math.round(q * typed);
  // A tap can also be a question ("done?"), so the two categories OVERLAP —
  // and this subtracts both counts IN FULL, which double-removes every prompt
  // that is both. So `rest` is a FLOOR on the statements-and-instructions
  // count, not the count itself: the true residue is this number plus the
  // overlap. (Final review P4-M3: the comment here used to claim this was
  // "what is left after the UNION", which is what the arithmetic would need
  // an overlap count to compute — and the wire carries none. On a panel whose
  // whole point is honesty, a false comment beside a silently floored figure
  // is the wrong thing to ship, so the figure is disclosed as a floor instead
  // and the union is left deferred rather than implied.) `Math.max` keeps it
  // off negative when the overlap is large.
  var rest = Math.max(0, typed - questions - taps);
  var rows = [
    { label: 'Questions', value: num(questions) + ' · ' + share(ratio(questions, typed)), share: ratio(questions, typed) * 100 },
    { label: 'Supervision taps', value: num(taps) + ' · ' + share(ratio(taps, typed)), share: ratio(taps, typed) * 100 },
    { label: 'Statements and instructions (at least)', value: num(rest) + ' · ' + share(ratio(rest, typed)), share: ratio(rest, typed) * 100, dim: true },
  ].sort(function (a, b) { return b.share - a.share; });
  return rankedRows(rows)
    + '<p class="pr-caveat">A prompt can be both a question and a supervision tap ("done?"), and '
    + 'both counts are subtracted in full — so the last row is a FLOOR, and the three do not sum to '
    + '100%. Reporting the exact split needs an overlap count this projection does not carry.</p>';
}

/** What each provenance tag means, in the operator's terms. `unrecognized` is
 *  the projection's own overflow row and only appears when the corpus produced
 *  a tag the vocabulary does not name. */
var PROVENANCE_LABEL = {
  human: 'You, typing',
  control: 'Control records (slash, interrupts, bash input)',
  agent: 'Agent and teammate deliveries',
  adapter: 'Tool-authored headless templates',
  unrecognized: 'Unrecognized tag',
};

/**
 * Who actually wrote the user-role turns. This is the panel that makes every
 * other figure legible: the whole view sits behind the `human` slice, and a
 * reader who does not know how thin that slice is will read the rest as though
 * it described all of their traffic.
 *
 * A tag the corpus never produced still renders, at zero — the projection emits
 * every tag in the vocabulary for exactly that reason, and dropping the empty
 * rows would turn "you have none of these" into "we did not look".
 */
export function provenancePanel(p) {
  var pp = pat(p);
  if (!pp || !pp.provenance) return '<div class="empty">no provenance split for this window.</div>';
  var prov = pp.provenance, total = 0, key;
  for (key in prov) if (Object.prototype.hasOwnProperty.call(prov, key)) total += Number(prov[key]) || 0;
  if (!total) return '<div class="empty">no fingerprinted turns in this window.</div>';
  var rows = [];
  for (key in prov) if (Object.prototype.hasOwnProperty.call(prov, key)) {
    var n = Number(prov[key]) || 0;
    rows.push({
      label: PROVENANCE_LABEL[key] || key,
      value: num(n) + ' · ' + share(ratio(n, total)),
      share: ratio(n, total) * 100,
      dim: key !== 'human',
    });
  }
  rows.sort(function (a, b) { return b.share - a.share; });
  return rankedRows(rows)
    + '<div class="pr-caveat">Only the <b>' + esc(PROVENANCE_LABEL.human)
    + '</b> slice reaches any other figure on this page. An unrecognized machine template '
    + 'counts as human by design — the classification over-states rather than under-states.</div>';
}

/**
 * Taps by LENGTH. There is no text at this layer, so "your top short prompts"
 * can only be a length distribution — which is the honest shape of the question
 * anyway: a one-token tap is "y", a four-token tap is a sentence, and the two
 * are different habits. The verbatim table needs a transcript re-read and lives
 * in `ak usage prompts`.
 */
export function tapLengthPanel(p) {
  var pp = pat(p);
  var rows = pp && Array.isArray(pp.tapLengths) ? pp.tapLengths : null;
  if (!rows) return '<div class="empty">tap lengths were not computed for this window.</div>';
  if (!rows.length) {
    return '<div class="empty">no supervision taps in this window &mdash; every typed prompt ran '
      + 'longer than four tokens.</div>';
  }
  var max = rows.reduce(function (m, r) { return Math.max(m, Number(r.prompts) || 0); }, 0);
  return rankedRows(rows.map(function (r) {
    var t = Number(r.tokens) || 0;
    return {
      label: t + ' token' + (t === 1 ? '' : 's'),
      value: num(r.prompts) + ' · ' + num(r.sessions) + ' sess',
      share: ratio(Number(r.prompts) || 0, max) * 100,
    };
  }));
}

// ── recurring patterns and re-asks ─────────────────────────────────────────

function patternLabel(label) {
  var name = String(label && label.name || 'Recurring prompt');
  var descriptor = String(label && label.descriptor || name);
  return '<span class="pr-pattern-name" title="' + esc(descriptor) + '">' + esc(name) + '</span>';
}

function patternHosts(hosts) {
  return (Array.isArray(hosts) ? hosts : []).map(function (host) {
    return '<span class="pr-pattern-host">' + esc(host) + '</span>';
  }).join('') || '<span class="pr-none">not attributed</span>';
}

/** A read-only rendering of deterministic cluster and re-ask evidence. It has
 *  no expansion state, prompt-text fetch, recommendation, draft, or mutation. */
export function patternsPanel(p) {
  var pp = pat(p);
  if (!pp) return '<div class="empty">patterns were not computed for this window.</div>';
  var re = pp.reAsks || {}, pairs = Number(re.pairCount) || 0, sessions = Number(re.sessionCount) || 0;
  var summary = pairs
    ? pairs + ' re-ask' + (pairs === 1 ? '' : 's') + ' across ' + sessions + ' session' + (sessions === 1 ? '' : 's') + '.'
    : 'No in-session re-asks were measured in this window.';
  var clusters = Array.isArray(pp.clusters) ? pp.clusters : [];
  if (!clusters.length) {
    return '<p class="pr-pattern-summary">' + esc(summary) + '</p>'
      + '<div class="empty">no prompt repeated across enough sessions or days to cluster.</div>';
  }
  var rows = clusters.slice(0, 25).map(function (c) {
    return '<tr><th scope="row">' + patternLabel(c.label) + '</th>'
      + '<td>' + esc(c.intent || (c.class === 'question' ? 'Question' : 'Unclassified')) + '</td>'
      + '<td class="tnum">' + esc(num(c.count)) + '</td>'
      + '<td class="tnum">' + esc(num(c.sessions)) + '</td>'
      + '<td class="tnum">' + esc(num(c.days)) + '</td>'
      + '<td>' + patternHosts(c.hosts) + '</td></tr>';
  }).join('');
  return '<p class="pr-pattern-summary">' + esc(summary) + '</p>'
    + '<div class="pr-pattern-wrap" role="region" aria-label="Recurring prompt patterns" tabindex="0">'
    + '<table class="pr-pattern-table"><caption class="sr-only">Deterministic recurring prompt clusters.</caption>'
    + '<thead><tr><th scope="col">Pattern</th><th scope="col">Intent</th><th scope="col">Times typed</th>'
    + '<th scope="col">Sessions</th><th scope="col">Days seen</th><th scope="col">Hosts</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>'
    + (clusters.length > 25 ? '<p class="pr-caveat">Showing 25 of ' + esc(num(clusters.length))
      + ' recurring clusters. Use <code>ak usage prompts</code> for the full report.</p>' : '');
}

// ── host interplay ──────────────────────────────────────────────────────────

/** The per-day tap share for one host, oldest first — the series the trend
 *  line is drawn from. A day that host did not type on yields `null`, which
 *  sparklineSvg renders as a BREAK rather than a zero or a carried-forward
 *  neighbour: no prompts is not a tap share of nothing. */
export function hostTapSeries(statsByDay, host) {
  var days = [], k;
  for (k in (statsByDay || {})) if (Object.prototype.hasOwnProperty.call(statsByDay, k)) days.push(k);
  days.sort();
  return days.map(function (day) {
    var row = statsByDay[day] && statsByDay[day].byHost && statsByDay[day].byHost[host];
    if (!row || !row.typed) return null;
    return row.taps / row.typed;
  });
}

/**
 * One row per host: the tap-share trend, the p90 typed length, and the count of
 * prompts that open by assigning a role.
 *
 * The p90 bars are scaled against the LONGEST host rather than an absolute
 * axis, because the panel's question is the asymmetry between hosts, not
 * whether either is long in some universal sense.
 */
export function hostInterplay(p) {
  var by = (p && p.byHost) || {}, hosts = [];
  for (var k in by) if (Object.prototype.hasOwnProperty.call(by, k)) hosts.push(k);
  if (!hosts.length) return '<div class="empty">no host carried a typed prompt in this window.</div>';
  hosts.sort(function (a, b) { return (Number(by[b].typed) || 0) - (Number(by[a].typed) || 0); });
  var maxP90 = hosts.reduce(function (m, h) { return Math.max(m, Number(by[h].p90TypedTokens) || 0); }, 0);
  return '<div class="pr-hosts">' + hosts.map(function (host) {
    return hostRow(host, by[host], p, maxP90);
  }).join('') + '</div>' + hostRead(hosts, by);
}

function hostRow(host, row, p, maxP90) {
  var series = hostTapSeries(p.statsByDay, host);
  var spark = sparklineSvg(series, { w: 150, h: 30 });
  var p90 = Number(row.p90TypedTokens) || 0;
  var width = maxP90 > 0 ? (p90 / maxP90) * 100 : 0;
  var persona = Number(row.personaOpeners) || 0;
  return '<div class="pr-host">'
    + '<div class="pr-host-name">' + esc(host)
    + '<span class="pr-host-n mono">' + esc(num(row.typed)) + ' typed</span></div>'
    + '<div class="pr-host-trend">'
    + (spark || '<span class="pr-none">too few days to trend</span>')
    + '<span class="pr-host-lab mono">tap share ' + esc(share(row.tapShare)) + '</span></div>'
    + '<div class="pr-host-len">'
    + '<span class="mbar"><i style="width:' + width.toFixed(1) + '%"></i></span>'
    + '<span class="pr-host-lab mono">p90 ' + esc(num(p90)) + ' tokens</span></div>'
    + '<div class="pr-host-persona">'
    + (persona
      ? '<b>' + esc(num(persona)) + '</b> prompt' + (persona === 1 ? '' : 's') + ' open by assigning a role'
      : '<span class="pr-none">no role-assigning openers</span>')
    + '</div></div>';
}

/**
 * A plain-language READ of the host asymmetry (§2), replacing the opaque
 * "windows are unequal" caveat — the persistent panel copy in page.mjs carries
 * that interpretation boundary. Compares the two most-active hosts on
 * the two figures the panel already shows: how often each is tapped, and how
 * long its prompts run. States ONLY a comparison both sides actually carry, and
 * says nothing when there is no asymmetry to read (a share tie, one host, or a
 * host with no measured share/length).
 */
function hostRead(hosts, by) {
  if (hosts.length < 2) return '';
  var a = hosts[0], b = hosts[1]; // already sorted by typed, descending
  var clauses = [];
  var tapA = by[a].tapShare, tapB = by[b].tapShare;
  if (tapA != null && tapB != null && tapA !== tapB) {
    clauses.push('you tap <b>' + esc(tapA > tapB ? a : b) + '</b> more often than <b>'
      + esc(tapA > tapB ? b : a) + '</b> (' + esc(share(Math.max(tapA, tapB))) + ' vs '
      + esc(share(Math.min(tapA, tapB))) + ')');
  }
  var p90A = Number(by[a].p90TypedTokens) || 0, p90B = Number(by[b].p90TypedTokens) || 0;
  if (p90A && p90B && p90A !== p90B) {
    clauses.push('write <b>' + esc(p90A > p90B ? a : b) + '</b> longer (p90 '
      + esc(num(Math.max(p90A, p90B))) + ' vs ' + esc(num(Math.min(p90A, p90B))) + ' tokens)');
  }
  if (!clauses.length) return '';
  return '<div class="pr-host-read"><span class="tag mono">read</span>'
    + clauses.join(' but ') + '.</div>';
}
