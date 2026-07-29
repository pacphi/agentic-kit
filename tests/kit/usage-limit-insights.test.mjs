// detectLimitInsights (ADR-0010) and the local parity detectors added to
// detectInsights alongside it. Purity is load-bearing: "now" is always
// limits.generatedAt — data, not a clock — so every case here is reproducible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInsights, detectLimitInsights, THRESHOLDS } from '../../src/lib/usage-insights.mjs';

const NOW = Date.parse('2026-07-27T12:00:00Z');
const sec = (ms) => Math.round(ms / 1000);

const limits = (over = {}) => ({
  generatedAt: new Date(NOW).toISOString(),
  claude: null,
  codex: null,
  ...over,
});
const claudeSide = (windows) => ({ provider: 'claude', source: 'statusline', fetchedAt: NOW, windows });
const codexSide = (lanes, resetCredits = null) => ({ provider: 'codex', source: 'app-server', fetchedAt: NOW, planType: 'prolite', lanes, resetCredits });
const byId = (list, id) => list.find((i) => i.id === id);
const fired = (list, prefix) => list.some((i) => i.id.startsWith(prefix));

// ── limit-pacing ─────────────────────────────────────────────────────────────

// A weekly window 89% used with 48h of 168 still to run: elapsed 71%, used 89%
// → ahead of pace by 1.24×… just under the 1.25 lead. Use 60h remaining
// (elapsed 64%) so the lead is decisive.
test('limit-pacing fires when consumption runs ahead of the window clock', () => {
  const l = limits({
    claude: claudeSide([{ id: 'seven_day', label: 'weekly', usedPercent: 89, windowMinutes: 10080, resetsAt: sec(NOW + 60 * 3600 * 1000) }]),
  });
  const ins = detectLimitInsights(l, null);
  const f = ins.find((i) => i.id.startsWith('limit-pacing-claude'));
  assert.ok(f, 'expected a pacing finding');
  assert.equal(f.kind, 'trend');
  assert.match(f.finding, /89%/);
  assert.match(f.evidence, /elapsed/);
});

test('limit-pacing stays silent below the utilization floor', () => {
  const l = limits({
    claude: claudeSide([{ id: 'seven_day', label: 'weekly', usedPercent: THRESHOLDS.pacingMinUsedPercent - 1, windowMinutes: 10080, resetsAt: sec(NOW + 3600 * 1000) }]),
  });
  assert.equal(fired(detectLimitInsights(l, null), 'limit-pacing'), false);
});

test('limit-pacing stays silent when on or behind pace', () => {
  // 60% used with 60% elapsed — exactly on pace, under the 1.25 lead factor.
  const l = limits({
    claude: claudeSide([{ id: 'seven_day', label: 'weekly', usedPercent: 60, windowMinutes: 10080, resetsAt: sec(NOW + 0.4 * 10080 * 60000) }]),
  });
  assert.equal(fired(detectLimitInsights(l, null), 'limit-pacing'), false);
});

test('limit-pacing needs generatedAt — no clock is ever read', () => {
  const l = limits({
    generatedAt: undefined,
    claude: claudeSide([{ id: 'seven_day', label: 'weekly', usedPercent: 95, windowMinutes: 10080, resetsAt: sec(NOW + 3600 * 1000) }]),
  });
  assert.equal(fired(detectLimitInsights(l, null), 'limit-pacing'), false);
});

test('limit-pacing skips a window missing duration or reset', () => {
  const l = limits({
    claude: claudeSide([
      { id: 'seven_day', label: 'weekly', usedPercent: 95, windowMinutes: null, resetsAt: sec(NOW + 3600 * 1000) },
      { id: 'five_hour', label: '5h', usedPercent: 95, windowMinutes: 300, resetsAt: null },
    ]),
  });
  assert.equal(fired(detectLimitInsights(l, null), 'limit-pacing'), false);
});

// ── cross-host-arbitrage ─────────────────────────────────────────────────────

test('cross-host-arbitrage fires when one host is hot and the other idle', () => {
  const l = limits({
    claude: claudeSide([{ id: 'seven_day', label: 'weekly', usedPercent: 89, windowMinutes: 10080, resetsAt: null }]),
    codex: codexSide([{ id: 'codex', name: 'codex', windows: [{ label: 'weekly', usedPercent: 3, windowMinutes: 10080, resetsAt: null }] }]),
  });
  const f = byId(detectLimitInsights(l, null), 'cross-host-arbitrage-claude');
  assert.ok(f, 'expected an arbitrage finding');
  assert.equal(f.command, 'ak host pick');
  assert.match(f.title, /89%/);
  assert.match(f.title, /3%/);
});

test('cross-host-arbitrage needs BOTH hosts — a hot host alone is not arbitrage', () => {
  const l = limits({
    claude: claudeSide([{ id: 'seven_day', label: 'weekly', usedPercent: 95, windowMinutes: 10080, resetsAt: null }]),
  });
  assert.equal(fired(detectLimitInsights(l, null), 'cross-host-arbitrage'), false);
});

test('cross-host-arbitrage stays silent when the other host is also busy', () => {
  const l = limits({
    claude: claudeSide([{ id: 'seven_day', label: 'weekly', usedPercent: 89, windowMinutes: 10080, resetsAt: null }]),
    codex: codexSide([{ id: 'codex', name: 'codex', windows: [{ label: 'weekly', usedPercent: THRESHOLDS.arbitrageLowPercent + 1, windowMinutes: 10080, resetsAt: null }] }]),
  });
  assert.equal(fired(detectLimitInsights(l, null), 'cross-host-arbitrage'), false);
});

// ── codex-reset-credits ──────────────────────────────────────────────────────

test('codex-reset-credits reports the count and the soonest expiry', () => {
  const l = limits({
    codex: codexSide([{ id: 'codex', name: 'codex', windows: [] }], {
      availableCount: 2,
      credits: [
        { status: 'available', title: 'Full reset', expiresAt: sec(NOW + 4 * 86400 * 1000) },
        { status: 'available', title: 'Full reset', expiresAt: sec(NOW + 30 * 86400 * 1000) },
      ],
    }),
  });
  const f = byId(detectLimitInsights(l, null), 'codex-reset-credits');
  assert.ok(f);
  assert.match(f.finding, /2/);
  assert.match(f.finding, /4 days/);
  assert.match(f.action, /never consumes/);
});

test('codex-reset-credits stays silent at zero credits', () => {
  const l = limits({ codex: codexSide([], { availableCount: 0, credits: [] }) });
  assert.equal(fired(detectLimitInsights(l, null), 'codex-reset-credits'), false);
});

test('empty input claims nothing', () => {
  assert.deepEqual(detectLimitInsights(undefined, undefined), []);
  assert.deepEqual(detectLimitInsights(limits(), null), []);
});

test('every limit insight satisfies the Insight contract', () => {
  const l = limits({
    claude: claudeSide([{ id: 'seven_day', label: 'weekly', usedPercent: 92, windowMinutes: 10080, resetsAt: sec(NOW + 60 * 3600 * 1000) }]),
    codex: codexSide(
      [{ id: 'codex', name: 'codex', windows: [{ label: 'weekly', usedPercent: 3, windowMinutes: 10080, resetsAt: null }] }],
      { availableCount: 1, credits: [] },
    ),
  });
  const list = detectLimitInsights(l, null);
  assert.ok(list.length >= 3, `expected pacing + arbitrage + credits, got ${list.map((i) => i.id)}`);
  for (const i of list) {
    assert.ok(['coach', 'trend'].includes(i.kind), `${i.id} kind`);
    assert.ok(['warn', 'info', 'ok'].includes(i.severity), `${i.id} severity`);
    for (const k of ['title', 'finding', 'evidence', 'action']) {
      assert.equal(typeof i[k], 'string', `${i.id}.${k}`);
      assert.ok(i[k].trim().length > 0, `${i.id}.${k} non-empty`);
    }
    assert.equal(i.impact, null, `${i.id}: percentages are not dollars — no impact may be claimed`);
  }
});

// ── parity detectors in detectInsights ───────────────────────────────────────

const session = (over = {}) => ({
  cost: 10, minutes: 30, prompts: 5, responses: 20, sidechain: false, threadSource: null,
  input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, models: { 'claude-sonnet-5': 1 },
  ...over,
});
const agg = (sessions, totals = {}) => ({
  totals: {
    cost: sessions.reduce((a, s) => a + s.cost, 0),
    sessions: sessions.length,
    spanMinutes: 0, spanUnionSeconds: 0,
    ...totals,
  },
  sessions,
});

test('parallel-sessions fires at 2× mean concurrency and names the factor', () => {
  const a = agg([session(), session()], { spanMinutes: 240, spanUnionSeconds: 7200 }); // 4h summed vs 2h wall
  const f = byId(detectInsights(a), 'parallel-sessions');
  assert.ok(f);
  assert.match(f.title, /2\.0×/);
});

test('parallel-sessions stays silent under the factor and with one session', () => {
  assert.equal(fired(detectInsights(agg([session(), session()], { spanMinutes: 100, spanUnionSeconds: 6000 })), 'parallel-sessions'), false);
  assert.equal(fired(detectInsights(agg([session()], { spanMinutes: 240, spanUnionSeconds: 3600 })), 'parallel-sessions'), false);
});

test('subagent-share fires on sidechain/subagent cost share ≥ threshold', () => {
  const a = agg([session({ sidechain: true, cost: 30 }), session({ threadSource: 'subagent', cost: 20 }), session({ cost: 50 })]);
  const f = byId(detectInsights(a), 'subagent-share');
  assert.ok(f);
  assert.match(f.title, /50%/);
  assert.equal(f.impact, null, 'composition fact, not waste — no dollar claim');
});

test('subagent-share stays silent below the threshold', () => {
  const a = agg([session({ sidechain: true, cost: 10 }), session({ cost: 90 })]);
  assert.equal(fired(detectInsights(a), 'subagent-share'), false);
});

test('long-session-share fires on 8h+ sessions carrying the window', () => {
  const a = agg([session({ minutes: 600, cost: 60 }), session({ cost: 40 })]);
  const f = byId(detectInsights(a), 'long-session-share');
  assert.ok(f);
  assert.equal(f.command, 'ak x daemon-gc');
});

test('long-session-share stays silent when long sessions are cheap', () => {
  const a = agg([session({ minutes: 600, cost: 10 }), session({ cost: 90 })]);
  assert.equal(fired(detectInsights(a), 'long-session-share'), false);
});
