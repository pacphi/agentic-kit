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
} from '../../src/lib/dashboard/client/usage-rhythm.mjs';

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
