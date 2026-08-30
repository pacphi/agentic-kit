// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.

// Pure string-building panels for the Usage tab's Prompts view (spec §3).
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
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
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

// How many cluster rows the table draws. The projection is UNCAPPED by ruling
// — the "repeated share" KPI is a fact about the whole corpus and would shrink
// the more patterns were found if the list were truncated upstream — so the
// slicing is a DISPLAY decision made here, and the table says what it is not
// showing rather than letting the visible rows read as the whole finding.
var PATTERN_ROWS = 25;
var EXACT_ROWS = 6;

// ── the KPI strip (spec §3.1) ───────────────────────────────────────────────

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
  // A tap can also be a question ("done?"), so the two overlap. The residue is
  // what is left after the UNION, and can never go negative.
  var rest = Math.max(0, typed - questions - taps);
  var rows = [
    { label: 'Questions', value: num(questions) + ' · ' + share(ratio(questions, typed)), share: ratio(questions, typed) * 100 },
    { label: 'Supervision taps', value: num(taps) + ' · ' + share(ratio(taps, typed)), share: ratio(taps, typed) * 100 },
    { label: 'Statements and instructions', value: num(rest) + ' · ' + share(ratio(rest, typed)), share: ratio(rest, typed) * 100, dim: true },
  ].sort(function (a, b) { return b.share - a.share; });
  return rankedRows(rows);
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

// Not a card of fake data and not an empty div: a named gap, so a reader can
// tell "we have not built this" apart from "you have none of these".
export function taxonomyPlaceholder() {
  return '<div class="pr-pending">'
    + '<h4>Prompt-type taxonomy</h4>'
    + '<p>The ranked breakdown by subject &mdash; release/git, explain, fix/debug, review &mdash; needs a '
    + 'keyword lexicon that has not shipped. It arrives with the enrichment pass, together with the '
    + 'first-class <b>Unclassified</b> share that says how much of the lexicon is still missing.</p>'
    + '<p class="pr-pending-note">Deliberately blank rather than filled with a guess: a taxonomy that '
    + 'force-fits every prompt into a bucket reads as coverage it does not have.</p>'
    + '</div>';
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
  }).join('') + '</div>' + hostCaveat(hosts, by);
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

// The comparison is only as good as the histories behind it. Hosts adopted at
// different times give unequal windows, and saying so on the panel is cheaper
// than a reader drawing a trend from four days of one host against thirty of
// another.
function hostCaveat(hosts, by) {
  if (hosts.length < 2) return '';
  var thin = hosts.filter(function (h) { return (Number(by[h].typed) || 0) < 20; });
  return '<div class="pr-caveat">Windows are not equal: each host is only as measured as its own '
    + 'history on this machine, and a host adopted recently has fewer days behind its line.'
    + (thin.length
      ? ' <b>' + esc(thin.join(', ')) + '</b> carr' + (thin.length === 1 ? 'ies' : 'y')
        + ' under 20 typed prompts here, which is a shape, not yet a trend.'
      : '')
    + '</div>';
}

// ── repeated patterns ───────────────────────────────────────────────────────

/**
 * What a recurring cluster suggests doing about itself, keyed on its CLASS.
 *
 * A question re-asked across sessions is state the system could have
 * volunteered, which is a specific enough finding to name a specific move.
 * Everything else only gets the weaker one: the rules do not split imperative
 * from declarative (see CLASS_LABEL), so "this is worth writing down" is
 * supportable but "this belongs in CLAUDE.md" is not — that needs to know it
 * was a command rather than a statement. A cluster nobody could classify gets
 * no suggestion at all.
 */
var MOVES = {
  question: {
    label: 'reporting gap', cls: 'gap',
    tip: 'Asked again and again across sessions, so the answer is state the agent already has '
      + 'and is not offering unprompted.',
  },
  instruction: {
    label: 'encode candidate', cls: 'instr',
    tip: 'Re-typed across sessions, so it is worth writing down somewhere. WHICH artifact — a skill, '
      + 'a CLAUDE.md line, a role fragment — needs the imperative/declarative split that arrives '
      + 'with enrichment.',
  },
  mixed: {
    label: 'encode candidate', cls: 'instr',
    tip: 'Re-typed across sessions in both question and non-question forms. Worth writing down; '
      + 'which artifact needs the type split that arrives with enrichment.',
  },
};

function moveChip(cls) {
  var m = MOVES[cls];
  if (!m) return '<span class="pr-move" data-kind="none">needs classification</span>';
  return '<span class="pr-move" data-kind="' + esc(m.cls) + '" title="' + esc(m.tip) + '">'
    + esc(m.label) + '</span>';
}

/**
 * How a cluster's class is NAMED on this surface.
 *
 * The library's internal value for a non-question cluster is `instruction`, and
 * rendering that word would claim more than the shipped rules measured: the
 * prompt-shape rules detect the INTERROGATIVE case only, so "not a question"
 * covers imperatives and declaratives alike and the panel must not pick one.
 * `other` is the honest name, and CLASS_CAPTION prints beside the table so the
 * word is never left to be guessed at. The library's values are unchanged —
 * this is the render layer only.
 */
var CLASS_LABEL = { question: 'question', instruction: 'other', mixed: 'mixed', unknown: 'unclassified' };

var CLASS_CAPTION = 'other = imperative or declarative — the shipped rules split only questions; '
  + 'the three-way split arrives with enrichment';

function classChip(cls) {
  var known = Object.prototype.hasOwnProperty.call(CLASS_LABEL, cls);
  return '<span class="pr-cat"' + (known && cls !== 'unknown' ? ' data-on="1"' : '') + '>'
    + esc(known ? CLASS_LABEL[cls] : cls) + '</span>';
}

// Up to three masked-session links, then a count. The links go through the
// existing #usage/<id> route, which is the server-masked transcript reader —
// this table never holds transcript content of its own. Three is the
// projection's own cap: a link affordance, not a membership dump.
function sessionLinks(c) {
  var ids = Array.isArray(c.sampleSessionIds) ? c.sampleSessionIds : [];
  var shown = ids.map(function (id, i) {
    return '<a class="pr-sess mono" href="#usage/' + encodeURIComponent(id) + '">'
      + esc('#' + (i + 1)) + '</a>';
  }).join('');
  var more = (Number(c.sessions) || 0) - ids.length;
  return shown + (more > 0 ? '<span class="pr-more mono">+' + esc(num(more)) + '</span>' : '');
}

/**
 * What the Pattern column shows. A CURATED or SEEDED name is shown whole. A
 * CHARACTERIZED descriptor is trimmed to its leading clause, because the rest
 * of it — "· 6 sessions · both hosts" — is exactly what the Sessions and Hosts
 * columns beside it already say, and a table that prints the same fact twice
 * trains the reader to skip the column that matters.
 *
 * The full descriptor stays as the row's tooltip: it is the string the CLI
 * prints, where there are no columns to carry those numbers.
 */
/**
 * A characterized descriptor ends in the class NOUN the vocabulary picked —
 * "Recurring 3-token instruction". That is the same claim CLASS_LABEL exists to
 * refuse: the shipped rules never separated imperative from declarative. The
 * noun is neutralised to "prompt" here, which is also the vocabulary's own
 * fallback, and the Type column beside it carries the class. Neither repeats
 * the other, and neither over-states.
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
  // A characterized descriptor is MACHINE-generated, so the class noun is
  // neutralised in the title as well as in the cell. A tooltip is a DOM
  // surface: a cell reading "prompt" whose hover reads "instruction" makes the
  // same over-claim the cell was cleaned of, and hides it where a reader is
  // less likely to challenge it.
  var parts = full.split(' · ');
  parts[0] = neutralizeLead(parts[0]);
  var neutral = parts.join(' · ');
  return '<span class="pr-name" title="' + esc(neutral) + '">' + esc(parts[0]) + '</span>';
}

export function patternsTable(p) {
  var pp = pat(p);
  if (!pp) return '<div class="empty">patterns were not computed for this window.</div>';
  var all = Array.isArray(pp.clusters) ? pp.clusters : [];
  if (!all.length) {
    return '<div class="empty">no prompt repeated across enough sessions or days to cluster. '
      + 'That is a clean result, not a missing one.</div>';
  }
  var rows = all.slice(0, PATTERN_ROWS);
  return '<div class="pr-tablewrap" role="region" aria-label="Repeated prompt patterns" tabindex="0">'
    + '<table class="pr-table"><caption class="sr-only">Recurring prompt clusters, their span, and '
    + 'the change each one suggests.</caption>'
    + '<thead><tr><th scope="col">Pattern</th><th scope="col">Type</th><th scope="col">n</th>'
    + '<th scope="col">Sessions</th><th scope="col">Days</th><th scope="col">Hosts</th>'
    + '<th scope="col">Suggested move</th><th scope="col">Open</th></tr></thead><tbody>'
    + rows.map(patternRow).join('')
    + '</tbody></table></div>'
    + '<div class="pr-caveat">' + esc(CLASS_CAPTION) + '</div>'
    + countNote(all.length, rows.length, 'recurring cluster')
    + exactRepeatsBlock(pp);
}

/**
 * A sliced list ALWAYS prints its denominator, whether or not it was cut.
 *
 * "Showing 6 of 6" costs a line and tells a reader they are looking at the
 * whole thing; a line that appears only when something is hidden leaves them
 * to infer completeness from silence, which is the same misreading a display
 * cap creates in the first place. The projection carries the total, so this is
 * never an estimate.
 */
function countNote(total, shown, noun) {
  var more = total - shown;
  return '<div class="pr-more-note">Showing <b>' + esc(num(shown)) + '</b> of <b>'
    + esc(num(total)) + '</b> ' + esc(noun) + (total === 1 ? '' : 's')
    + (more > 0
      ? ' &mdash; the ' + esc(num(shown)) + ' largest. Every figure above counts all '
        + esc(num(total)) + '.'
      : ' &mdash; all of them.')
    + '</div>';
}

function patternRow(c) {
  var label = c.label || {};
  return '<tr>'
    + '<th scope="row">' + patternName(label)
    + '<span class="pr-src mono">' + esc(label.source) + '</span></th>'
    + '<td>' + classChip(c.class) + '</td>'
    + '<td class="tnum">' + esc(num(c.count)) + '</td>'
    + '<td class="tnum">' + esc(num(c.sessions)) + '</td>'
    + '<td class="tnum">' + esc(num(c.days)) + '</td>'
    + '<td>' + (Array.isArray(c.hosts) ? c.hosts.map(function (h) {
      return '<span class="pr-hostchip">' + esc(h) + '</span>';
    }).join('') : '') + '</td>'
    + '<td>' + moveChip(c.class) + '</td>'
    + '<td>' + sessionLinks(c) + '</td>'
    + '</tr>';
}

/**
 * The identical-text half, beside the loose-cluster half.
 *
 * They answer different questions and the panel keeps them apart on purpose:
 * a cluster of eleven wordings says there is no canonical form for a request,
 * where an exact repeat says the same sentence was typed verbatim N times. The
 * second is the weaker signal — the research measured it finding far less — so
 * it renders as a compact tail rather than a second table.
 */
function exactRepeatsBlock(pp) {
  var all = Array.isArray(pp.exactRepeats) ? pp.exactRepeats : [];
  if (!all.length) return '';
  var rows = all.slice(0, EXACT_ROWS);
  return '<div class="pr-exact"><h4>Typed verbatim, more than once</h4>'
    + '<div class="pr-exact-rows">' + rows.map(function (r) {
      return '<span class="pr-exact-row">'
        + '<b class="tnum">' + esc(num(r.count)) + '&times;</b> '
        + esc(num(r.tokens)) + '-token prompt <i>' + esc(plural(r.sessions, 'session')) + ' · '
        + esc(plural(r.days, 'day')) + '</i></span>';
    }).join('') + '</div>'
    + countNote(all.length, rows.length, 'exact repeat')
    + '<p class="pr-exact-note">Identical normalized text, so these are exact by construction &mdash; '
    + 'the loose clusters above are where phrasing variance shows up. Exemplar text lives in '
    + '<code>ak usage prompts</code>, never here.</p></div>';
}

// ── re-asks and coaching ────────────────────────────────────────────────────

/**
 * Re-asks as aggregates. `gapHist` counts how many turns apart a repeat landed,
 * and gap 1 is the load-bearing bucket: a re-ask on the very next turn means
 * the model's previous answer is what failed, not a thread that drifted.
 */
export function reAskPanel(p) {
  var pp = pat(p);
  var r = pp && pp.reAsks;
  if (!r) return '';
  if (!r.pairCount) {
    return '<div class="pr-reask">No prompt was asked twice inside one session this window.</div>';
  }
  var gaps = r.gapHist || {}, immediate = Number(gaps[1]) || 0;
  return '<div class="pr-reask"><b>' + esc(num(r.pairCount)) + '</b> re-ask'
    + (r.pairCount === 1 ? '' : 's') + ' across <b>' + esc(num(r.sessionCount)) + '</b> session'
    + (r.sessionCount === 1 ? '' : 's')
    + (immediate
      ? ' &middot; <b>' + esc(share(ratio(immediate, r.pairCount)))
        + '</b> landed on the very next turn, which points at the answer rather than the thread'
      : '')
    + '.</div>';
}

// The section ships as a labelled shell. Cards need the outcome ledger to
// carry their evidence hash and their adopted/dismissed state, and a card
// without those is a suggestion that cannot be measured, dismissed, or
// retired — which is the thing this design set out not to build.
export function coachingPlaceholder() {
  return '<div class="pr-pending">'
    + '<h4>Coaching arrives with the outcome ledger</h4>'
    + '<p>Each card will pair a finding with one concrete change, the labelled basis for its estimate, '
    + 'and a <b>draft-only</b> affordance &mdash; nothing writes to CLAUDE.md, creates a skill, or '
    + 'changes configuration on its own.</p>'
    + '<p class="pr-pending-note">Held back deliberately: a card carries the evidence hash of the '
    + 'findings it came from, so a rescan can mark it stale, and an adopted card is measured against '
    + 'what actually changed. Without that ledger a card is advice nobody can hold to account.</p>'
    + '</div>';
}
