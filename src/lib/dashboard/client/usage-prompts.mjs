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
// prompt text if it wanted to: the projection carries counts, hashes, session
// ids and names drawn from a curated vocabulary, and no field on it holds
// anything a person typed. `esc` is applied to every interpolated value
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
        : { note: 'instruction / feedback split arrives with enrichment' }),
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
 * the panel beside it says the taxonomy is missing instead of implying these
 * three bars are it.
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
 * "windows are unequal" caveat — that unequal-histories nuance moves into the
 * panel's `?` tooltip (page.mjs) instead. Compares the two most-active hosts on
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

// ── the Coaching panel: pattern name ────────────────────────────────────────

/**
 * What the Pattern column shows. A CURATED or SEEDED name is shown whole. A
 * CHARACTERIZED name is the bare lead clause, because the rest of it —
 * "· 6 sessions · both hosts" — is exactly what the Sessions and Hosts columns
 * beside it already say, and a table that prints the same fact twice trains
 * the reader to skip the column that matters.
 *
 * The full descriptor stays as the row's tooltip: it is the string the CLI
 * prints, where there are no columns to carry those numbers.
 *
 * RULING B (final-triage item 2): a well-formed characterized label already
 * arrives split — `label.name` is the bare lead, `label.descriptor` the full
 * string (usage-prompt-vocabulary.mjs's `labelFor`) — so this file no longer
 * has to parse a session/host tail out of `name` itself for the common case.
 */
/**
 * A characterized lead ends in the class NOUN the vocabulary picked —
 * "Recurring 3-token prompt", never "instruction" as of RULING A (the SOURCE
 * emits the honest `other`/`prompt` pairing on the wire now — see
 * usage-prompt-vocabulary.mjs's CLASS_NOUNS). `neutralizeLead` stays as a
 * BELT, redundant by construction against a well-formed payload: this file
 * does not trust the payload's shape absolutely, and a label that still
 * arrives in the pre-Ruling-B form — the full descriptor packed into `name`,
 * no separate `descriptor` field — is still neutralised rather than shown
 * verbatim. The Type column beside it carries the class either way; neither
 * repeats the other, and neither over-states.
 *
 * Only the known shape is rewritten. Anything else passes through untouched
 * rather than being pattern-matched into something this does not recognise.
 */
var CHARACTERIZED_LEAD = /^(Recurring \d+-token )(question|instruction|mixed prompt|prompt)$/;

function neutralizeLead(lead) {
  return CHARACTERIZED_LEAD.test(lead) ? lead.replace(CHARACTERIZED_LEAD, '$1prompt') : lead;
}

function patternName(label) {
  var full = String(label.name == null ? '' : label.name);
  // A curated or seeded name is a HUMAN-authored string — a person or an
  // enrichment pass chose those words — so it is shown whole and its title is
  // the same string, whatever it contains.
  if (label.source !== 'characterized') {
    return '<span class="pr-name" title="' + esc(full) + '">' + esc(full) + '</span>';
  }
  // A characterized name is MACHINE-generated, so the class noun is
  // neutralised in the title as well as in the cell. A tooltip is a DOM
  // surface: a cell reading "prompt" whose hover reads "instruction" makes the
  // same over-claim the cell was cleaned of, and hides it where a reader is
  // less likely to challenge it.
  //
  // `descriptor` is read defensively, not trusted absolutely (the belt this
  // function's doc comment describes): when present (the well-formed, post-
  // Ruling-B shape), `full` IS the bare lead already, so `descriptor` supplies
  // only the tail. When absent, this falls back to the pre-Ruling-B behaviour
  // — splitting the tail out of `full` itself — so an out-of-band label that
  // still arrives in the old shape is neutralised exactly as it always was.
  var hasDescriptor = typeof label.descriptor === 'string';
  var lead = hasDescriptor ? full : full.split(' · ')[0];
  var tail = hasDescriptor ? label.descriptor.slice(lead.length) : full.slice(lead.length);
  var neutralLead = neutralizeLead(lead);
  var neutralFull = neutralLead + tail;
  return '<span class="pr-name" title="' + esc(neutralFull) + '">' + esc(neutralLead) + '</span>';
}

// ── the Coaching panel: filters, sortable table, expand (spec §2) ────────────
//
// One sortable, filterable table where each pattern row expands to what you
// typed, where, and what to change. Renders from `p.patterns.clusters` (each
// carries a derived `kind`, §3), with the re-ask summary as the lead insight.
// PURE: state (filter, sort, open row, posture, samples cache, dismissals) is
// owned by usage.mjs and passed in, so every interaction is a re-render from
// `p` + `state` and the panel is idempotent.

// The five derived kinds → the pill label the operator reads. Client display
// map only (§3): the projection ships the raw enum, the words live here.
var PR_KIND_LABEL = {
  reask: 'Re-asks', persona: 'Role preambles', tap: 'Taps',
  question: 'Questions', instruction: 'Instructions',
};
// Pill order — most actionable first, matching the kind precedence (§3).
var PR_KIND_ORDER = ['reask', 'persona', 'tap', 'question', 'instruction'];

// The sortable columns, in render order. `num` right-aligns and defaults to a
// descending first click; `tip` is the header's precise-definition tooltip.
var COACH_COLS = [
  { key: 'name', label: 'Pattern', num: false, tip: 'The recurring prompt cluster.' },
  { key: 'count', label: 'Times typed', num: true, tip: 'How many times this pattern was typed in the window.' },
  { key: 'sessions', label: 'Sessions', num: true, tip: 'How many separate sessions it appeared in.' },
  { key: 'days', label: 'Days seen', num: true, tip: 'How many distinct days it appeared on.' },
  { key: 'hosts', label: 'Hosts', num: false, tip: 'Which agents you typed it to.' },
];

var COACH_DEFAULT_SORT = { key: 'count', dir: 'desc' };

// A cluster's kind, folded to the catch-all when the projection shipped one
// this display map does not name (older cache, or a value added server-side
// before the labels caught up) — so a row is always filterable, never dropped.
function clusterKind(c) { return PR_KIND_LABEL[c.kind] ? c.kind : 'instruction'; }

/** The re-ask summary as the panel's lead insight (was reAskPanel). A window
 *  with no re-ask reads as a neutral prompt to explore the table, never a
 *  fabricated statistic. */
function coachingInsight(pp) {
  var r = pp && pp.reAsks;
  var tail = ' Click a pattern to see what you typed and what to change.';
  if (!r || !r.pairCount) {
    return '<p class="pr-insight">Every pattern below is one you typed more than once across your '
      + 'sessions.' + tail + '</p>';
  }
  var gaps = r.gapHist || {}, immediate = Number(gaps[1]) || 0;
  return '<p class="pr-insight"><b>' + esc(num(r.pairCount)) + '</b> re-ask'
    + (r.pairCount === 1 ? '' : 's') + ' across <b>' + esc(num(r.sessionCount)) + '</b> session'
    + (r.sessionCount === 1 ? '' : 's')
    + (immediate
      ? ' &middot; <b>' + esc(share(ratio(immediate, r.pairCount)))
        + '</b> landed on the very next turn, pointing at the answer rather than the thread'
      : '')
    + '.' + tail + '</p>';
}

/** Clusters per present kind — the filter pills' counts. */
function kindCounts(clusters) {
  var c = {};
  clusters.forEach(function (row) { var k = clusterKind(row); c[k] = (c[k] || 0) + 1; });
  return c;
}

/** The filter pills: `All` + one per kind PRESENT, each a swatch + count. The
 *  active pill is marked; clicking re-filters (wired in usage.mjs). An empty
 *  filter result is handled by the table body, not by hiding the pills. */
function coachingFilters(clusters, filter) {
  var counts = kindCounts(clusters);
  var all = '<button type="button" class="fpill' + (filter === 'all' ? ' on' : '') + '" '
    + 'data-pr-filter="all" aria-pressed="' + (filter === 'all') + '">All '
    + '<span class="fc mono">' + esc(num(clusters.length)) + '</span></button>';
  var pills = PR_KIND_ORDER.filter(function (k) { return counts[k]; }).map(function (k) {
    return '<button type="button" class="fpill' + (filter === k ? ' on' : '') + '" '
      + 'data-pr-filter="' + esc(k) + '" aria-pressed="' + (filter === k) + '">'
      + '<span class="sw k-' + esc(k) + '"></span>' + esc(PR_KIND_LABEL[k])
      + ' <span class="fc mono">' + esc(num(counts[k])) + '</span></button>';
  }).join('');
  return '<div class="pr-filters" role="group" aria-label="Filter patterns by kind">' + all + pills + '</div>';
}

/** The value a column sorts on for one cluster row — a string for the name, a
 *  number for the count columns, the host count for the Hosts column. */
function coachSortValue(c, key) {
  if (key === 'hosts') return Array.isArray(c.hosts) ? c.hosts.length : 0;
  if (key === 'name') return String((c.label && c.label.name) || '');
  return Number(c[key]) || 0;
}

/** The clusters after filter + sort. STABLE: a name tiebreak keeps equal-value
 *  rows in a deterministic order across re-renders, so a re-sort never shuffles
 *  ties and the expanded row stays where the reader left it. */
function coachingRows(clusters, state) {
  var filter = state.filter || 'all';
  var sort = state.sort || COACH_DEFAULT_SORT;
  var dir = sort.dir === 'asc' ? 1 : -1;
  var rows = clusters.filter(function (c) { return filter === 'all' || clusterKind(c) === filter; });
  return rows.slice().sort(function (a, b) {
    if (sort.key === 'name') return dir * coachSortValue(a, 'name').localeCompare(coachSortValue(b, 'name'));
    var d = coachSortValue(a, sort.key) - coachSortValue(b, sort.key);
    return d ? dir * d : coachSortValue(a, 'name').localeCompare(coachSortValue(b, 'name'));
  });
}

/** One header cell — a sort button carrying the arrow indicator, the aria-sort
 *  state, and the precise-definition tooltip (§2). */
function coachHeadCell(col, sort) {
  var active = sort.key === col.key;
  var arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅';
  var sortAttr = active ? ' aria-sort="' + (sort.dir === 'asc' ? 'ascending' : 'descending') + '"' : '';
  return '<th scope="col" class="' + (col.num ? 'tnum' : '') + '"' + sortAttr + '>'
    + '<button type="button" data-pr-sort="' + esc(col.key) + '" title="' + esc(col.tip) + '">'
    + esc(col.label) + '<span class="arw mono" aria-hidden="true">' + arrow + '</span></button></th>';
}

function coachHostChips(hosts) {
  return (Array.isArray(hosts) ? hosts : []).map(function (h) {
    return '<span class="pr-hostchip">' + esc(h) + '</span>';
  }).join('');
}

/** One collapsed data row. The Pattern cell is the expand control (a button
 *  toggling this row's coaching panel); NO source sublabel and NO kind dot on
 *  the row — the kind colour lives in the filter pills (§2). The detail row is
 *  appended by `coachingPanel` when this pattern is open. */
function coachRow(c, state) {
  var open = state.openKey === c.key;
  return '<tr class="prow' + (open ? ' open' : '') + '" data-pr-row="' + esc(c.key) + '">'
    + '<th scope="row"><button type="button" class="pname-btn" data-pr-open="' + esc(c.key) + '" '
    + 'aria-expanded="' + open + '"><span class="chev mono" aria-hidden="true">▶</span>'
    + patternName(c.label || {}) + '</button></th>'
    + '<td class="tnum">' + esc(num(c.count)) + '</td>'
    + '<td class="tnum">' + esc(num(c.sessions)) + '</td>'
    + '<td class="tnum">' + esc(num(c.days)) + '</td>'
    + '<td>' + coachHostChips(c.hosts) + '</td></tr>';
}

/**
 * The Coaching panel (§2): the re-ask insight, the kind filter pills, and the
 * sortable table (Pattern · Times typed · Sessions · Days seen · Hosts). The
 * table caps at ~5 rows then scrolls with a pinned header (CSS); each pattern
 * expands to its coaching panel (the detail row, built in the expand commit).
 *
 * Absent states are NAMED, never blank: no projection, no clusters, and an
 * empty filter each read differently, so a clean "nothing repeated" is never
 * confused with "not computed" or "nothing matches this pill".
 */
export function coachingPanel(p, state) {
  state = state || {};
  var pp = pat(p);
  if (!pp) return '<div class="empty">patterns were not computed for this window.</div>';
  var clusters = Array.isArray(pp.clusters) ? pp.clusters : [];
  if (!clusters.length) {
    return coachingInsight(pp)
      + '<div class="empty">no prompt repeated across enough sessions or days to cluster. '
      + 'That is a clean result, not a missing one.</div>';
  }
  var sort = state.sort || COACH_DEFAULT_SORT;
  var rows = coachingRows(clusters, state);
  var body = rows.length
    ? rows.map(function (c) { return coachRow(c, state) + coachDetailRow(c, p, state); }).join('')
    : '<tr><td colspan="' + COACH_COLS.length + '" class="pr-empty">no patterns of this kind in '
      + 'this window &mdash; clear the filter to see the rest.</td></tr>';
  return coachingInsight(pp)
    + coachingFilters(clusters, state.filter || 'all')
    + '<div class="pr-tablewrap" role="region" aria-label="Recurring prompt patterns" tabindex="0">'
    + '<table class="pr-coach"><caption class="sr-only">Recurring prompt clusters; each row expands '
    + 'to its coaching panel.</caption>'
    + '<thead><tr>' + COACH_COLS.map(function (col) { return coachHeadCell(col, sort); }).join('') + '</tr></thead>'
    + '<tbody>' + body + '</tbody></table></div>';
}

// ── the expanded coaching panel (§2.3–2.5, §4.5) ─────────────────────────────
//
// One open at a time. Order: Seen in · What you typed · Recommendation · Draft ·
// Dismiss. Recommendation/Draft/Dismiss come from the coaching card this pattern
// joins to (§4.5); a pattern with no card shows Seen-in + What-you-typed and a
// neutral note. No unmasked prompt text is ever built here — What-you-typed is
// filled from the masked verbatim endpoint (usage.mjs), and only when the prompt-
// text posture is `shown`.

var COACH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DD` → `Mon D`, parsed by PARTS (never `new Date(str)`, which is
 *  UTC-parsed and shifts the day across a timezone). Anything else passes
 *  through untouched. */
function fmtDay(d) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d == null ? '' : d));
  if (!m) return String(d == null ? '' : d);
  return (COACH_MONTHS[Number(m[2]) - 1] || m[2]) + ' ' + Number(m[3]);
}

/** A short, stable session handle for a link label (`s.1d8a`). The full id is
 *  what the link actually navigates to. */
function shortSession(id) {
  id = String(id == null ? '' : id);
  return 's.' + (id.length > 4 ? id.slice(0, 4) : id);
}

/** The §4.5 client join, first match: (1) a card ABOUT this exact cluster
 *  (`clusterKey`), else (2) a card addressing this cluster's derived KIND
 *  (`targetKind`), else none. Never force-fits — a pattern with no match
 *  renders the neutral note, not someone else's advice. */
function cardForCluster(cards, c) {
  if (!Array.isArray(cards)) return null;
  var byKey = null, byKind = null;
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    if (!byKey && card.clusterKey && card.clusterKey === c.key) byKey = card;
    if (!byKind && card.targetKind && card.targetKind === clusterKind(c)) byKind = card;
  }
  return byKey || byKind || null;
}

// Both icons ship in the copy button; CSS shows one at a time by the `.copied`
// class, so the visual feedback needs no innerHTML swap (usage.mjs only toggles
// the class). aria-hidden — the button's aria-label carries the meaning.
var COACH_COPY_ICON = '<span class="ic-copy" aria-hidden="true">'
  + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/>'
  + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span>'
  + '<span class="ic-check" aria-hidden="true">'
  + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" '
  + 'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>';

/** Up to three `session · date` links to each session's masked transcript
 *  (§2.1). Prefers the fetched occurrences (they carry the date); before the
 *  fetch lands, or in the hidden posture, falls back to the projection's own
 *  `sampleSessionIds` (session links, no date) — both always resolve through the
 *  real transcript route (usage.mjs's data-pr-session handler → the validated
 *  AKDashboardOpenTranscript bridge, fixing §4.4's dead links). */
function coachSeenIn(c, state) {
  var sk = state.samples && state.samples[c.key];
  var occ = sk && Array.isArray(sk.occurrences) && sk.occurrences.length
    ? sk.occurrences
    : (Array.isArray(c.sampleSessionIds) ? c.sampleSessionIds : []).map(function (id) {
      return { sessionId: id, day: null };
    });
  var links = occ.slice(0, 3).map(function (o) {
    var lab = o.day ? esc(shortSession(o.sessionId)) + ' · ' + esc(fmtDay(o.day)) : esc(shortSession(o.sessionId));
    return '<a class="occ-link mono" href="#usage/' + encodeURIComponent(o.sessionId) + '" '
      + 'data-pr-session="' + esc(o.sessionId) + '" title="Open this session&rsquo;s masked transcript">'
      + lab + '</a>';
  }).join('');
  var more = (Number(c.sessions) || 0) - Math.min(3, occ.length);
  return '<div class="pr-seen"><span class="occ-lab mono">seen in</span>' + links
    + (more > 0 ? '<span class="occ-more mono">+' + esc(num(more)) + ' more</span>' : '') + '</div>';
}

/** The masked "What you typed" block, keyed by cluster so usage.mjs can patch
 *  it when the fetch resolves. `hidden` posture shows the terminal pointer and
 *  triggers NO fetch (the fetch gate is in usage.mjs); `shown` renders the
 *  loading / masked-text / honest-empty states from the samples cache. */
function coachTyped(c, state) {
  var inner = state.posture === 'hidden'
    ? '<div class="typed-hidden">Prompt text is hidden. Run <code>ak usage prompts --deep</code> in the '
      + 'terminal to read this pattern&rsquo;s redacted text.</div>'
    : coachTypedInner(c, state);
  return '<div class="pr-typed" id="pr-typed-' + esc(c.key) + '">' + inner + '</div>';
}

function coachTypedInner(c, state) {
  var sk = state.samples && state.samples[c.key];
  if (!sk || sk.state === 'loading') return '<div class="typed-load">loading your masked prompts&hellip;</div>';
  if (sk.state === 'error') return '<div class="typed-empty">couldn&rsquo;t load this pattern&rsquo;s text right now.</div>';
  if (sk.state === 'empty' || !Array.isArray(sk.samples) || !sk.samples.length) {
    return '<div class="typed-empty">no readable sample survived masking for this pattern.</div>';
  }
  return sk.samples.map(function (s) { return '<div class="verbatim">' + esc(s) + '</div>'; }).join('')
    + '<div class="typed-cap mono"><span class="lock">&#9679;</span> secrets redacted server-side · '
    + 'masked the same way <code>--deep</code> masks the terminal · nothing stored</div>';
}

/** rule / enriched / unknown — three-valued, so a card that does not say where
 *  it came from reads as UNKNOWN, never silently as a fixed rule (F-9). */
function coachSourceChip(card) {
  var source = card.source === 'enriched' || card.source === 'rule' ? card.source : 'unknown';
  var titles = {
    enriched: 'Written by a model from your aggregate; every number it states is bound to a dimension of that aggregate.',
    rule: 'Computed from your aggregate by a fixed rule.',
    unknown: 'This card does not say where it came from.',
  };
  return '<span class="pr-card-source" data-source="' + esc(source) + '" title="' + esc(titles[source]) + '">'
    + esc(source) + '</span>';
}

/** The draft, in a <pre> with a copy button top-right (§2.4). The copy id is
 *  keyed by the OPEN CLUSTER, not the card id: one kind-level card can address
 *  several clusters, but only one row is open, so the cluster key is the unique
 *  DOM handle. */
function coachDraft(card, key) {
  if (!card.draft || !card.draft.text) return '';
  return '<section class="coach-sec"><h5>Draft</h5><div class="draft-wrap">'
    + '<button type="button" class="pr-copy" data-pr-copy="' + esc(key) + '" title="Copy to clipboard" '
    + 'aria-label="Copy the draft to the clipboard">' + COACH_COPY_ICON + '</button>'
    + '<pre class="draft-pre mono" id="pr-draft-' + esc(key) + '">' + esc(card.draft.text) + '</pre></div></section>';
}

/** Dismiss + its hover explanation, the source chip, and the post-dismiss
 *  "Dismissed … Undo" inline (§2.5, §4.3). A card is shown as dismissed if the
 *  optimistic client flag is set OR its persisted ledger status already is. */
function coachFoot(card, state) {
  var dismissed = (state.dismissed && state.dismissed[card.id]) || card.status === 'dismissed';
  return '<div class="coach-foot' + (dismissed ? ' done' : '') + '">'
    + '<span class="dismiss-wrap"><button type="button" class="pr-dismiss" data-pr-dismiss="' + esc(card.id) + '">'
    + 'Dismiss</button><span class="dismiss-tip">Tells the tool you&rsquo;ve got this &mdash; it stops being '
    + 'proposed and won&rsquo;t come back unless the pattern gets materially worse. Your prompts are '
    + 'untouched.</span></span>'
    + '<span class="dismissed-note">Dismissed &mdash; won&rsquo;t resurface unless it gets materially worse. '
    + '<button type="button" class="undo" data-pr-undismiss="' + esc(card.id) + '">Undo</button></span>'
    + coachSourceChip(card) + '</div>';
}

/** Recommendation → Draft → Dismiss, from the joined card. The recommendation
 *  is the card's action (no "Try:" prefix) with its finding as the rationale. */
function coachCardBlock(card, key, state) {
  return '<section class="coach-sec"><h5>Recommendation</h5>'
    + '<div class="rec-title">' + esc(card.try || card.title) + '</div>'
    + (card.finding ? '<p class="rec-why">' + esc(card.finding) + '</p>' : '') + '</section>'
    + coachDraft(card, key)
    + coachFoot(card, state);
}

/** The expanded coaching panel for one open pattern — the accordion detail row.
 *  Renders nothing unless this cluster is the open one. */
function coachDetailRow(c, p, state) {
  if (state.openKey !== c.key) return '';
  var cards = p && p.coaching && Array.isArray(p.coaching.cards) ? p.coaching.cards : [];
  var card = cardForCluster(cards, c);
  var body = coachSeenIn(c, state)
    + '<section class="coach-sec"><h5>What you typed</h5>' + coachTyped(c, state) + '</section>'
    + (card
      ? coachCardBlock(card, c.key, state)
      : '<p class="coach-none">No specific coaching for this pattern yet.</p>');
  return '<tr class="detail-row"><td colspan="' + COACH_COLS.length + '"><div class="coach">'
    + body + '</div></td></tr>';
}
