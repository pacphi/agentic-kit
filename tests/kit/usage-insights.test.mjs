import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THRESHOLDS as T, MODEL_ROUTING_SOURCES, detectInsights, _detectors,
} from '../../src/lib/usage-insights.mjs';

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Every fixture is built inline: `usage-insights` is PURE, so a test never needs
// a file on disk. `makeAgg` derives `totals` from the sessions it is given so a
// fixture cannot silently disagree with itself; pass `totals` to override.

let seq = 0;
function session(o = {}) {
  const s = {
    id: `s${++seq}`, provider: 'claude', title: '', project: 'alpha',
    start: '2026-07-20T10:00:00.000Z', minutes: 30, prompts: 5, responses: 20,
    sidechain: 0, models: { 'claude-sonnet-5': 1 },
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    tools: {}, category: 'Feature build', confidence: 0.9, basis: 'title+tools',
    skill: null, plugin: null,
    ...o,
  };
  s.tokens = o.tokens ?? (s.input + s.output + s.cacheRead + s.cacheWrite);
  return s;
}

function makeAgg(o = {}) {
  const sessions = o.sessions ?? [];
  const sum = (k) => sessions.reduce((a, s) => a + (s[k] || 0), 0);
  return {
    generatedAt: '2026-07-25T12:00:00.000Z', windowDays: 14, pricesAsOf: '2026-07-01',
    totals: {
      sessions: sessions.length, responses: sum('responses'),
      input: sum('input'), output: sum('output'),
      cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'),
      tokens: sum('tokens'), cost: sum('cost'),
      spanMinutes: sum('minutes'), engagedSeconds: 0,
      ...(o.totals || {}),
    },
    byDay: o.byDay ?? {}, byModel: o.byModel ?? {}, byProvider: o.byProvider ?? {},
    byProject: o.byProject ?? {}, byCategory: o.byCategory ?? {},
    punchcard: o.punchcard ?? {}, projectTree: [], sessions, insights: [],
  };
}

const byId = (list, id) => list.find((i) => i.id === id);
const fired = (agg, id) => Boolean(byId(detectInsights(agg), id));

// n identical sessions — the workhorse for boundary fixtures.
const many = (n, o) => Array.from({ length: n }, () => session(o));

// ── Degenerate input ─────────────────────────────────────────────────────────

test('an empty aggregate yields no insights and does not throw', () => {
  assert.deepEqual(detectInsights(makeAgg()), []);
});

test('a missing/partial aggregate does not throw', () => {
  assert.deepEqual(detectInsights(), []);
  assert.deepEqual(detectInsights({}), []);
  assert.deepEqual(detectInsights({ sessions: [], totals: {} }), []);
  assert.deepEqual(detectInsights({ totals: { cost: 0, sessions: 0 } }), []);
});

test('a zeroed window (sessions but no spend) claims nothing', () => {
  const agg = makeAgg({ sessions: many(20, { cost: 0, cacheWrite: 0 }) });
  assert.deepEqual(detectInsights(agg), []);
});

test('detectInsights does not mutate the aggregate it is given', () => {
  const agg = kitchenSink();
  const before = JSON.stringify(agg);
  detectInsights(agg);
  assert.equal(JSON.stringify(agg), before);
});

// ── INVARIANT 1 — impact is a number only when derived from `agg` ────────────

test('INVARIANT: non-computable detectors always report impact === null', () => {
  const list = detectInsights(kitchenSink());
  const nullImpact = [
    'overnight', 'spend-trend', 'project-concentration', 'classify-coverage',
    'model-routing', 'cost-per-session-spread',
  ];
  for (const id of nullImpact) {
    const ins = byId(list, id);
    assert.ok(ins, `${id} expected to fire in the kitchen-sink fixture`);
    assert.equal(ins.impact, null, `${id} must not claim a dollar figure`);
  }
});

test('INVARIANT: impact is derived from agg — doubling the data doubles the impact', () => {
  // Same *shape* (identical shares, so the same detectors fire), twice the money.
  const tokens = (scale) => ({
    input: 100_000 * scale, output: 20_000 * scale, cacheWrite: 200_000 * scale,
  });
  const build = (scale) => makeAgg({
    sessions: [
      ...many(4, { models: { 'claude-opus-5': 1 }, responses: 3, minutes: 2, cost: 300 * scale, ...tokens(scale) }),
      ...many(2, { prompts: 1, minutes: 1, cost: 60 * scale, ...tokens(scale) }),
      ...many(4, { responses: 30, minutes: 60, cost: 170 * scale, ...tokens(scale) }),
    ],
  });
  const one = detectInsights(build(1));
  const two = detectInsights(build(2));
  for (const id of ['context-tax', 'premium-on-routine', 'churn']) {
    const a = byId(one, id); const b = byId(two, id);
    assert.ok(a && b, `${id} expected to fire at both scales`);
    assert.equal(typeof a.impact, 'number');
    assert.ok(Math.abs(b.impact - a.impact * 2) < 0.02, `${id}: ${b.impact} should be ~2× ${a.impact}`);
  }
});

test('INVARIANT: a computed impact is never a bare constant across different windows', () => {
  const mk = (cost) => makeAgg({ sessions: many(4, { prompts: 1, minutes: 1, cost }) });
  const a = byId(detectInsights(mk(50)), 'churn').impact;
  const b = byId(detectInsights(mk(90)), 'churn').impact;
  assert.notEqual(a, b);
  assert.equal(a, 200);  // 4 × $50, straight from the sessions
  assert.equal(b, 360);
});

// ── INVARIANT 2 — thresholds are relative to window spend, never absolute ────

test('INVARIANT: premium-on-routine does NOT fire on large absolute dollars in a large window', () => {
  // $2,500 of premium routine spend → a $1,000 projected saving. Absolutely large,
  // but 0.5% of a $200k window: under the 1% relative floor, so it must stay quiet.
  const agg = makeAgg({
    sessions: [
      ...many(10, { models: { 'claude-opus-5': 1 }, responses: 3, minutes: 2, cost: 250 }),
      session({ responses: 400, minutes: 900, cost: 197_500 }),
    ],
  });
  assert.equal(agg.totals.cost, 200_000);
  const ins = byId(detectInsights(agg), 'premium-on-routine');
  assert.equal(ins, undefined, 'a large-window rule of thumb must not fire on 0.5% of spend');
});

test('the identical premium spend DOES fire once the window is small enough', () => {
  const agg = makeAgg({
    sessions: [
      ...many(10, { models: { 'claude-opus-5': 1 }, responses: 3, minutes: 2, cost: 250 }),
      session({ responses: 400, minutes: 900, cost: 7_500 }),
    ],
  });
  assert.equal(agg.totals.cost, 10_000);
  const ins = byId(detectInsights(agg), 'premium-on-routine');
  assert.ok(ins, 'same dollars, 10% of the window → fires');
  assert.equal(ins.impact, 1000);            // 2500 × 0.4 tier ratio
  assert.equal(ins.severity, 'warn');
});

test('INVARIANT: churn is floored relatively too — same dollars, opposite verdicts', () => {
  const churnSessions = many(4, { prompts: 1, minutes: 1, cost: 50 });   // $200
  const big = makeAgg({ sessions: [...churnSessions, session({ cost: 99_800 })] });
  const small = makeAgg({ sessions: [...churnSessions, session({ cost: 9_800 })] });
  assert.equal(fired(big, 'churn'), false, '0.2% of a $100k window');
  assert.equal(fired(small, 'churn'), true, '2% of a $10k window');
});

// ── INVARIANT 3 — model-routing cites sources and never sells an upgrade ─────

const routingAgg = (prevCost, otherCost) => makeAgg({
  sessions: [session({ cost: prevCost + otherCost })],
  byModel: {
    'claude-opus-4-8': { tokens: 1, cost: prevCost, responses: 10 },
    'claude-opus-5': { tokens: 1, cost: otherCost, responses: 10 },
  },
});

test('INVARIANT: model-routing carries a non-empty, well-formed sources array', () => {
  const ins = byId(detectInsights(routingAgg(40, 60)), 'model-routing');
  assert.ok(ins, 'model-routing expected to fire at 40% prev-gen spend');
  assert.ok(Array.isArray(ins.sources) && ins.sources.length >= 1);
  for (const s of ins.sources) {
    assert.equal(typeof s.label, 'string');
    assert.ok(s.label.length > 0);
    assert.match(s.url, /^https:\/\//);
  }
});

test('INVARIANT: model-routing must not recommend a blanket upgrade', () => {
  const ins = byId(detectInsights(routingAgg(40, 60)), 'model-routing');
  assert.doesNotMatch(ins.action, /upgrad/i, 'the action must not tell the user to upgrade');
  assert.doesNotMatch(ins.title, /upgrad/i);
  assert.match(ins.action, /complexity/i, 'the grounded recommendation is complexity-aware routing');
  assert.equal(ins.severity, 'ok', 'a defensible mix is an OK finding, not a warning');
  assert.equal(ins.impact, null, 'a capability claim may never carry an invented dollar figure');
});

test('model-routing cites exactly the five grounded sources from ADR-0009 §6', () => {
  const urls = MODEL_ROUTING_SOURCES.map((s) => s.url);
  assert.deepEqual(urls, [
    'https://www.anthropic.com/news/claude-opus-5',
    'https://github.com/pacphi/retort/blob/main/versions-blog.md',
    'https://arxiv.org/html/2602.12662',
    'https://arxiv.org/html/2511.05722',
    'https://arxiv.org/pdf/2503.16419',
  ]);
  const ins = byId(detectInsights(routingAgg(40, 60)), 'model-routing');
  assert.deepEqual(ins.sources, MODEL_ROUTING_SOURCES);
});

test('model-routing is the ONLY detector that carries sources', () => {
  for (const ins of detectInsights(kitchenSink())) {
    if (ins.id === 'model-routing') assert.ok(ins.sources);
    else assert.equal(ins.sources, undefined, `${ins.id} must not carry sources`);
  }
});

// ── Boundaries — one just-below / just-above pair per detector ───────────────

// context-tax. taxShare = medianCacheWrite·1.25 / per-session billable units, so
// it is inherently relative: 1M input + X cache-write per session crosses 1% at
// X ≈ 8,081.
const taxAgg = (cw) => makeAgg({ sessions: many(10, { input: 1_000_000, cacheWrite: cw, cost: 500 }) });

test('context-tax: just below the relative floor does not fire', () => {
  assert.equal(fired(taxAgg(8_000), 'context-tax'), false);
});

test('context-tax: just above the relative floor fires', () => {
  assert.equal(fired(taxAgg(8_200), 'context-tax'), true);
});

test('context-tax impact equals the window cost when the window is nothing but cache writes', () => {
  const agg = makeAgg({ sessions: many(10, { cacheWrite: 100_000, cost: 10 }) });
  const ins = byId(detectInsights(agg), 'context-tax');
  assert.equal(ins.impact, 100);           // the entire $100 window
  assert.equal(ins.severity, 'warn');
});

// premium-on-routine
const premiumAgg = (spend) => makeAgg({
  sessions: [
    ...many(10, { models: { 'claude-opus-5': 1 }, responses: 3, minutes: 2, cost: spend / 10 }),
    session({ responses: 400, minutes: 900, cost: 100_000 - spend }),
  ],
});

test('premium-on-routine: just below 1% of window saving does not fire', () => {
  assert.equal(fired(premiumAgg(2_400), 'premium-on-routine'), false);   // saving $960
});

test('premium-on-routine: just above 1% of window saving fires', () => {
  assert.equal(fired(premiumAgg(2_600), 'premium-on-routine'), true);    // saving $1,040
});

test('premium-on-routine ignores premium sessions that were not routine', () => {
  const agg = makeAgg({
    sessions: [
      // 7 responses — one over the routine ceiling.
      ...many(10, { models: { 'claude-opus-5': 1 }, responses: T.premiumMaxResponses + 1, minutes: 2, cost: 500 }),
      session({ cost: 5_000 }),
    ],
  });
  assert.equal(fired(agg, 'premium-on-routine'), false);
});

test('premium-on-routine ignores routine sessions that were not on a premium model', () => {
  const agg = makeAgg({
    sessions: [
      ...many(10, { models: { 'claude-sonnet-5': 1 }, responses: 3, minutes: 2, cost: 500 }),
      session({ cost: 5_000 }),
    ],
  });
  assert.equal(fired(agg, 'premium-on-routine'), false);
});

test('premium-on-routine counts fable and prior-generation opus as premium', () => {
  for (const model of ['claude-fable-5', 'claude-opus-4-8']) {
    const agg = makeAgg({
      sessions: [
        ...many(10, { models: { [model]: 1 }, responses: 3, minutes: 2, cost: 500 }),
        session({ cost: 5_000 }),
      ],
    });
    assert.equal(fired(agg, 'premium-on-routine'), true, `${model} is premium tier`);
  }
});

// churn
const churnAgg = (spend) => makeAgg({
  sessions: [
    ...many(4, { prompts: 1, minutes: 1, cost: spend / 4 }),
    session({ cost: 10_000 - spend }),
  ],
});

test('churn: just below the relative cost floor does not fire', () => {
  assert.equal(fired(churnAgg(40), 'churn'), false);        // 0.4% of $10k
});

test('churn: just above the relative cost floor fires', () => {
  assert.equal(fired(churnAgg(60), 'churn'), true);         // 0.6% of $10k
});

test('churn excludes sessions at or over the duration ceiling', () => {
  const agg = makeAgg({
    sessions: [...many(4, { prompts: 1, minutes: T.churnMaxMinutes, cost: 100 }), session({ cost: 1_000 })],
  });
  assert.equal(fired(agg, 'churn'), false, 'minutes < 2 is strict');
});

// overnight
const nightAgg = (night, day) => makeAgg({
  sessions: [session({ cost: 100 })],
  punchcard: { '0-3': night, '0-14': day },
});

test('overnight: just below 8% of responses does not fire', () => {
  assert.equal(fired(nightAgg(7, 93), 'overnight'), false);
});

test('overnight: exactly at 8% does not fire (the threshold is strict)', () => {
  assert.equal(fired(nightAgg(8, 92), 'overnight'), false);
});

test('overnight: just above 8% fires with no dollar claim', () => {
  const ins = byId(detectInsights(nightAgg(9, 91)), 'overnight');
  assert.ok(ins);
  assert.equal(ins.impact, null);
  assert.equal(ins.command, 'ak x daemon-gc');
});

test('overnight counts only the 01:00–05:59 band', () => {
  // 00:00 and 06:00 sit outside the band, so 40% of responses is still quiet.
  assert.equal(fired(makeAgg({
    sessions: [session({ cost: 100 })],
    punchcard: { '0-0': 20, '0-6': 20, '0-14': 60 },
  }), 'overnight'), false);
});

// spend-trend
const trendAgg = (recentDaily) => makeAgg({
  sessions: [session({ cost: 100 })],
  byDay: {
    '2026-07-01': { tokens: 1, cost: 100, sessions: 2 },
    '2026-07-02': { tokens: 1, cost: 100, sessions: 2 },
    '2026-07-03': { tokens: 1, cost: recentDaily, sessions: 3 },
    '2026-07-04': { tokens: 1, cost: recentDaily, sessions: 3 },
  },
});

test('spend-trend: a 20% swing does not fire', () => {
  assert.equal(fired(trendAgg(120), 'spend-trend'), false);
});

test('spend-trend: a 30% rise fires as a warning', () => {
  const ins = byId(detectInsights(trendAgg(130)), 'spend-trend');
  assert.ok(ins);
  assert.equal(ins.severity, 'warn');
  assert.equal(ins.impact, null);
});

test('spend-trend: a 30% fall fires as an OK finding, not a warning', () => {
  const ins = byId(detectInsights(trendAgg(70)), 'spend-trend');
  assert.ok(ins);
  assert.equal(ins.severity, 'ok');
  assert.match(ins.title, /fall/i);
});

test('spend-trend needs at least two days of history', () => {
  const agg = makeAgg({
    sessions: [session({ cost: 100 })],
    byDay: { '2026-07-04': { tokens: 1, cost: 900, sessions: 3 } },
  });
  assert.equal(fired(agg, 'spend-trend'), false);
});

// project-concentration. Five projects, so `alpha` can be the largest while still
// sitting under the 22% floor — with two projects the top is always over half.
const projectAgg = (topCost) => {
  const rest = (100 - topCost) / 4;
  return makeAgg({
    sessions: [session({ cost: 100 })],
    byProject: {
      alpha: { tokens: 1, cost: topCost, sessions: 5, minutes: 10 },
      beta: { tokens: 1, cost: rest, sessions: 5, minutes: 10 },
      gamma: { tokens: 1, cost: rest, sessions: 5, minutes: 10 },
      delta: { tokens: 1, cost: rest, sessions: 5, minutes: 10 },
      epsilon: { tokens: 1, cost: rest, sessions: 5, minutes: 10 },
    },
  });
};

test('project-concentration: 21% of spend does not fire', () => {
  assert.equal(fired(projectAgg(21), 'project-concentration'), false);
});

test('project-concentration: 23% of spend fires', () => {
  const ins = byId(detectInsights(projectAgg(23)), 'project-concentration');
  assert.ok(ins);
  assert.match(ins.title, /alpha/);
  assert.equal(ins.impact, null);
});

test('project-concentration survives a single-project window', () => {
  const agg = makeAgg({
    sessions: [session({ cost: 100 })],
    byProject: { alpha: { tokens: 1, cost: 100, sessions: 5, minutes: 10 } },
  });
  assert.ok(byId(detectInsights(agg), 'project-concentration'));
});

// classify-coverage
const classifyAgg = (unclassified) => makeAgg({
  sessions: [session({ cost: 100 })],
  totals: { sessions: 100, cost: 100 },
  byCategory: {
    Unclassified: { sessions: unclassified, cost: 10, minutes: 10 },
    'Feature build': { sessions: 100 - unclassified, cost: 90, minutes: 90 },
  },
});

test('classify-coverage: exactly 25% unclassified does not fire', () => {
  assert.equal(fired(classifyAgg(25), 'classify-coverage'), false);
});

test('classify-coverage: 26% unclassified fires', () => {
  const ins = byId(detectInsights(classifyAgg(26)), 'classify-coverage');
  assert.ok(ins);
  assert.equal(ins.impact, null);
  // No command by design: the LLM-labelling pass (ADR-0009 §5 Layer 3) is not
  // shipped, and the detector must not advertise a command that does not exist.
  assert.equal(ins.command, null);
});

// model-routing
test('model-routing: 14% prev-gen Opus spend does not fire', () => {
  assert.equal(fired(routingAgg(14, 86), 'model-routing'), false);
});

test('model-routing: 15% prev-gen Opus spend fires', () => {
  assert.equal(fired(routingAgg(15, 85), 'model-routing'), true);
});

test('model-routing does not count the current Opus generation as prev-gen', () => {
  const agg = makeAgg({
    sessions: [session({ cost: 100 })],
    byModel: { 'claude-opus-5': { tokens: 1, cost: 100, responses: 10 } },
  });
  assert.equal(fired(agg, 'model-routing'), false);
});

// cost-per-session-spread
const spreadAgg = (hiCost) => makeAgg({
  sessions: [session({ cost: 600 })],
  byCategory: {
    'Feature build': { sessions: 5, cost: hiCost, minutes: 500 },
    'Docs & writing': { sessions: 10, cost: 100, minutes: 100 },
    Unclassified: { sessions: 50, cost: 5_000, minutes: 50 },
  },
});

test('cost-per-session-spread: a 9.9× ratio does not fire', () => {
  assert.equal(fired(spreadAgg(495), 'cost-per-session-spread'), false);
});

test('cost-per-session-spread: a 10× ratio fires', () => {
  const ins = byId(detectInsights(spreadAgg(500)), 'cost-per-session-spread');
  assert.ok(ins);
  assert.equal(ins.impact, null);
  assert.match(ins.title, /Feature build/);
  assert.match(ins.title, /Docs & writing/);
});

test('cost-per-session-spread ignores Unclassified and thin categories', () => {
  // Unclassified is by far the most expensive per session here, and `Spike` has
  // too few sessions to be evidence — neither may drive the ratio.
  const agg = makeAgg({
    sessions: [session({ cost: 600 })],
    byCategory: {
      'Feature build': { sessions: 5, cost: 100, minutes: 500 },
      'Docs & writing': { sessions: 10, cost: 100, minutes: 100 },
      Unclassified: { sessions: 4, cost: 40_000, minutes: 50 },
      Spike: { sessions: T.spreadMinCategorySessions - 1, cost: 40_000, minutes: 50 },
    },
  });
  assert.equal(fired(agg, 'cost-per-session-spread'), false);
});

// high-volume-automation — relative to the window's own mean session cost.
const automationAgg = (sessions, cost) => makeAgg({
  sessions: [session({ cost: 2_000 })],
  totals: { sessions: 200, cost: 2_000 },      // window mean = $10/session
  byCategory: { 'Health check': { sessions, cost, minutes: sessions * 2 } },
});

test('high-volume-automation: at half the window mean it does not fire', () => {
  assert.equal(fired(automationAgg(100, 500), 'high-volume-automation'), false);   // $5.00 avg
});

test('high-volume-automation: below half the window mean it fires', () => {
  const ins = byId(detectInsights(automationAgg(100, 490)), 'high-volume-automation');
  assert.ok(ins);
  assert.equal(ins.impact, null);
  assert.match(ins.title, /Health check/);
});

test('high-volume-automation: 99 sessions is under the volume floor', () => {
  assert.equal(fired(automationAgg(T.automationMinSessions - 1, 100), 'high-volume-automation'), false);
});

test('high-volume-automation reports one category, so ids stay unique', () => {
  const agg = makeAgg({
    sessions: [session({ cost: 2_000 })],
    totals: { sessions: 400, cost: 2_000 },
    byCategory: {
      'Health check': { sessions: 100, cost: 100, minutes: 200 },
      'Docs & writing': { sessions: 150, cost: 150, minutes: 300 },
    },
  });
  const list = detectInsights(agg);
  assert.equal(list.filter((i) => i.id === 'high-volume-automation').length, 1);
  assert.equal(new Set(list.map((i) => i.id)).size, list.length, 'ids are unique');
});

// ── Ranking + shape ─────────────────────────────────────────────────────────

function kitchenSink() {
  return makeAgg({
    sessions: [
      // premium + routine, and the bulk of the cache-write tax
      ...many(4, {
        models: { 'claude-opus-5': 1 }, responses: 3, minutes: 2, cost: 300,
        input: 100_000, output: 20_000, cacheWrite: 200_000,
      }),
      // churn
      ...many(2, {
        prompts: 1, minutes: 1, cost: 60,
        input: 100_000, output: 20_000, cacheWrite: 200_000,
      }),
      // ordinary work
      ...many(4, {
        responses: 30, minutes: 60, cost: 170,
        input: 100_000, output: 20_000, cacheWrite: 200_000,
      }),
    ],
    byDay: {
      '2026-07-01': { tokens: 1, cost: 100, sessions: 2 },
      '2026-07-02': { tokens: 1, cost: 100, sessions: 2 },
      '2026-07-03': { tokens: 1, cost: 400, sessions: 5 },
      '2026-07-04': { tokens: 1, cost: 400, sessions: 5 },
    },
    byModel: {
      'claude-opus-4-8': { tokens: 1, cost: 800, responses: 40 },
      'claude-opus-5': { tokens: 1, cost: 1_200, responses: 60 },
    },
    byProject: {
      alpha: { tokens: 1, cost: 1_400, sessions: 7, minutes: 300 },
      beta: { tokens: 1, cost: 600, sessions: 3, minutes: 100 },
    },
    byCategory: {
      'Feature build': { sessions: 3, cost: 1_500, minutes: 200 },
      'Docs & writing': { sessions: 3, cost: 30, minutes: 30 },
      Unclassified: { sessions: 4, cost: 470, minutes: 60 },
    },
    punchcard: { '0-2': 20, '0-14': 80 },
  });
}

test('ranking puts every computed-impact finding above every null-impact one', () => {
  const list = detectInsights(kitchenSink());
  const lastComputed = list.reduce((acc, i, n) => (typeof i.impact === 'number' ? n : acc), -1);
  const firstNull = list.findIndex((i) => i.impact === null);
  assert.ok(lastComputed >= 0 && firstNull >= 0, 'the fixture fires both kinds');
  assert.ok(lastComputed < firstNull, 'a $-backed finding never sorts below a $-free one');
});

test('computed impacts are ranked largest-first, and ties break by severity', () => {
  const list = detectInsights(kitchenSink());
  const impacts = list.filter((i) => typeof i.impact === 'number').map((i) => i.impact);
  assert.deepEqual(impacts, [...impacts].sort((a, b) => b - a));
  const rank = { warn: 0, info: 1, ok: 2 };
  const nulls = list.filter((i) => i.impact === null).map((i) => rank[i.severity]);
  assert.deepEqual(nulls, [...nulls].sort((a, b) => a - b));
});

test('every insight satisfies the Insight contract', () => {
  const list = detectInsights(kitchenSink());
  assert.ok(list.length >= 8, `expected a broad fixture to fire widely, got ${list.length}`);
  for (const i of list) {
    assert.match(i.id, /^[a-z][a-z-]+$/, 'id is a stable kebab-case slug');
    assert.ok(['coach', 'trend'].includes(i.kind), `${i.id} kind`);
    assert.ok(['warn', 'info', 'ok'].includes(i.severity), `${i.id} severity`);
    for (const k of ['title', 'finding', 'evidence', 'action']) {
      assert.equal(typeof i[k], 'string', `${i.id}.${k} is a string`);
      assert.ok(i[k].trim().length > 0, `${i.id}.${k} is non-empty`);
    }
    assert.ok(i.command === null || typeof i.command === 'string', `${i.id} command`);
    assert.ok(i.impact === null || Number.isFinite(i.impact), `${i.id} impact is a number or null`);
    if (typeof i.impact === 'number') assert.ok(i.impact > 0, `${i.id} impact is positive`);
  }
});

test('the kitchen-sink fixture fires each detector at most once', () => {
  const list = detectInsights(kitchenSink());
  assert.equal(new Set(list.map((i) => i.id)).size, list.length);
});

// ── Direct per-detector unit tests ───────────────────────────────────────────
// detectInsights composes these 13 detect() functions from a shared `ctx`
// prelude (a/totals/sessions/windowCost/sessionCount). Calling each one
// directly — bypassing detectInsights's flatMap+sort — proves the extraction
// preserved firing behavior in isolation, independent of the other 12.

function ctxFrom(agg) {
  const a = agg && typeof agg === 'object' ? agg : {};
  const totals = a.totals && typeof a.totals === 'object' ? a.totals : {};
  const sessions = Array.isArray(a.sessions) ? a.sessions : [];
  const windowCost = Number.isFinite(totals.cost) ? totals.cost : 0;
  const sessionCount = Number.isFinite(totals.sessions) ? totals.sessions : sessions.length;
  return { a, totals, sessions, windowCost, sessionCount };
}

test('_detectors[context-tax] fires/does not fire directly, matching detectInsights', () => {
  assert.equal(_detectors['context-tax'](ctxFrom(taxAgg(8_000))).length, 0);
  assert.equal(_detectors['context-tax'](ctxFrom(taxAgg(8_200))).length, 1);
});

test('_detectors[premium-on-routine] fires/does not fire directly, matching detectInsights', () => {
  assert.equal(_detectors['premium-on-routine'](ctxFrom(premiumAgg(2_400))).length, 0);
  assert.equal(_detectors['premium-on-routine'](ctxFrom(premiumAgg(2_600))).length, 1);
});

test('_detectors[churn] fires/does not fire directly, matching detectInsights', () => {
  assert.equal(_detectors.churn(ctxFrom(churnAgg(40))).length, 0);
  assert.equal(_detectors.churn(ctxFrom(churnAgg(60))).length, 1);
});

test('_detectors[overnight] fires/does not fire directly, matching detectInsights', () => {
  assert.equal(_detectors.overnight(ctxFrom(nightAgg(8, 92))).length, 0);
  assert.equal(_detectors.overnight(ctxFrom(nightAgg(9, 91))).length, 1);
});

test('_detectors[spend-trend] fires/does not fire directly, matching detectInsights', () => {
  assert.equal(_detectors['spend-trend'](ctxFrom(trendAgg(120))).length, 0);
  assert.equal(_detectors['spend-trend'](ctxFrom(trendAgg(130))).length, 1);
});

test('_detectors[project-concentration] fires/does not fire directly, matching detectInsights', () => {
  assert.equal(_detectors['project-concentration'](ctxFrom(projectAgg(21))).length, 0);
  assert.equal(_detectors['project-concentration'](ctxFrom(projectAgg(23))).length, 1);
});

test('_detectors[classify-coverage] fires/does not fire directly, matching detectInsights', () => {
  assert.equal(_detectors['classify-coverage'](ctxFrom(classifyAgg(25))).length, 0);
  assert.equal(_detectors['classify-coverage'](ctxFrom(classifyAgg(26))).length, 1);
});

test('_detectors[model-routing] fires directly and carries its grounded sources', () => {
  const [insight] = _detectors['model-routing'](ctxFrom(routingAgg(40, 60)));
  assert.ok(insight);
  assert.equal(insight.sources, MODEL_ROUTING_SOURCES);
});

test('_detectors[cost-per-session-spread] fires/does not fire directly, matching detectInsights', () => {
  assert.equal(_detectors['cost-per-session-spread'](ctxFrom(spreadAgg(495))).length, 0);
  assert.equal(_detectors['cost-per-session-spread'](ctxFrom(spreadAgg(500))).length, 1);
});

test('_detectors[high-volume-automation] fires/does not fire directly, matching detectInsights', () => {
  assert.equal(_detectors['high-volume-automation'](ctxFrom(automationAgg(100, 500))).length, 0);
  assert.equal(_detectors['high-volume-automation'](ctxFrom(automationAgg(100, 490))).length, 1);
});

// parallel-sessions, subagent-share and long-session-share had no dedicated
// coverage before this extraction (only the kitchen-sink fixture touched
// them indirectly) — these fixtures are new.
const parallelAgg = (spanMinutes, spanUnionSeconds) => makeAgg({
  sessions: [session({ cost: 10 }), session({ cost: 10 })],
  totals: { sessions: 2, spanMinutes, spanUnionSeconds },
});

test('_detectors[parallel-sessions] fires/does not fire directly on summed-vs-union span', () => {
  assert.equal(_detectors['parallel-sessions'](ctxFrom(parallelAgg(2, 300))).length, 0);
  assert.equal(_detectors['parallel-sessions'](ctxFrom(parallelAgg(20, 300))).length, 1);
});

const subagentAgg = (sideCost, totalCost) => makeAgg({
  sessions: [
    session({ cost: sideCost, sidechain: true }),
    session({ cost: totalCost - sideCost }),
  ],
});

test('_detectors[subagent-share] fires/does not fire directly on sidechain spend share', () => {
  assert.equal(_detectors['subagent-share'](ctxFrom(subagentAgg(20, 100))).length, 0);
  assert.equal(_detectors['subagent-share'](ctxFrom(subagentAgg(30, 100))).length, 1);
});

const longSessionAgg = (longCost, totalCost) => makeAgg({
  sessions: [
    session({ cost: longCost, minutes: 500 }),
    session({ cost: totalCost - longCost, minutes: 30 }),
  ],
});

test('_detectors[long-session-share] fires/does not fire directly on 8h+ session spend share', () => {
  assert.equal(_detectors['long-session-share'](ctxFrom(longSessionAgg(20, 100))).length, 0);
  assert.equal(_detectors['long-session-share'](ctxFrom(longSessionAgg(30, 100))).length, 1);
});
