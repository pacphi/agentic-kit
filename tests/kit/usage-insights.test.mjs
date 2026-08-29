import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THRESHOLDS as T, MODEL_ROUTING_SOURCES, TAP_COST_CAVEAT, detectInsights, _detectors,
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
    // v16: honest-absent by default, so an existing fixture cannot accidentally
    // read as a headless session just because it predates the prompt layer.
    typedPrompts: null, tapPrompts: null,
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
    promptsByHost: o.promptsByHost ?? {}, promptBaselines: o.promptBaselines ?? {},
    promptStatsByDay: o.promptStatsByDay ?? {},
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
// detectInsights composes these 15 detect() functions from a shared `ctx`
// prelude (a/totals/sessions/windowCost/sessionCount). Calling each one
// directly — bypassing detectInsights's flatMap+sort — proves each one's
// firing behavior holds in isolation, independent of the other 14.

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

// ── latency-regression / unrestricted-mode ───────────────────────────────────
// Brand new detectors, not extractions — so both the boundary-style and the
// direct _detectors[] coverage are written together, same as everything above.

// Session end time is start + minutes (see sessionEndMs in the source), so
// each fixture gets a distinct `start` to make the half-split unambiguous.
// latHist buckets: [0]<2s [1]2-5s [2]5-10s [3]10-30s [4]30-60s [5]60s+
// (LAT_BUCKET_EDGES = [2, 5, 10, 30, 60] — pinned equal to the source's copy
// by usage-index.test.mjs, not re-pinned here).
const latSession = (start, latHist, latCount) => session({ start, minutes: 10, latHist, latCount });

// First half: two sessions merging to [0,0,30,0,0,0] → bucket-interpolated
// p50 7.5s. Second half: two sessions merging to [0,0,16,20,0,0] → p50 12s.
// +4.5s absolute and +60% relative clear both floors.
const latencyFiresAgg = () => makeAgg({
  sessions: [
    latSession('2026-07-01T00:00:00.000Z', [0, 0, 15, 0, 0, 0], 15),
    latSession('2026-07-02T00:00:00.000Z', [0, 0, 15, 0, 0, 0], 15),
    latSession('2026-07-20T00:00:00.000Z', [0, 0, 8, 10, 0, 0], 18),
    latSession('2026-07-21T00:00:00.000Z', [0, 0, 8, 10, 0, 0], 18),
  ],
});

// First half: 20 samples — under the 30-sample floor. Second half: 40
// samples all in the 10-30s bucket (p50 20s), a jump that would clear both
// the relative and absolute floors on delta alone if the sample gate did not
// suppress it first.
const latencyInsufficientAgg = () => makeAgg({
  sessions: [
    latSession('2026-05-01T00:00:00.000Z', [0, 0, 20, 0, 0, 0], 20),
    latSession('2026-05-20T00:00:00.000Z', [0, 0, 0, 40, 0, 0], 40),
  ],
});

// p50 15s -> 16s: +1s absolute (<2s) and +6.7% relative (<25%) — fails both
// floors, not just one.
const latencyModestAgg = () => makeAgg({
  sessions: [
    latSession('2026-06-01T00:00:00.000Z', [0, 0, 10, 20, 0, 0], 30),
    latSession('2026-06-20T00:00:00.000Z', [0, 0, 10, 25, 0, 0], 35),
  ],
});

test('latency-regression fires when the second half is both 25%+ and 2s+ slower', () => {
  const ins = byId(detectInsights(latencyFiresAgg()), 'latency-regression');
  assert.ok(ins);
  assert.equal(ins.kind, 'trend');
  assert.equal(ins.severity, 'warn');
  assert.equal(ins.impact, null);
  assert.match(ins.finding, /7\.5s/);
  assert.match(ins.finding, /12s/);
  assert.match(ins.evidence, /30/);
  assert.match(ins.evidence, /36/);
});

test('latency-regression does not fire when either half has fewer than 30 samples', () => {
  assert.equal(fired(latencyInsufficientAgg(), 'latency-regression'), false);
});

test('latency-regression does not fire on a modest increase that fails both thresholds', () => {
  assert.equal(fired(latencyModestAgg(), 'latency-regression'), false);
});

test('latency-regression does not fire when sessions carry no latency histogram', () => {
  const agg = makeAgg({
    sessions: [
      latSession('2026-04-01T00:00:00.000Z', null, 0),
      latSession('2026-04-20T00:00:00.000Z', null, 0),
    ],
  });
  assert.equal(fired(agg, 'latency-regression'), false);
});

test('_detectors[latency-regression] fires/does not fire directly, matching detectInsights', () => {
  assert.equal(_detectors['latency-regression'](ctxFrom(latencyInsufficientAgg())).length, 0);
  assert.equal(_detectors['latency-regression'](ctxFrom(latencyFiresAgg())).length, 1);
});

// ── AND-gate pinning ─────────────────────────────────────────────────────────
// The two floors (relative and absolute) are combined with AND, not OR — each
// of the next two fixtures clears exactly one floor and must still not fire.
// p50s are placed by exact bucket arithmetic (verified against the real
// percentileFromBuckets before being written here), not eyeballed.

// Bucket [2,5): lo=2, hi=5. All 30 samples in that one bucket → cum=0, n=30,
// frac=(N/2-cum)/n=0.5 → p50 = 2 + 3*0.5 = 3.5.
// Bucket [5,10): lo=5, hi=10, cum=23 (bucket [2,5)), n=25 (bucket [5,10)),
// N=48 → frac=(24-23)/25=0.04 → p50 = 5 + 5*0.04 = 5.2.
// Delta: +1.7s absolute (<2s floor — FAILS), +48.6% relative (>=25% floor —
// PASSES). Percent passes, absolute fails: must not fire.
const latencyPercentOnlyAgg = () => makeAgg({
  sessions: [
    latSession('2026-03-01T00:00:00.000Z', [0, 30, 0, 0, 0, 0], 30),
    latSession('2026-03-20T00:00:00.000Z', [0, 23, 25, 0, 0, 0], 48),
  ],
});

test('latency-regression does not fire when only the relative floor clears (percent passes, absolute fails)', () => {
  assert.equal(fired(latencyPercentOnlyAgg(), 'latency-regression'), false);
});

// Bucket [30,60): lo=30, hi=60. First half: cum=10 (bucket [10,30)), n=30
// (bucket [30,60)), N=40 → frac=(20-10)/30=0.3333 → p50 = 30 + 30*0.3333 = 40.
// Second half: cum=2, n=30, N=32 → frac=(16-2)/30=0.4667 → p50 = 30 + 30*0.4667 = 44.
// Delta: +4s absolute (>=2s floor — PASSES), +10% relative (<25% floor —
// FAILS). Absolute passes, percent fails: must not fire.
const latencyAbsoluteOnlyAgg = () => makeAgg({
  sessions: [
    latSession('2026-02-01T00:00:00.000Z', [0, 0, 0, 10, 30, 0], 40),
    latSession('2026-02-20T00:00:00.000Z', [0, 0, 0, 2, 30, 0], 32),
  ],
});

test('latency-regression does not fire when only the absolute floor clears (absolute passes, percent fails)', () => {
  assert.equal(fired(latencyAbsoluteOnlyAgg(), 'latency-regression'), false);
});

// Reuses the fires-fixture's own bucket shapes (p50 7.5s -> 12s: +4.5s
// absolute and +60% relative, both comfortably clearing) but drops the first
// half to 29 samples — one under the 30-sample floor. Both delta floors pass;
// the sample floor alone must still suppress the finding.
const latencySampleFloorAgg = () => makeAgg({
  sessions: [
    latSession('2026-01-01T00:00:00.000Z', [0, 0, 29, 0, 0, 0], 29),
    latSession('2026-01-20T00:00:00.000Z', [0, 0, 16, 20, 0, 0], 36),
  ],
});

test('latency-regression does not fire at 29 samples even when both delta floors would otherwise pass', () => {
  assert.equal(fired(latencySampleFloorAgg(), 'latency-regression'), false);
});

// unrestricted-mode
const unrestrictedAgg = () => makeAgg({
  sessions: [
    session({ mode: 'unrestricted', cost: 42, project: 'alpha' }),
    session({ mode: 'guarded', cost: 58, project: 'beta' }),
  ],
});

test('unrestricted-mode fires on a recorded unrestricted session, naming count/cost/project', () => {
  const ins = byId(detectInsights(unrestrictedAgg()), 'unrestricted-mode');
  assert.ok(ins);
  assert.equal(ins.kind, 'coach');
  assert.equal(ins.severity, 'info');
  assert.equal(ins.impact, null);
  assert.match(ins.finding, /1 session/);
  assert.match(ins.finding, /1 project/);
  assert.match(ins.finding, /\$42/);
  assert.match(ins.evidence, /post-ledger/);
});

test('unrestricted-mode does not fire on null or not-recorded modes', () => {
  const agg = makeAgg({
    sessions: [
      session({ mode: null, cost: 10 }),
      session({ mode: 'not-recorded', cost: 10 }),
      session({ cost: 10 }),   // no mode key observed at all
    ],
  });
  assert.equal(fired(agg, 'unrestricted-mode'), false);
});

test('_detectors[unrestricted-mode] fires/does not fire directly, matching detectInsights', () => {
  const none = makeAgg({ sessions: [session({ mode: 'guarded', cost: 10 })] });
  assert.equal(_detectors['unrestricted-mode'](ctxFrom(none)).length, 0);
  assert.equal(_detectors['unrestricted-mode'](ctxFrom(unrestrictedAgg())).length, 1);
});

// ── v16 prompt detectors (spec §4) ───────────────────────────────────────────
//
// All three read the aggregate's fingerprint-derived slices — promptsByHost,
// promptBaselines and the session rows' typedPrompts — and none of them reads
// a word of prompt text, which is the property the evidence lines claim and
// these tests pin.

/** A per-host prompt bucket in the shape usage-aggregate.sealPromptHosts emits. */
const hostStats = (o = {}) => ({
  typed: 100, taps: 20, tapShare: 0.2, p90TypedTokens: 40,
  personaOpeners: 0, questionShare: 0.1, ...o,
});

const tapAgg = (o = {}) => makeAgg({
  sessions: many(4, { cost: 10, ctxLastTokens: 150_000 }),
  promptsByHost: o.promptsByHost,
  promptBaselines: o.promptBaselines,
});

const overBaseline = () => tapAgg({
  promptsByHost: { claude: hostStats({ typed: 100, taps: 22, tapShare: 0.22 }) },
  promptBaselines: { claude: { tapShareP75_trailing90d: 0.12 } },
});

test('supervision-tap-share fires above the operator\'s OWN baseline, with enough taps', () => {
  const ins = byId(detectInsights(overBaseline()), 'supervision-tap-share');
  assert.ok(ins);
  assert.equal(ins.kind, 'trend');
  assert.equal(ins.severity, 'warn');
  assert.equal(ins.impact, null, 'a token model is not a dollar claim');
  assert.match(ins.evidence, /12%/, 'the finding prints the baseline it compared against');
  assert.match(ins.evidence, /claude/);
  assert.match(ins.evidence, new RegExp(TAP_COST_CAVEAT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the modelled-cost caveat rides verbatim, never paraphrased');
});

test('supervision-tap-share does not fire AT the baseline — only above it', () => {
  assert.equal(fired(tapAgg({
    promptsByHost: { claude: hostStats({ taps: 22, tapShare: 0.12 }) },
    promptBaselines: { claude: { tapShareP75_trailing90d: 0.12 } },
  }), 'supervision-tap-share'), false);
});

test('supervision-tap-share needs the tap-count floor even when the share clears', () => {
  const under = tapAgg({
    promptsByHost: { claude: hostStats({ typed: 100, taps: T.tapMinCount - 1, tapShare: 0.9 }) },
    promptBaselines: { claude: { tapShareP75_trailing90d: 0.12 } },
  });
  assert.equal(fired(under, 'supervision-tap-share'), false,
    '19 taps is not a pattern, however extreme the share looks');

  const at = tapAgg({
    promptsByHost: { claude: hostStats({ typed: 100, taps: T.tapMinCount, tapShare: 0.9 }) },
    promptBaselines: { claude: { tapShareP75_trailing90d: 0.12 } },
  });
  assert.equal(fired(at, 'supervision-tap-share'), true);
});

test('with no personal baseline yet, supervision-tap-share falls back to a STATED floor', () => {
  const noBaseline = (tapShare) => tapAgg({
    promptsByHost: { codex: hostStats({ typed: 200, taps: 40, tapShare }) },
    promptBaselines: {},                       // under 30 active days of history
  });
  assert.equal(fired(noBaseline(T.tapAbsoluteFloorShare), 'supervision-tap-share'), false,
    'at the floor is not above it');
  const ins = byId(detectInsights(noBaseline(0.30)), 'supervision-tap-share');
  assert.ok(ins);
  assert.match(ins.evidence, /10%/, 'the fallback floor is printed, not silently applied');
  assert.match(ins.evidence, /baseline/i);
});

test('an explicit null baseline reads the same as an absent one', () => {
  const agg = tapAgg({
    promptsByHost: { claude: hostStats({ typed: 200, taps: 40, tapShare: 0.05 }) },
    promptBaselines: { claude: { tapShareP75_trailing90d: null } },
  });
  assert.equal(fired(agg, 'supervision-tap-share'), false,
    '5% is under the absolute floor, and there is no personal normal to beat');
});

test('supervision-tap-share stays silent when the prompt layer is absent entirely', () => {
  assert.equal(fired(makeAgg({ sessions: many(4, { cost: 10 }) }), 'supervision-tap-share'), false);
});

test('_detectors[supervision-tap-share] matches detectInsights', () => {
  assert.equal(_detectors['supervision-tap-share'](ctxFrom(overBaseline())).length, 1);
  assert.equal(_detectors['supervision-tap-share'](ctxFrom(makeAgg())).length, 0);
});

// headless-share -------------------------------------------------------------

/** `headless` sessions carry the fingerprint layer and typed nothing. */
const headlessAgg = (headlessResponses, typedResponses) => makeAgg({
  sessions: [
    session({ typedPrompts: 0, tapPrompts: 0, responses: headlessResponses, cost: 10 }),
    session({ typedPrompts: 5, tapPrompts: 1, responses: typedResponses, cost: 10 }),
  ],
});

test('headless-share fires above a quarter of responses, as an info reframe', () => {
  const ins = byId(detectInsights(headlessAgg(30, 70)), 'headless-share');
  assert.ok(ins);
  assert.equal(ins.kind, 'coach');
  assert.equal(ins.severity, 'info');
  assert.equal(ins.impact, null);
  assert.match(ins.finding, /1 session/, 'the evidence carries both counts');
  assert.match(ins.finding, /30/);
});

test('headless-share does not fire AT the threshold', () => {
  assert.equal(fired(headlessAgg(25, 75), 'headless-share'), false);
  assert.equal(fired(headlessAgg(26, 74), 'headless-share'), true);
});

test('headless-share ignores sessions with no fingerprint layer, rather than counting them headless', () => {
  const agg = makeAgg({
    sessions: [
      session({ typedPrompts: null, responses: 900, cost: 10 }),   // pre-v16: unknowable
      session({ typedPrompts: 0, tapPrompts: 0, responses: 10, cost: 10 }),
      session({ typedPrompts: 4, tapPrompts: 0, responses: 90, cost: 10 }),
    ],
  });
  const ins = byId(detectInsights(agg), 'headless-share');
  assert.equal(ins, undefined,
    '10 of the 100 CLASSIFIABLE responses are headless — the 900 unknowable ones are not evidence either way');
});

test('_detectors[headless-share] matches detectInsights', () => {
  assert.equal(_detectors['headless-share'](ctxFrom(headlessAgg(30, 70))).length, 1);
  assert.equal(_detectors['headless-share'](ctxFrom(headlessAgg(25, 75))).length, 0);
});

// host-prompt-asymmetry ------------------------------------------------------

const asymAgg = (byHost) => makeAgg({ sessions: many(2, { cost: 10 }), promptsByHost: byHost });

const ratioAgg = (claudeP90, codexP90, typed = 50) => asymAgg({
  claude: hostStats({ typed, p90TypedTokens: claudeP90 }),
  codex: hostStats({ typed, p90TypedTokens: codexP90 }),
});

test('host-prompt-asymmetry fires on a p90 length ratio between two well-evidenced hosts', () => {
  const ins = byId(detectInsights(ratioAgg(60, 40)), 'host-prompt-asymmetry');
  assert.ok(ins, '60:40 is exactly 1.5×');
  assert.equal(ins.kind, 'coach');
  assert.equal(ins.severity, 'info');
  assert.equal(ins.impact, null);
  assert.match(ins.evidence, /1\.5/, 'the ratio itself is on the card');
  assert.match(ins.evidence, /no prompt text/i, 'and the basis: nothing was read');
});

test('host-prompt-asymmetry does not fire just under the ratio', () => {
  assert.equal(fired(ratioAgg(59, 40), 'host-prompt-asymmetry'), false);
});

test('host-prompt-asymmetry needs BOTH hosts to clear the typed-prompt floor', () => {
  assert.equal(fired(asymAgg({
    claude: hostStats({ typed: T.asymmetryMinTypedPerHost, p90TypedTokens: 60 }),
    codex: hostStats({ typed: T.asymmetryMinTypedPerHost - 1, p90TypedTokens: 40 }),
  }), 'host-prompt-asymmetry'), false, 'a 49-prompt host is not a comparison, it is an anecdote');
});

test('host-prompt-asymmetry also fires on persona openers alone, with no ratio at all', () => {
  const ins = byId(detectInsights(asymAgg({
    claude: hostStats({ typed: 10, p90TypedTokens: 40, personaOpeners: 0 }),
    codex: hostStats({ typed: 12, p90TypedTokens: 40, personaOpeners: T.personaOpenerMinCount }),
  })), 'host-prompt-asymmetry');
  assert.ok(ins, 'ten retyped role assignments is the role-library signal, ratio or no ratio');
  assert.match(ins.evidence, /10 persona/);
});

test('host-prompt-asymmetry does not fire one persona opener short, with no ratio', () => {
  assert.equal(fired(asymAgg({
    claude: hostStats({ typed: 10, p90TypedTokens: 40, personaOpeners: 0 }),
    codex: hostStats({ typed: 12, p90TypedTokens: 40, personaOpeners: T.personaOpenerMinCount - 1 }),
  }), 'host-prompt-asymmetry'), false);
});

test('host-prompt-asymmetry stays silent on a single-host window', () => {
  assert.equal(fired(asymAgg({ claude: hostStats({ typed: 500, p90TypedTokens: 400 }) }),
    'host-prompt-asymmetry'), false, 'there is no other host to be asymmetric with');
});

test('_detectors[host-prompt-asymmetry] matches detectInsights', () => {
  assert.equal(_detectors['host-prompt-asymmetry'](ctxFrom(ratioAgg(60, 40))).length, 1);
  assert.equal(_detectors['host-prompt-asymmetry'](ctxFrom(ratioAgg(59, 40))).length, 0);
});

test('the three prompt detectors never touch prompt text, because there is none to touch', () => {
  const agg = makeAgg({
    sessions: [session({ typedPrompts: 0, tapPrompts: 0, responses: 40, cost: 10, ctxLastTokens: 150_000 }),
      session({ typedPrompts: 40, tapPrompts: 30, responses: 60, cost: 10, ctxLastTokens: 150_000 })],
    promptsByHost: {
      claude: hostStats({ typed: 100, taps: 40, tapShare: 0.4, p90TypedTokens: 90, personaOpeners: 12 }),
      codex: hostStats({ typed: 100, taps: 5, tapShare: 0.05, p90TypedTokens: 40 }),
    },
    promptBaselines: { claude: { tapShareP75_trailing90d: 0.12 } },
  });
  const ids = detectInsights(agg).map((i) => i.id);
  for (const id of ['supervision-tap-share', 'headless-share', 'host-prompt-asymmetry']) {
    assert.ok(ids.includes(id), `${id} expected to fire on this fixture`);
  }
  // The aggregate slices these read carry counts and shares only — the pin is
  // that the fixture never had a text field for a detector to reach for.
  assert.equal(JSON.stringify(agg).includes('"text"'), false);
});
