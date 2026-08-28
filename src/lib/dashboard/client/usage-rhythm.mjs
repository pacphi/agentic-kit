// @ts-nocheck — browser bundle source (never node-imported; client.mjs
// reads it as text). See src/lib/dashboard/client/**'s eslint.config.mjs
// override comment for why this directory isn't run through the node lib.

// Pure string-building chart primitives for the Usage tab's rhythm/mode
// panels (Task 9 wires these exports into usage.mjs). No DOM access, no
// fetch, no module-level state — every function takes plain data in and
// returns markup out. `esc` is copied from ./groups.mjs's real implementation
// rather than imported: bootstrap.mjs's own `esc` is only a build-time
// PLACEHOLDER (see client.mjs's inject()), so importing it here would pull in
// the stub, not the real escaper.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Shared pixel plot height for the two bar-style charts below (histogram,
// stackedDays), computed in PIXELS rather than CSS percent: a percent height
// needs every ancestor in the chain to declare an explicit height, which the
// flex layouts here deliberately don't — columns size to content and
// bottom-align on a shared baseline via align-items:flex-end instead.
var PLOT_H = 72;

function fmtDeltaNumber(n) {
  var r = Math.round(n * 10) / 10;
  return String(Number.isInteger(r) ? Math.round(r) : r);
}

// '' when there is no previous window to compare against — null/undefined
// prev, or prev===0 (a zero baseline can't produce a meaningful ratio; this
// dashboard never invents a claim it can't compute — same "no $ claimed"
// discipline usage.mjs's insightCard() already applies). Direction is purely
// mathematical (curr vs prev); `downIsGood` and `neutral` only affect the
// TONE (good/bad/flat), never which arrow is drawn.
export function deltaChip(curr, prev, opts) {
  var o = opts || {};
  var downIsGood = !!o.downIsGood, neutral = !!o.neutral, unit = o.unit || '';
  if (prev == null || prev === 0) return '';
  var c = Number(curr) || 0, p = Number(prev) || 0, delta = c - p;
  var magTxt = unit ? fmtDeltaNumber(Math.abs(delta)) : String(Math.round(Math.abs(delta / p * 100)));
  // A change that ROUNDS AWAY is not a direction this chip can claim. "▲0%"
  // and "▲0 pp" both draw an arrow for a move the printed number says did not
  // happen, which reads as a rendering bug at best and as a trend at worst —
  // so a zero magnitude falls back to the flat mark whatever the raw sign was.
  var dir = Number(magTxt) === 0 ? 'flat' : (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat');
  var arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•';
  var tone = (neutral || dir === 'flat') ? 'flat' : (((dir === 'up') !== downIsGood) ? 'good' : 'bad');
  var valueTxt = unit ? magTxt + esc(unit) : magTxt + '%';
  return '<span class="dchip" data-tone="' + tone + '">'
    + '<i class="dchip-arrow" aria-hidden="true">' + arrow + '</i>'
    + '<b class="dchip-val tnum">' + valueTxt + '</b></span>';
}

// '' when fewer than 2 finite points remain. No axes, no gridlines — a
// de-emphasis-ink trend line with one accent dot at the most recent point,
// meant to sit inline next to a KPI rather than stand alone as a chart.
//
// A non-finite entry is a GAP, not a dropped point: it keeps its slot on the
// x axis and the line BREAKS across it, emitting one polyline per run of
// consecutive finite points. Compacting it away instead would silently
// squeeze the time axis — three missing days would render as one step — and
// carrying a neighbour's value forward would state a figure for a day that
// has none. A visible break says "no measurement here", which is the truth.
export function sparklineSvg(series, opts) {
  var o = opts || {}, w = o.w || 130, h = o.h || 24;
  var raw = Array.isArray(series) ? series : [];
  var pts = raw.filter(Number.isFinite);
  if (pts.length < 2) return '';
  var pad = 2, innerW = w - pad * 2, innerH = h - pad * 2;
  var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts), span = (max - min) || 1;
  var span2 = raw.length > 1 ? raw.length - 1 : 1;
  // One run per unbroken stretch of measured points; a lone point between two
  // gaps has no segment to draw and is skipped by the length check below.
  var runs = [], run = [], last = null;
  raw.forEach(function (v, i) {
    if (!Number.isFinite(v)) { if (run.length) runs.push(run); run = []; return; }
    var p = [pad + (i / span2) * innerW, pad + innerH - ((v - min) / span) * innerH];
    run.push(p); last = p;
  });
  if (run.length) runs.push(run);
  var lines = runs.filter(function (r) { return r.length > 1; }).map(function (r) {
    return '<polyline class="spark-line" fill="none" points="'
      + esc(r.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ')) + '"/>';
  }).join('');
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h
    + '" focusable="false" aria-hidden="true">' + lines
    + '<circle class="spark-dot" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.2"/>'
    + '</svg>';
}

// The `q`th percentile of a bucketed distribution, in the buckets' own unit —
// the SAME linear-interpolation rule usage-aggregate.mjs's
// percentileFromBuckets applies server-side, restated here because this file
// is read as text into a browser bundle that cannot import a node module. A
// test pins the two implementations to identical output, so a divergence goes
// red instead of quietly disagreeing with the server-computed number printed
// beside it.
//
// Two honest edges, both inherited on purpose:
//   - an empty histogram is null, never 0 — "nothing was measured" and
//     "measured zero" are different claims;
//   - the overflow bucket has no upper edge to interpolate towards, so it
//     reports its FLOOR. Read that as "at least this", which is why every
//     caller prefixes such a value with "≥" rather than printing it bare.
export function bucketPercentile(counts, edges, q) {
  if (!Array.isArray(counts) || !Array.isArray(edges)) return null;
  var total = counts.reduce(function (a, n) { return a + (Number(n) || 0); }, 0);
  if (total <= 0) return null;
  // 2dp, the same rounding the server applies before putting its own
  // percentiles on the wire — so the two implementations are comparable by
  // strict equality rather than by an epsilon a test would have to choose.
  var r2 = function (v) { return Math.round(v * 100) / 100; };
  var target = total * q, cum = 0;
  for (var i = 0; i < counts.length; i++) {
    var n = Number(counts[i]) || 0;
    if (n <= 0) continue;
    if (cum + n >= target) {
      var lo = i === 0 ? 0 : edges[i - 1];
      if (i >= edges.length) return r2(lo);
      return r2(lo + (edges[i] - lo) * ((target - cum) / n));
    }
    cum += n;
  }
  return r2(edges[edges.length - 1]);
}

// Where a bucketed VALUE sits along the histogram's axis, as 0-100. That axis
// is BUCKET SLOTS, not values: slot i spans [i/n,(i+1)/n] and the value is
// placed inside its own slot by the same linear rule that produced it, so a
// marker drawn here always lands in the bucket its percentile came from.
// Deliberately ignores the 6px inter-bar gap — a sub-4px offset on a dashed
// rule that carries its own printed label, against the alternative of teaching
// this pure function the CSS's box metrics.
export function bucketPositionPct(edges, value) {
  if (!Array.isArray(edges) || !edges.length || !Number.isFinite(value)) return null;
  var slots = edges.length + 1, i = edges.length;
  for (var e = 0; e < edges.length; e++) { if (value <= edges[e]) { i = e; break; } }
  var lo = i === 0 ? 0 : edges[i - 1];
  var frac = i >= edges.length ? 0 : ((edges[i] > lo) ? (value - lo) / (edges[i] - lo) : 0);
  return Math.max(0, Math.min(100, ((i + frac) / slots) * 100));
}

// Bars are one sequential hue (accent) — a magnitude series, not a category
// split, so there is nothing for a second color to distinguish. Markers are
// emitted BEFORE the bars in DOM order and absolutely overlay the same box
// (see .hist-markers/.hist-plot in styles/usage.mjs) — but DOM order alone
// only decides paint order WITHIN one stacking layer. .hist-bars is also
// given position:relative in that CSS, so it joins .hist-markers' positioned
// layer instead of losing to it outright; only then does "markers first,
// bars second" in the markup make the bars paint over the marker lines
// where they cross. The marker's own label sits above the whole plot
// instead, so it is never itself covered by a tall bar.
export function histogram(opts) {
  var o = opts || {};
  var counts = Array.isArray(o.counts) ? o.counts : [];
  var labels = Array.isArray(o.labels) ? o.labels : [];
  var markers = Array.isArray(o.markers) ? o.markers : [];
  var max = counts.reduce(function (m, v) { return Math.max(m, Number(v) || 0); }, 0);
  var bars = counts.map(function (v) {
    var n = Number(v) || 0;
    var px = max ? Math.max(2, (n / max) * PLOT_H) : 2;
    return '<div class="hist-bar"><span class="hist-val tnum">' + esc(n) + '</span>'
      + '<i class="hist-fill" style="height:' + px.toFixed(1) + 'px"></i></div>';
  }).join('');
  var labs = labels.map(function (l) { return '<span class="hist-lab">' + esc(l) + '</span>'; }).join('');
  var marks = markers.map(function (m) {
    var at = Math.max(0, Math.min(100, Number(m && m.atPct) || 0));
    return '<span class="hist-marker" style="left:' + at.toFixed(1) + '%">'
      + '<i class="hist-marker-line"></i><b class="hist-marker-lab">' + esc(m && m.label) + '</b></span>';
  }).join('');
  return '<div class="hist"><div class="hist-plot">'
    + '<div class="hist-markers">' + marks + '</div>'
    + '<div class="hist-bars">' + bars + '</div>'
    + '</div><div class="hist-labs">' + labs + '</div></div>';
}

// 'not-recorded'/'other' are always the de-emphasis token (--ink-dim), never
// a series color, regardless of what the caller's palette maps them to — the
// same "the uncategorized bucket is de-emphasis, not a hue" rule
// renderScoreCategories already applies to Unclassified (var(--ink-dim)
// instead of var(--accent)) elsewhere in this bundle.
function segColor(key, palette) {
  if (key === 'not-recorded' || key === 'other') return 'var(--ink-dim)';
  return (palette && palette[key]) || 'var(--ink-dim)';
}

// order is bottom-up; segments render in that same sequence inside a
// column-reverse flex (2px gap), so the LAST key in order is what actually
// paints at the top. A day where the nominal top series is zero still needs
// ITS topmost non-zero segment rounded, not a hard-coded index — topIdx is
// recomputed per day from whichever segments actually render.
export function stackedDays(opts) {
  var o = opts || {};
  var days = Array.isArray(o.days) ? o.days : [];
  var order = Array.isArray(o.order) ? o.order : [];
  var palette = o.palette || {};
  var totals = days.map(function (d) {
    var parts = (d && d.parts) || {};
    return order.reduce(function (sum, key) { return sum + (Number(parts[key]) || 0); }, 0);
  });
  var maxTotal = totals.reduce(function (m, v) { return Math.max(m, v); }, 0);
  var cols = days.map(function (d, i) {
    var parts = (d && d.parts) || {}, total = totals[i];
    var barPx = maxTotal ? Math.max(2, (total / maxTotal) * PLOT_H) : 2;
    var segs = order.map(function (key, idx) { return { key: key, idx: idx, v: Number(parts[key]) || 0 }; })
      .filter(function (s) { return s.v > 0; });
    var topIdx = segs.reduce(function (m, s) { return Math.max(m, s.idx); }, -1);
    var segsHtml = segs.map(function (s) {
      var share = total ? (s.v / total) * 100 : 0;
      return '<i class="sday-seg' + (s.idx === topIdx ? ' top' : '') + '" style="height:'
        + share.toFixed(1) + '%;background:' + esc(segColor(s.key, palette))
        + '" title="' + esc(s.key + ': ' + s.v) + '"></i>';
    }).join('');
    var dayRaw = String((d && d.day) || '');
    var dayLab = esc(dayRaw.length >= 10 ? dayRaw.slice(8) : dayRaw);
    return '<div class="sday-col"><div class="sday-bar" style="height:' + barPx.toFixed(1) + 'px">'
      + segsHtml + '</div><span class="sday-lab">' + dayLab + '</span></div>';
  }).join('');
  return '<div class="stackdays">' + cols + '</div>';
}

// Two-slice conic-gradient ring with a small --line-colored seam at each
// boundary (never a bare transparent gap, which would read as a rendering
// bug rather than a deliberate seam).
function donutGradient(aPct) {
  var aDeg = (aPct / 100) * 360;
  var gap = (aPct > 0 && aPct < 100) ? 3 : 0;
  var aEnd = Math.max(0, aDeg - gap / 2);
  var bStart = Math.min(360, aDeg + gap / 2);
  var bEnd = Math.max(bStart, 360 - gap / 2);
  return 'conic-gradient(var(--accent) 0deg ' + aEnd.toFixed(1) + 'deg,'
    + 'var(--line) ' + aEnd.toFixed(1) + 'deg ' + bStart.toFixed(1) + 'deg,'
    + 'var(--purple) ' + bStart.toFixed(1) + 'deg ' + bEnd.toFixed(1) + 'deg,'
    + 'var(--line) ' + bEnd.toFixed(1) + 'deg 360deg)';
}

// The hole is masked on the RING element only; the center label is a
// sibling, not a descendant, of the masked element, so it is never itself
// clipped. Side labels always carry both the series name and its value —
// the swatch color is a hint, not the only way to tell A from B.
//
// `aValue`/`bValue` are the RAW numbers that set the geometry; `aText`/`bText`
// are what the legend prints, defaulting to those numbers. The split exists
// because the two are not interchangeable for money: the arc has to be drawn
// from 12.3456 while the label has to read "$12.35", and re-deriving one from
// the other would either round the arc or print an unformatted float.
export function donut2(opts) {
  var o = opts || {};
  var a = Number(o.aValue) || 0, b = Number(o.bValue) || 0, total = a + b;
  var aPct = total ? (a / total) * 100 : 50;
  var aText = o.aText == null ? a : o.aText, bText = o.bText == null ? b : o.bText;
  return '<div class="donut2-wrap"><div class="donut2">'
    + '<i class="donut2-ring" style="background:' + donutGradient(aPct) + '"></i>'
    + '<b class="donut2-center">' + esc(o.centerLabel) + '</b></div>'
    + '<div class="donut2-legend">'
    + '<span class="donut2-item"><i style="background:var(--accent)"></i>' + esc(o.aLabel)
    + ' <b class="tnum">' + esc(aText) + '</b></span>'
    + '<span class="donut2-item"><i style="background:var(--purple)"></i>' + esc(o.bLabel)
    + ' <b class="tnum">' + esc(bText) + '</b></span>'
    + '</div></div>';
}

// share (0-100) drives the track width directly — this never re-derives a
// share from `value`, which may already be a caller-formatted string (e.g.
// "$12.40") rather than a raw number this function could sum or compare.
export function rankedRows(rows) {
  var list = Array.isArray(rows) ? rows : [];
  return '<div class="rrows">' + list.map(function (r) {
    var share = Math.max(0, Math.min(100, Number(r && r.share) || 0));
    var dim = !!(r && r.dim);
    return '<div class="rrow"><span class="rrow-label">' + esc(r && r.label) + '</span>'
      + '<span class="rrow-track"><i class="rrow-fill' + (dim ? ' dim' : '')
      + '" style="width:' + share.toFixed(1) + '%"></i></span>'
      + '<span class="rrow-val tnum">' + esc(r && r.value) + '</span></div>';
  }).join('') + '</div>';
}
