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

test('usage dashboard includes a visible host-neutral telemetry coverage surface', () => {
  assert.match(PAGE, /id="u-telemetry-grid"/);
  assert.match(PAGE, />telemetry coverage</);
  assert.match(JS, /function renderTelemetryCoverage/);
  assert.match(JS, /coverage not reported by this API/);
  assert.match(JS, /label:"Codex transcript"/);
  assert.match(JS, /coverage unavailable/);
  assert.match(JS, /data-state=/);
  assert.match(CSS, /\.telemetry-card/);
});

test('usage dashboard keeps unsupported and unavailable capability states distinct', () => {
  assert.match(JS, /String\(capabilities\[item\[0\]\]\|\|"unavailable"\)/);
  assert.match(JS, /data-state=/);
  assert.match(JS, /source\.diagnostics&&source\.diagnostics\.common/);
  assert.match(JS, /source\.capabilities\|\|\{\}/);
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
  assert.match(JS, /var LAT_LABELS=\["≤2s","≤5s","≤10s","≤30s","≤60s","＞60s"\]/);
  assert.match(JS, /var LEN_LABELS=\["≤5m","≤15m","≤45m","≤2h","＞2h"\]/);
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

test('how-you-run splits source and provider without attributing unobserved spend', () => {
  assert.match(JS, /aValue:main,bValue:sub/, 'the donut is main vs subagent cost');
  assert.match(JS, /d\.bySource/);
  assert.match(JS, /entries\(d\.byInferenceProvider\)/);
  assert.match(JS, /dim:x\.name==="not-recorded"/, 'unobserved provenance renders dim, never as a provider');
  assert.match(JS, /attributed to an assumption/, 'the panel says why unobserved spend is held apart');
});

test('the scorecard panel grafts are idempotent — a re-render reuses its container', () => {
  // renderScore runs on every poll. ensureBlock returns the existing node
  // instead of inserting a second one; without that the scorecard would grow
  // a duplicate panel every few seconds.
  assert.match(JS, /function ensureBlock\(probeId,html,afterId\)\{\s*var existing=document\.getElementById\(probeId\);\s*if\(existing\)return existing;/);
});
