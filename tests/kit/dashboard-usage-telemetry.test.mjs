import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { JS } from '../../src/lib/dashboard/client.mjs';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
import { CSS } from '../../src/lib/dashboard/styles.mjs';
import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';
import { blankSession, addUsage } from '../../src/lib/usage-parsers.mjs';
import { MODES } from '../../src/lib/usage-modes.mjs';
import {
  deltaChip, sparklineSvg, histogram, stackedDays, donut2, rankedRows,
  bucketPercentile, bucketPositionPct,
} from '../../src/lib/dashboard/client/usage-rhythm.mjs';
import {
  percentileFromBuckets, LAT_BUCKET_EDGES, LEN_BUCKET_EDGES,
} from '../../src/lib/usage-aggregate.mjs';

const PAGE = renderPage({ name: 'agentic-kit', version: 'test' });

// The telemetry-coverage panel is gone: it published a per-host capability
// matrix — a claim about what a parser could report — beside the scorecard's
// measured figures, where a reader could not tell the two apart. Source
// STATUS still reaches the reader, in the tabbar pills, on every tab.
test('the scorecard no longer ships a telemetry coverage panel', () => {
  assert.doesNotMatch(PAGE, /u-telemetry/);
  assert.doesNotMatch(PAGE, /telemetry coverage/i);
  assert.doesNotMatch(JS, /renderTelemetryCoverage/);
  assert.doesNotMatch(JS, /telemetry coverage/i);
  assert.doesNotMatch(CSS, /\.telemetry-(card|grid)/);
});

// The tabbar pills outlived the panel, and they must not carry its leftovers:
// a read of a field nothing populates renders nothing, but it reads as though
// the payload still carries a capability matrix. Their real input is
// status/reason (plus the counted diagnostics), asserted here alongside.
test('the source-health pills read status and reason, never a capability field', () => {
  assert.doesNotMatch(JS, /item\.capabilities/);
  assert.doesNotMatch(JS, /pt\.capabilities/);
  assert.doesNotMatch(JS, /caps\.toolCalls/);
  assert.match(JS, /status:String\(item\.status\|\|"not-read"\),reason:item\.reason/);
  assert.match(JS, /pt\.status\+\(pt\.reason\?" · "\+pt\.reason:""\)/);
  assert.match(JS, /sp-status/, 'the pill still renders the lead status');
});

// ── /api/usage payload: rhythm, mode, provider, previous window ────────────
//
// The dashboard-server route delegates its entire aggregation to an
// INJECTED `usage.readIndex` (see tests/dashboard.test.cjs's spyUsage()
// convention), so a real end-to-end exercise here means the fake readIndex
// itself must behave like usage-index.mjs's corrected contract: always
// aggregate the DISPLAYED window at `now - days*DAY_MS`, and forward
// `previous` verbatim. That is deliberate — it is what actually proves
// dashboard-server.mjs passes `lookbackDays`/`previous` through, rather than
// a canned fixture that would pass regardless of what handleUsage sends.
//
// Fixture records are built with usage-parsers.mjs's own blankSession/
// addUsage — the same construction tests/kit/usage-index.test.mjs's local
// `record()` helper uses (that helper is not exported, so it is restated
// here in miniature rather than imported).
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-08-20T12:00:00.000Z');

function usageRecord(id, { end, mode = null, usageRows = [] }) {
  const rec = blankSession(id, 'claude');
  const start = end - 30 * 60_000;
  Object.assign(rec, { title: id, project: 'proj', prompts: 1, responses: 1, start, end, mode });
  rec.active = [[start, end]];
  for (const u of usageRows) addUsage(rec, u.day, u.model, u);
  rec.models = [...new Set(usageRows.map((u) => u.model))];
  rec.lenSeconds = Math.round((end - start) / 1000);
  return rec;
}

const FIXTURE_RECORDS = [
  // Inside the displayed 7-day window.
  usageRecord('cur', {
    end: NOW - 2 * DAY_MS,
    mode: 'auto-edit',
    usageRows: [{ day: '2026-08-18', model: 'claude-opus-5', input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, responses: 1 }],
  }),
  // 10 days back — outside the 7-day display window, but inside the
  // previous [14d, 7d) window once lookbackDays widens discovery.
  usageRecord('prev', {
    end: NOW - 10 * DAY_MS,
    usageRows: [{ day: '2026-08-10', model: 'claude-opus-5', input: 800, output: 400, cacheRead: 0, cacheWrite: 0, responses: 1 }],
  }),
];

const FIXTURE_DEPS = {
  costOf: ({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) => (input + output + cacheRead + cacheWrite) / 1000,
  pricesAsOf: '2026-08-01',
  classify: () => ({ category: 'Unclassified', confidence: 0, basis: 'no signal' }),
  detectInsights: () => [],
};

function get(url, token) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { 'x-dash-token': token } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('/api/usage payload carries rhythm, mode, provider and a previous-window projection', async () => {
  const calls = [];
  // Mirrors usage-index.mjs's corrected buildIndex/scan contract (Task 7
  // ruling B): `aggregate` always sees the DISPLAY cutoff, and `previous`
  // rides through from the caller's own options unchanged.
  const usage = {
    readIndex: async (opts) => {
      calls.push(opts);
      const days = opts?.days ?? 14;
      return aggregate(FIXTURE_RECORDS, {
        days, now: NOW, cutoff: NOW - days * DAY_MS, deps: FIXTURE_DEPS, previous: !!opts?.previous,
      });
    },
  };
  const srv = await startDashboard({
    port: 0, fetchStatus: async () => ({ overall: 'ok', rows: [] }), usage,
  });
  try {
    const r = await get(`${srv.url}api/usage?days=7`, srv.token);
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const payload = JSON.parse(r.body);

    assert.equal(payload.rhythm.latHist.length, 6, 'the latency histogram always has 6 buckets');

    const allowedModes = new Set([...MODES, 'not-recorded']);
    for (const key of Object.keys(payload.byMode)) {
      assert.ok(allowedModes.has(key), `unexpected byMode key ${JSON.stringify(key)}`);
    }

    assert.equal(typeof payload.engagedByDay, 'object');
    assert.ok(payload.engagedByDay && !Array.isArray(payload.engagedByDay), 'engagedByDay is a plain map, not an array');
    for (const v of Object.values(payload.engagedByDay)) {
      assert.ok(Number.isFinite(v), `engagedByDay value ${v} must be finite`);
    }

    assert.ok(payload.previous && typeof payload.previous === 'object', 'previous must be populated once fixture data spans two windows');
    assert.ok(payload.previous.totals && typeof payload.previous.totals === 'object',
      'previous.totals must exist — this is what proves lookbackDays/previous actually reached readIndex');
    assert.equal(payload.previous.totals.sessions, 1, 'only the 10-day-old session falls in the previous window');

    const call = calls.find((o) => o && o.days === 7);
    assert.ok(call, `days must reach readIndex, got ${JSON.stringify(calls)}`);
    assert.equal(call.lookbackDays, 14, 'lookbackDays must widen to 2x the displayed window');
    assert.equal(call.previous, true, 'previous must be requested so agg.previous is populated');
  } finally {
    await srv.close();
  }
});

// ── usage-rhythm.mjs: rhythm/mode chart primitives (Task 8) ────────────────
//
// These are pure string builders, imported directly here — real ESM on disk,
// not read through the concatenated client.mjs bundle (that concatenation is
// exercised separately, above, via the `JS` import). Task 9 wires these
// exports into usage.mjs's panels.

test('deltaChip renders an up arrow and a rounded percent for a positive change', () => {
  const html = deltaChip(584, 540, {});
  assert.match(html, /▲/);
  assert.match(html, /8/);
});

test('deltaChip returns empty string when there is no previous window', () => {
  assert.equal(deltaChip(5, null, {}), '');
  assert.equal(deltaChip(5, undefined, {}), '');
  assert.equal(deltaChip(5, 0, {}), '', 'a zero previous value carries no meaning either — no window to compare against');
});

test('deltaChip tones a downIsGood decrease as good, and neutral forces flat styling', () => {
  const good = deltaChip(90, 100, { downIsGood: true });
  assert.match(good, /data-tone="good"/);
  assert.match(good, /▼/);
  const neutral = deltaChip(584, 540, { neutral: true });
  assert.match(neutral, /data-tone="flat"/);
});

test('deltaChip renders a unit-suffixed absolute delta instead of a percent when unit is given', () => {
  const html = deltaChip(120, 90, { unit: 'ms' });
  assert.match(html, /30ms/);
  assert.doesNotMatch(html, /%/);
});

test('sparklineSvg draws a polyline with an accent endpoint dot for 2+ finite points', () => {
  const html = sparklineSvg([1, 2, 3]);
  assert.match(html, /<svg/);
  assert.match(html, /polyline/);
  assert.match(html, /circle/);
});

test('sparklineSvg returns empty string for fewer than 2 finite points', () => {
  assert.equal(sparklineSvg([1]), '');
  assert.equal(sparklineSvg([]), '');
  assert.equal(sparklineSvg([1, NaN]), '', 'NaN is not a finite point, so only one point remains');
});

test('histogram renders a marker and its label, with the bars emitted after the markers in DOM order', () => {
  // DOM order alone does not prove paint order (a positioned element paints
  // above a non-positioned one regardless of DOM order — see the mark-rule
  // geometry test below for the CSS half of this: .hist-bars must ALSO be
  // positioned for "markers first" to actually put bars on top). This only
  // asserts the half a string test can honestly observe: markup order.
  // Task 9's screenshot verification is what confirms the rendered result.
  const html = histogram({ counts: [1, 5, 2], labels: ['<1s', '1-3s', '3s+'], markers: [{ atPct: 50, label: 'p50' }] });
  assert.match(html, /p50/);
  assert.match(html, /hist-marker/);
  const markersIdx = html.indexOf('hist-markers');
  const barsIdx = html.indexOf('hist-bars');
  assert.ok(markersIdx >= 0 && barsIdx > markersIdx, 'markers must be emitted before bars in the markup');
});

test('stackedDays maps not-recorded and other to the de-emphasis token, never a series color', () => {
  const html = stackedDays({
    days: [{ day: '2026-08-18', parts: { 'auto-edit': 4, 'not-recorded': 1, other: 2 } }],
    order: ['not-recorded', 'other', 'auto-edit'],
    palette: { 'auto-edit': 'var(--accent)', 'not-recorded': 'var(--fail)', other: 'var(--purple)' },
  });
  // The palette's own (wrong) colors for the two special keys must never appear.
  assert.doesNotMatch(html, /var\(--fail\)/);
  assert.doesNotMatch(html, /var\(--purple\)/);
  assert.match(html, /var\(--ink-dim\)/);
});

test('donut2 renders both side labels and the center label', () => {
  const html = donut2({ aLabel: 'Claude', aValue: 584, bLabel: 'Codex', bValue: 212, centerLabel: '73%' });
  assert.match(html, /Claude/);
  assert.match(html, /Codex/);
  assert.match(html, /73%/);
});

test('rankedRows renders a dim row with the de-emphasis fill class', () => {
  const html = rankedRows([{ label: 'Unclassified', value: '12', share: 40, dim: true }]);
  assert.match(html, /rrow-fill dim/);
});

test('every chart primitive with a free-text field escapes an injected <script> label', () => {
  // sparklineSvg is excluded — its only input is a plain number series, with
  // no free-text field for a caller to inject through.
  assert.doesNotMatch(deltaChip(120, 90, { unit: '<script>' }), /<script>/);
  assert.doesNotMatch(
    histogram({ counts: [1], labels: ['<script>'], markers: [{ atPct: 1, label: '<script>' }] }),
    /<script>/,
  );
  assert.doesNotMatch(
    stackedDays({ days: [{ day: '<script>', parts: { a: 1 } }], order: ['a'], palette: { a: '<script>' } }),
    /<script>/,
  );
  assert.doesNotMatch(
    donut2({ aLabel: '<script>', aValue: 1, bLabel: '<script>', bValue: 1, centerLabel: '<script>' }),
    /<script>/,
  );
  assert.doesNotMatch(rankedRows([{ label: '<script>', value: '<script>', share: 50 }]), /<script>/);
});

test('usage styles append the rhythm/mode chart primitive classes with the mark-rule geometry', () => {
  assert.match(CSS, /\.hist-fill\{[^}]*border-radius:4px 4px 0 0/, 'histogram bars get a 4px top radius');
  assert.match(CSS, /\.sday-bar\{[^}]*gap:2px/, 'stacked-day segments get a 2px gap');
  assert.match(CSS, /\.spark-line\{[^}]*stroke:var\(--ink-dim\)/, 'sparkline stroke is the de-emphasis ink');
  assert.match(CSS, /\.spark-dot\{[^}]*fill:var\(--accent\)/, 'sparkline endpoint dot is the accent color');
  // Structural half of "bars paint over marker lines": a positioned element
  // paints above a non-positioned one regardless of DOM order, so .hist-bars
  // must carry position:relative to even be eligible to win against the
  // positioned .hist-markers overlay — DOM order (asserted above, in the
  // histogram test) is the other half. This can't observe rendered paint
  // order itself; it only guards the CSS declaration that makes it possible.
  assert.match(CSS, /\.hist-bars\{[^}]*position:relative/, 'hist-bars must be positioned to paint over the positioned marker overlay');
});

// ── Task 9: the panels that consume all of the above ──────────────────────

test('usage-rhythm.mjs reaches the served bundle, with exactly one escaper in it', () => {
  // Without this splice every panel below throws ReferenceError in the browser
  // while every test that imports the module directly stays green — so the
  // bundle, not the module, is what this asserts against.
  assert.match(JS, /function deltaChip\(/, 'the rhythm primitives must be in the served bundle');
  assert.match(JS, /function bucketPercentile\(/);
  assert.match(JS, /function stackedDays\(/);
  // The module carries its own `esc` on disk (the direct-import tests above
  // depend on it). Two `function esc` declarations would share one bundle
  // scope and the later one would silently replace the injected groups.mjs
  // escaper with a copy free to drift from it, so client.mjs strips it.
  assert.equal((JS.match(/function esc\(/g) || []).length, 1, 'the bundle must declare exactly one esc');
  assert.doesNotMatch(JS, /^export function/m, 'no export survives into the classic-script bundle');
});

test('bucketPercentile reproduces the server percentile it is printed beside', () => {
  const cases = [
    [[0, 0, 0, 0, 0, 0], LAT_BUCKET_EDGES],
    [[10, 0, 0, 0, 0, 0], LAT_BUCKET_EDGES],
    [[3, 7, 11, 2, 1, 4], LAT_BUCKET_EDGES],
    [[0, 0, 0, 0, 0, 9], LAT_BUCKET_EDGES],
    [[1, 1, 1, 1, 1], LEN_BUCKET_EDGES],
    [[0, 0, 0, 0, 6], LEN_BUCKET_EDGES],
  ];
  for (const [counts, edges] of cases) {
    for (const q of [0.5, 0.9, 0.95]) {
      assert.equal(
        bucketPercentile(counts, edges, q),
        percentileFromBuckets(counts, edges, q),
        `client and server disagree on p${q * 100} of ${JSON.stringify(counts)}`,
      );
    }
  }
});

test('bucketPercentile reports the overflow bucket floor, never an invented ceiling', () => {
  assert.equal(bucketPercentile([0, 0, 0, 0, 0, 5], LAT_BUCKET_EDGES, 0.95), 60);
  assert.equal(bucketPercentile([0, 0, 0, 0, 5], LEN_BUCKET_EDGES, 0.9), 7200);
  assert.equal(bucketPercentile([], LAT_BUCKET_EDGES, 0.5), null, 'an empty histogram is null, not 0');
});

test('bucketPositionPct lands a value inside the slot its own bucket occupies', () => {
  // 6 slots for 5 edges: slot i spans [i/6,(i+1)/6] of the plot.
  assert.equal(bucketPositionPct(LAT_BUCKET_EDGES, 0), 0, 'the low end of the first slot');
  assert.ok(Math.abs(bucketPositionPct(LAT_BUCKET_EDGES, 1) - (0.5 / 6) * 100) < 0.001, 'halfway through slot 0');
  assert.ok(Math.abs(bucketPositionPct(LAT_BUCKET_EDGES, 60) - (5 / 6) * 100) < 0.001, 'the 60s edge is the overflow boundary');
  assert.ok(bucketPositionPct(LAT_BUCKET_EDGES, 900) <= 100, 'an overflow value never runs off the plot');
  assert.equal(bucketPositionPct(LAT_BUCKET_EDGES, null), null, 'a missing percentile places no marker');
});

test('hero tiles carry a windowed delta and a per-day trend, with cost read down-is-good', () => {
  assert.match(JS, /deltaChip\(t\.cost,p\.cost,\{downIsGood:true\}\)/, 'a cheaper window is the good direction');
  assert.match(JS, /deltaChip\(t\.tokens,p\.tokens,\{neutral:true\}\)/, 'more tokens is neither good nor bad on its own');
  assert.match(JS, /deltaChip\(t\.sessions,p\.sessions,\{\}\)/);
  assert.match(JS, /deltaChip\(t\.engagedSeconds,p\.engagedSeconds,\{\}\)/);
  // Cache SHARE is up-good (cache reads bill at 0.1x input) and its delta is
  // in percentage points — a percent-of-a-percent would name the wrong move.
  assert.match(JS, /deltaChip\(cacheShare,prevCacheShare,\{unit:" pp"\}\)/);
  assert.match(JS, /saved &asymp; /, 'the cache tile states what the cache avoided');
  assert.match(JS, /cacheSavedUsd/);
  // engagedByDay is a sibling map with its own day set, not a byDay field.
  assert.match(JS, /mapRows\(d\.engagedByDay\)/);
});

test('the cadence row is built once, after the hero, from totals the payload already carries', () => {
  assert.match(JS, /ensureBlock\("u-cadence",/, 'the row creates its own container — page.mjs has none');
  assert.match(JS, /"u-hero"\)/, 'anchored to the hero it continues');
  assert.match(JS, /responsesPerPrompt/);
  assert.match(JS, /humanPromptsPerHour/);
  assert.match(JS, /costPerSessionMedian/);
  assert.match(JS, /costPerSessionP90/);
  assert.match(JS, /costPerEngagedHour/);
  // Every new KPI states its formula AND its caveat, since each is a derived
  // rate rather than a measured total.
  assert.match(JS, /MAIN-THREAD only/, 'autonomy says whose prompts count');
  assert.match(JS, /structurally \$0/, 'the median says what it excludes');
  assert.match(JS, /15-minute silences/, 'cost-per-hour says which hours');
  assert.match(JS, /Streak counts consecutive active days/, 'the streak says what it counts');
  assert.match(JS, /a day worked but never billed is not counted/, 'the streak says what breaks it');
});

test('deltaChip refuses to draw a direction for a change that rounds away', () => {
  // "▲0%" and "▲0 pp" both put an arrow on a move the printed number says did
  // not happen. Real data hit this: cache share moved 0.04pp between windows.
  const tiny = deltaChip(96.84, 96.80, { unit: ' pp' });
  assert.match(tiny, /data-tone="flat"/);
  assert.match(tiny, /•/);
  assert.doesNotMatch(tiny, /▲|▼/);
  assert.match(deltaChip(1004, 1000, {}), /data-tone="flat"/, 'a 0.4% move rounds to 0% and is flat too');
  // A change that survives rounding still gets its arrow and its tone.
  assert.match(deltaChip(584, 540, {}), /▲/);
  assert.match(deltaChip(50, 100, { downIsGood: true }), /data-tone="good"/);
});

test('60 seconds reads as 60s, so the overflow prefix names the bucket edge on the axis', () => {
  // fmtSecs rolled 60 up to "1m", which made the ruled "≥60s" render "≥1m" —
  // a percentile labelled with a boundary that appears nowhere on the axis.
  assert.match(JS, /if\(sec<=60\)return/);
  assert.match(JS, /var LAT_LABELS=\["≤2s","≤5s","≤10s","≤30s","≤60s",">60s"\]/);
});

test('donut2 draws the arc from the raw value while the legend prints the caller-formatted text', () => {
  const html = donut2({
    aValue: 12.3456, bValue: 4.1, aText: '$12.35', bText: '$4.10',
    aLabel: 'main thread', bLabel: 'subagent', centerLabel: '75%',
  });
  assert.match(html, /\$12\.35/, 'the legend prints the formatted money, not the float');
  assert.doesNotMatch(html, /12\.3456/, 'the unformatted value never reaches the legend');
  assert.match(html, /conic-gradient/, 'the arc is still drawn');
  // Without aText/bText the raw number is the label, as before.
  assert.match(donut2({ aValue: 3, bValue: 1, aLabel: 'a', bLabel: 'b' }), /<b class="tnum">3<\/b>/);
});

test('the rhythm panel labels buckets on the same edges the server binned them with', () => {
  // The payload ships COUNTS, never the edges. A drift here would relabel
  // every bar without changing a single number, which is the silent failure
  // this pin exists to make loud.
  assert.match(JS, new RegExp(`var LAT_EDGES=\\[${LAT_BUCKET_EDGES.join(',')}\\]`));
  assert.match(JS, new RegExp(`var LEN_EDGES=\\[${LEN_BUCKET_EDGES.join(',')}\\]`));
  assert.match(JS, /var LAT_LABELS=\["≤2s","≤5s","≤10s","≤30s","≤60s",">60s"\]/);
  assert.match(JS, /var LEN_LABELS=\["≤5m","≤15m","≤45m","≤2h",">2h"\]/);
});

test('an overflow-bucket percentile is printed with a ≥ prefix, never as a bare figure', () => {
  // The overflow bucket has no upper edge, so its percentile is the FLOOR:
  // latP95 === 60 must read "≥60s" and lenP90Seconds === 7200 must read "≥2h".
  assert.match(JS, /function fmtAtLeast\(v,lastEdge,fmt\)\{[\s\S]{0,120}v>=lastEdge\?"≥":""/);
  assert.match(JS, /fmtAtLeast\(p95,60,fmtSecs\)/, 'latency percentiles carry the 60s overflow floor');
  assert.match(JS, /fmtAtLeast\(p90,7200,fmtSecs\)/, 'session-length percentiles carry the 2h overflow floor');
});

test('the latency card states how latency was measured, on the card itself', () => {
  assert.match(JS, /codex host-measured · claude\/opencode derived from event gaps — not streaming TTFT/);
  assert.match(JS, /latP50/);
  assert.match(JS, /latP95/);
  assert.match(JS, /latCount/, 'the card says how many gaps it measured');
  assert.match(JS, /no response latency measured in window/, 'nothing measured renders an empty state, not a zero');
});

test('the posture stack ships its own legend, because stackedDays draws none', () => {
  assert.match(JS, /stackedDays\(\{days:days,order:present,palette:MODE_COLOR\}\)/);
  assert.match(JS, /\+chartLegend\(legend\)/, 'the stacked chart is followed by an external legend');
  assert.match(JS, /function chartLegend\(items\)/);
  // The unobserved bucket is de-emphasis ink, never a posture color — so it
  // deliberately has no palette entry of its own.
  assert.match(JS, /var MODE_COLOR=\{plan:"var\(--purple\)",guarded:"var\(--ok\)","auto-edit":"var\(--accent\)",\s*unrestricted:"var\(--fail\)"\}/);
  assert.doesNotMatch(JS, /MODE_COLOR=\{[^}]*not-recorded/);
});

// The panel is posture + delegation. It once carried a third block ranking
// window spend by inference provider; a transcript host does not prove which
// vendor served the tokens, so that axis was removed rather than shipped with
// most of its spend in a "Not recorded" row. Provider identity is still on the
// session row, where the evidence for it actually lives.
test('how-you-run is posture and delegation, with no aggregate provider ranking', () => {
  assert.match(JS, /aValue:main,bValue:sub/, 'the donut is main vs subagent cost');
  assert.match(JS, /d\.bySource/);
  assert.doesNotMatch(JS, /byInferenceProvider/);
  assert.doesNotMatch(JS, /function providerRows/);
});

test('the tool list folds its tail into a dim Other instead of dropping it', () => {
  // A top-8 list that silently loses the rest misstates the total every share
  // above it is read against, so the tail is summed and labelled.
  assert.match(JS, /var TOOL_TOP=8/);
  assert.match(JS, /list\.slice\(TOOL_TOP\)/, 'the tail is kept, not discarded');
  assert.match(JS, /label:"Other \("\+tail\.length\+" tool"/);
  assert.match(JS, /share:pct\(other,max\),dim:true/, 'Other is a residue, drawn dim');
});

test('model mix keeps four named families and folds the rest into one dim band', () => {
  assert.match(JS, /var FAMILY_TOP=4/);
  assert.match(JS, /byModelFamily/);
  assert.match(JS, /function foldFamilies\(parts,keep\)/);
  assert.match(JS, /order:\["other"\]\.concat\(keep\.slice\(\)\.reverse\(\)\)/, 'the fold sits at the base of the stack');
  assert.match(JS, /\+chartLegend\(legend\)/, 'the stack is named by an external legend');
  // modelFamily()'s own catch-all never competes for a top slot — it IS the
  // residue bucket, whatever its size.
  assert.match(JS, /for\(k in tot\)if\(k!=="other"\)/);
});

test('reliability states a rate with its denominator, and flags direction in words not only color', () => {
  assert.match(JS, /exceptions \/ 1k responses/);
  assert.match(JS, /\(Number\(t\.exceptions\)\|\|0\)\/r\*1000/);
  // aborts is CODEX-ONLY evidence — turn_aborted is the only interrupt signal
  // any host writes. These three assertions used to pin the opposite: they
  // asserted the presence of an unconditional count and of the tooltip
  // sentence "Turns the transcript recorded as interrupted", which is false
  // for a claude-only corpus. They now pin the capability gate, so reverting
  // to the measured-looking zero goes red instead of staying green.
  assert.match(JS, /aborted turns/, 'aborts are counted apart from exceptions');
  assert.match(JS, /value:cxSess\?fmtNum\(ab\):"—"/,
    'no codex sessions in the window → em dash, never a 0 that reads as "you never interrupted a turn"');
  assert.match(JS, /ab\/cxResp\*1000\)\+" per 1k codex responses"/,
    'the rate is over codex responses only — dividing by every host\'s responses dilutes it by host mix');
  assert.match(JS, /no codex sessions — no other host records interrupts/);
  assert.match(JS, /CODEX ONLY\./, 'the tooltip states the capability, not just the definition');
  assert.doesNotMatch(JS, /relStat\(\{label:"aborted turns",value:fmtNum\(ab\)/,
    'the unconditional count must not come back');
  // Icon + words + color, never color alone.
  assert.match(JS, /rel-flag" data-sev="warn"><i aria-hidden="true">▲<\/i>/);
  assert.match(JS, /higher than the previous window/);
  assert.match(JS, /lower than the previous window/);
  assert.match(CSS, /\.rel-flag\[data-sev="warn"\]\{color:var\(--warn\)\}/);
});

test('reliability draws the per-day line and names its worst day without inventing a threshold', () => {
  // byDay carries exceptions as of the upstream v11 projection, so the line is
  // read rather than invented. "Worst" is a fact the counts already carry — no
  // constant decides what counts as a spike, because any constant this file
  // picked would be a judgement the data never made.
  assert.match(JS, /function relTrend\(d\)/);
  assert.match(JS, /rows\.map\(function\(x\)\{return fld\(x\.v,"exceptions"\);\}\)/);
  assert.match(JS, /sparklineSvg\(series,\{w:640,h:44\}\)/);
  assert.match(JS, /function relWorstDay\(rows\)/);
  assert.match(JS, /no exceptions on any day in this window/, 'an all-zero window draws no line');
  // Icon + words + color, and the day is named in text.
  assert.match(JS, /rel-flag" data-sev="warn"><i aria-hidden="true">▲<\/i>worst day /);
  // The attribution caveat is the point: a peak is not "the day it broke".
  assert.match(JS, /Attributed to the day each session first billed/);
  assert.match(JS, /spanning midnight lands all of its exceptions on one day/);
});

test('sparklineSvg breaks across a gap rather than dropping the point or carrying one forward', () => {
  // Dropping would squeeze the time axis (three missing days rendering as one
  // step); carrying forward would state a figure for a day that has none.
  assert.equal((sparklineSvg([1, 2, 3]).match(/<polyline/g) || []).length, 1);
  assert.equal((sparklineSvg([1, 2, null, 4, 5]).match(/<polyline/g) || []).length, 2, 'one run each side of the gap');
  assert.equal((sparklineSvg([1, 2, null, 4, null, 6, 7]).match(/<polyline/g) || []).length, 2, 'the lone point between two gaps has no segment');
  assert.match(sparklineSvg([1, 2, 3, null]), /circle/, 'the dot marks the last MEASURED point');
  // The gap keeps its slot: with 3 slots the run ends at the same x it would
  // have had with no gap at all.
  const gapped = /points="([^"]+)"/.exec(sparklineSvg([1, 2, null, 4]));
  assert.ok(gapped, 'a 4-point series with one gap still draws its leading run');
  // Unchanged for callers that pass only finite points.
  assert.equal(sparklineSvg([1]), '');
  assert.equal(sparklineSvg([1, NaN]), '');
});

test('the cache tile trends its share per day, nulling a day that billed no tokens', () => {
  assert.match(JS, /var tok=fld\(x\.v,"tokens"\);\s*return tok\?pct\(fld\(x\.v,"cacheRead"\),tok\):null;/);
  assert.match(JS, /the line breaks across it rather than carrying a neighbour's/);
});

test('the engaged tile says its trend covers a different day set than the others', () => {
  // engagedByDay is keyed on days WORKED; every other hero trend is keyed on
  // days BILLED. The tiles look directly comparable and are not.
  assert.match(JS, /trend covers days you worked; the other tiles' trends cover billed days/);
  assert.match(JS, /ladder\(t\)\+ENGAGED_TREND_NOTE/);
  // And the .kpi-foot comment no longer claims the row shares a baseline. (The
  // phrase is scoped tightly: styles/system.mjs has its own, unrelated "compared
  // at a glance" about a different layout.)
  assert.doesNotMatch(CSS, /trend lines across a row of tiles share a baseline/);
  assert.match(CSS, /not a row to compare across/);
});

test('a positive figure under a cent reads <$0.01; a true zero does not', () => {
  // "$0.00 median" beside "excludes $0-by-construction" reads as "the median
  // session was free", which is a different claim from "under a cent".
  assert.match(JS, /function fmtUsdMin\(n\)\{\s*var v=Number\(n\)\|\|0,txt=fmtUsd\(v\);\s*return \(v>0&&txt==="\$0\.00"\)\?"<\$0\.01":txt;/);
  assert.match(JS, /med==null\?"—":fmtUsdMin\(med\)/);
  assert.match(JS, /fmtUsdMin\(p90\)/);
  assert.match(JS, /means \\na real, positive figure smaller than a cent|a real, positive figure smaller than a cent/);
});

test('session chips render only what the transcript established, and nothing else', () => {
  // Engaged length and the session's own p50 come from fields the row already
  // carries; the p50 reuses the SAME bucket math the window's rhythm panel and
  // the server both use, rather than a second, unpinned copy.
  assert.match(JS, /bucketPercentile\(sx\.latHist,LAT_EDGES,0\.5\)/);
  assert.match(JS, /Array\.isArray\(sx\.latHist\)\?bucketPercentile/, 'no histogram means no p50 chip');
  assert.match(JS, /if\(len>0\)out\+=/, 'a session with no engaged seconds gets no length chip');
  assert.match(JS, /fmtAtLeast\(p50,60,fmtSecs\)/, 'a p50 in the overflow bucket still reads ≥');
});

test('the mode badge is absent when no posture was observed, never a guessed one', () => {
  assert.match(JS, /function modeBadge\(sx\)\{\s*var mode=reportedIdentity\(sx\.mode\);\s*if\(!mode\)return "";/);
  assert.match(JS, /recorded by the host as/, 'modeRaw rides in the tooltip when the payload carries it');
  assert.match(JS, /the host's own spelling was not recorded/, 'and says so when it does not');
  assert.match(CSS, /\.s-chip\.s-mode\[data-mode="unrestricted"\]/);
});

test('the fields the chips read are actually projected onto the session row', () => {
  // The chip branches were written against a payload that did not yet carry
  // these; upstream now projects them. This asserts the two halves meet, so a
  // regression on either side goes red rather than silently rendering nothing.
  const rec = usageRecord('ctx', {
    end: NOW - 2 * DAY_MS,
    mode: 'auto-edit',
    usageRows: [{ day: '2026-08-18', model: 'claude-opus-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, responses: 1 }],
  });
  Object.assign(rec, { modeRaw: 'acceptEdits', ctxWindow: 200_000, ctxLastTokens: 151_000 });
  const agg = aggregate([rec], { days: 7, now: NOW, cutoff: NOW - 7 * DAY_MS, deps: FIXTURE_DEPS });
  const row = agg.sessions[0];
  assert.equal(row.modeRaw, 'acceptEdits', 'the badge tooltip has a raw spelling to print');
  assert.equal(row.ctxWindow, 200_000, 'the ctx chip has a denominator');
  assert.equal(row.ctxLastTokens, 151_000, 'the ctx chip has a numerator');
  // …and the client reads exactly those names.
  assert.match(JS, /reportedIdentity\(sx\.modeRaw\)/);
  assert.match(JS, /Number\(sx\.ctxLastTokens\),win=Number\(sx\.ctxWindow\)/);
});

test('the host spelling is rendered, not filtered — the "[object Object]" band-aid is gone', () => {
  // The client used to refuse any modeRaw containing "[object " because every
  // live Codex row carried "never/[object Object]": usage-parsers joined
  // Codex's sandbox_policy OBJECT into the raw string. The parser now extracts
  // `.type` (pinned end-to-end in usage-index-v6.test.mjs against the real wire
  // shape), so the wreckage no longer exists to filter and the client renders
  // the spelling the host actually recorded.
  assert.doesNotMatch(JS, /rawSpelling/, 'the band-aid and every call to it are removed');
  assert.doesNotMatch(JS, /indexOf\("\[object "\)/, 'no sentinel-string filtering survives');
});

test('the context chip requires BOTH halves, and is omitted rather than divided by a guess', () => {
  assert.match(JS, /var used=Number\(sx\.ctxLastTokens\),win=Number\(sx\.ctxWindow\)/);
  assert.match(JS, /if\(!isFinite\(used\)\|\|!isFinite\(win\)\|\|used<=0\|\|win<=0\)return ""/);
  assert.match(JS, /both recorded by the transcript/);
  // The window is only ever READ. No `||` or `??` fallback stands behind it,
  // which is what a guessed denominator would have to look like.
  assert.doesNotMatch(JS, /ctxWindow\s*(\|\||\?\?)/);
  assert.doesNotMatch(JS, /CONTEXT_WINDOWS|DEFAULT_CTX_WINDOW/, 'no published-window lookup table');
});

test('the session detail strip spells out posture and rhythm, and never omits the line', () => {
  assert.match(JS, /\["posture",posture\],\["rhythm",esc\(rhythm\)\]/);
  assert.match(JS, /Not recorded <span class='sd-conf'>\(no posture evidence in this transcript\)/);
  assert.match(JS, /latency samples/);
  // Per-row, the same capability rule the reliability panel applies: a
  // claude/opencode row cannot have recorded an interrupt, so it says so
  // rather than printing a 0 indistinguishable from a measured one.
  assert.match(JS, /aborts "\+\(sx\.host==="codex"\?fmtNum\(Number\(sx\.aborts\)\|\|0\):"not recorded for this host"\)/);
});

test('an observed-but-unmapped posture shows the host spelling, never "no posture evidence"', () => {
  // normalizeMode returns { mode: null, raw: 'yolo/workspace-write' } for a
  // value outside the taxonomy — evidence preserved, no guess — and
  // v11Projection ships both onto the session row. Printing "no posture
  // evidence in this transcript" over a modeRaw sitting on that same row
  // denies data that exists, which is the honesty rule inverted.
  assert.match(JS, /return modeRaw\s*\?\s*"Unrecognized <span class='sd-conf'>\(host recorded \\""\+esc\(modeRaw\)\+"\\" — not in this taxonomy\)/,
    'the unmapped branch is chosen on modeRaw, before the not-recorded fallback, and escapes the host spelling');
  assert.match(JS, /"Not recorded <span class='sd-conf'>\(no posture evidence in this transcript\)/,
    'the genuinely-absent state keeps its own wording');
});

test('the aggregate carries the evidence an unmapped posture is rendered from', () => {
  // The behavioral half of the same rule, at the level that can be executed:
  // an unrecognized host spelling must survive to the session row with
  // mode null, or the client has nothing to render.
  const rec = usageRecord('unmapped', {
    end: NOW - 2 * DAY_MS,
    usageRows: [{ day: '2026-08-18', model: 'claude-opus-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, responses: 1 }],
  });
  Object.assign(rec, { mode: null, modeRaw: 'yolo/workspace-write' });
  const agg = aggregate([rec], { days: 7, now: NOW, cutoff: NOW - 7 * DAY_MS, deps: FIXTURE_DEPS });
  const row = agg.sessions[0];
  assert.equal(row.mode, null, 'unmapped stays unmapped — never coerced into a real posture');
  assert.equal(row.modeRaw, 'yolo/workspace-write', 'the evidence the transcript carried survives projection');
});

test('the chips column keeps the .srow grid arithmetic closed on both breakpoints', () => {
  // The row is a fixed grid: a column added to the desktop track list and
  // forgotten in the mobile one shifts every cell by one, which renders
  // perfectly while putting the wrong data under each heading.
  const desktop = /\.srow\{\s*display:grid; grid-template-columns:([^;]+);/.exec(CSS);
  assert.ok(desktop, 'the desktop .srow track list must be findable');
  assert.equal(desktop[1].trim().split(/\s+/).length, 11, 'eleven desktop tracks for eleven cells');

  const mobile = /@media\s*\(max-width:720px\)\{[\s\S]*?\.srow\{grid-template-columns:([^}]+)\}/.exec(CSS);
  assert.ok(mobile, 'the mobile .srow track list must be findable');
  assert.equal(mobile[1].trim().split(/\s+/).length, 5, 'five mobile tracks');
  assert.match(CSS, /\.srow \.cat,\.srow \.s-chips\{display:none\}/, 'chips join the hidden set, keeping 5 cells over 5 tracks');

  // Source order is what actually aligns a cell with its track: chips sit
  // between the category and the timestamp in both the markup and the CSS.
  assert.match(JS, /esc\(cat\)\+"<\/span>"\s*\+'<span class="s-chips">'\+sessionChips\(sx\)\+"<\/span>"\s*\+'<span class="s-when mono">/);
});

test('a limit meter carries a pace tick derived from the window it is already reading', () => {
  // resetsAt (epoch seconds) + windowMinutes are both on the limits payload,
  // so elapsed = duration - remaining. Nothing is fetched, and no window
  // length is assumed.
  assert.match(JS, /function paceShare\(resetSec,windowMinutes\)/);
  assert.match(JS, /var total=mins\*60000,elapsed=total-\(resetSec\*1000-Date\.now\(\)\)/);
  assert.match(JS, /w\.usedPercent,w\.resetsAt,null,w\.windowMinutes/, 'both claude and codex rows pass the window length');
  assert.match(JS, /class="pace" style="left:/);
  assert.match(CSS, /\.lim \.mbar i\.pace\{/);
  // Scoped to .lim: the scorecard's magnitude rows share .mbar and must not
  // start positioning or un-clipping themselves.
  assert.match(CSS, /\.lim \.mbar\{position:relative; overflow:visible\}/);
  assert.doesNotMatch(CSS, /^\.mbar\{[^}]*position:relative/m);
});

test('a pace tick that cannot be computed is omitted, never pinned to an edge', () => {
  // A snapshot older than its own window, or a browser clock that disagrees
  // with the vendor's, puts elapsed outside [0,duration]. 0% or 100% would
  // state a position; null admits there is none to state.
  assert.match(JS, /if\(!isFinite\(elapsed\)\|\|elapsed<0\|\|elapsed>total\)return null/);
  assert.match(JS, /if\(at==null\)return ""/);
  // And the key is only printed when a tick actually rendered.
  assert.match(JS, /\(paced\?PACE_LEGEND:""\)/);
  assert.match(JS, /if\(paced\)html\+=PACE_LEGEND/);
});

test('the scorecard panel grafts are idempotent — a re-render reuses its container', () => {
  // renderScore runs on every poll. ensureBlock returns the existing node
  // instead of inserting a second one; without that the scorecard would grow
  // a duplicate panel every few seconds.
  assert.match(JS, /function ensureBlock\(probeId,html,afterId\)\{\s*var existing=document\.getElementById\(probeId\);\s*if\(existing\)return existing;/);
});
