import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JS } from '../../src/lib/dashboard/client.mjs';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
import { CSS } from '../../src/lib/dashboard/styles.mjs';
import { esc as groupsEsc } from '../../src/lib/dashboard/groups.mjs';
import { startDashboard } from '../../src/lib/dashboard-server.mjs';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';
import { blankSession, addUsage, notePromptFingerprint } from '../../src/lib/usage-parsers.mjs';
import { MODES } from '../../src/lib/usage-modes.mjs';
import { loadLedger as realLoadLedger, saveLedger as realSaveLedger } from '../../src/lib/usage-outcome-ledger.mjs';
import {
  loadLabelStore as realLoadLabelStore, saveLabelStore as realSaveLabelStore,
} from '../../src/lib/usage-label-store.mjs';
import { citedEvidenceHash } from '../../src/lib/usage-enrich.mjs';
import {
  deltaChip, sparklineSvg, histogram, stackedDays, donut2, rankedRows,
  bucketPercentile, bucketPositionPct,
} from '../../src/lib/dashboard/client/usage-rhythm.mjs';
import {
  coachingPanel, hostInterplay, hostTapSeries, promptKpis,
  provenancePanel, steerPanel, tapLengthPanel,
} from '../../src/lib/dashboard/client/usage-prompts.mjs';
import {
  percentileFromBuckets, LAT_BUCKET_EDGES, LEN_BUCKET_EDGES,
  BASELINE_TRAILING_DAYS, BASELINE_MIN_ACTIVE_DAYS,
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

// A Codex pool label is "GPT-5.3-Codex-Spark · weekly" — 183px of text in a
// 137px column, so the shared .mrow grid ellipsised it to "GPT-5.3-Codex-Sp…".
// That is what hid one pool being reported under two lanes: both rows truncated
// to something plausible. Measured across 1000-1600px, the widened column fits
// the full string with no row overflow; the tooltip covers the narrow band
// below that, where two panels still sit side by side. The track is capped
// rather than content-sized so every row's meter still starts at the same x.
test('a limits row shows the whole pool label, and carries it as a tooltip regardless', () => {
  assert.match(CSS, /\.lim \.mrow\{grid-template-columns:minmax\(0,190px\)/,
    'the limits label column is widened past the shared magnitude grid, and stays a fixed track');
  assert.match(JS, /class="mname" title="'\+esc\(label\)\+'">'\+esc\(label\)/,
    'the full label is the title, so an ellipsised row is still readable on hover');
  assert.match(JS, /limRow\(lane\.name\+" · "\+\(w\.label\|\|""\)/,
    'a Codex row is named pool + window duration');
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

// Every /api/usage route now also computes coaching (dashboard-server.mjs's
// dashboardCoachingPayload), which by default reads the REAL
// ~/.config/agentic-kit ledger — exactly the "tests must never read the real
// ~/.config" hazard `usage`/`limits` are already injected to avoid here. A
// blank in-memory ledger keeps every /api/usage test in this file hermetic.
const NULL_COACHING_LEDGER = { loadLedger: () => ({ version: 1, records: [] }), ledgerPath: '/dev/null/unused' };

// W5 enrichment (spec §6.3): the SAME hazard, one file over — dashboard-
// server.mjs now also reads the persisted label/card store on every
// /api/usage poll (read-only). A blank in-memory store keeps every test in
// this file hermetic against the real ~/.config/agentic-kit label store too.
const NULL_LABEL_STORE = {
  loadLabelStore: () => ({ version: 1, labels: {}, cards: {} }), labelStorePath: '/dev/null/unused',
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

/**
 * A fake `readIndex` that behaves like usage-index.mjs's real scan on BOTH
 * cutoffs, not just the display one:
 *
 *   - the DISCOVERY cutoff (`now - (lookbackDays ?? days)`) filters which
 *     records are visible at all — usage-index.mjs:732 and its candidate
 *     filter at :740;
 *   - the DISPLAY cutoff (`now - days`) is what `aggregate` is handed, so the
 *     current window never widens with the lookback (usage-index.mjs:785-793).
 *
 * Honouring the first is what makes an assertion about `lookbackDays` mean
 * something. A fake that hands every fixture record to `aggregate` regardless
 * would report a healthy baseline no matter what the server asked for, which
 * is precisely the regression these tests exist to catch.
 */
function spyReadIndex(records, calls) {
  return async (opts) => {
    calls.push(opts);
    const days = opts?.days ?? 14;
    const discovery = NOW - (opts?.lookbackDays ?? days) * DAY_MS;
    return aggregate(records.filter((r) => r.end >= discovery), {
      days, now: NOW, cutoff: NOW - days * DAY_MS, deps: FIXTURE_DEPS,
      // Both projection flags ride through from the caller's own options
      // unchanged, so a payload that carries a projection is proof the server
      // asked for it — not proof that this fake builds one unconditionally.
      previous: !!opts?.previous, prompts: !!opts?.prompts,
    });
  };
}

test('/api/usage payload carries rhythm, mode, provider and a previous-window projection', async () => {
  const calls = [];
  // Mirrors usage-index.mjs's corrected buildIndex/scan contract (Task 7
  // ruling B): `aggregate` always sees the DISPLAY cutoff, and `previous`
  // rides through from the caller's own options unchanged.
  const usage = { readIndex: spyReadIndex(FIXTURE_RECORDS, calls) };
  const srv = await startDashboard({
    port: 0, fetchStatus: async () => ({ overall: 'ok', rows: [] }), usage, coachingLedger: NULL_COACHING_LEDGER, labelStore: NULL_LABEL_STORE,
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
    assert.equal(call.lookbackDays, 7 + BASELINE_TRAILING_DAYS,
      'lookbackDays must reach past the window by the full baseline trailing period');
    assert.equal(call.previous, true, 'previous must be requested so agg.previous is populated');
  } finally {
    await srv.close();
  }
});

// ── the baseline's lookback (spec §6.2) ────────────────────────────────────
//
// `promptBaselines` compares the displayed window against the operator's own
// trailing-90d normal, and it reads `records` rather than the window's session
// rows — so it can only ever see history the DISCOVERY cutoff actually pulled
// off disk. At the old `days * 2` lookback a 7-day window reached 14 days
// back, which is 16 short of BASELINE_MIN_ACTIVE_DAYS before the trailing
// period has even started: every baseline was structurally null, and every
// detector keyed on one silently fell back to its absolute threshold.
//
// The display cutoff is unaffected — widening discovery never widens the
// window (usage-index.mjs:785-793), which the sibling assertion on
// `totals.sessions` below pins.
const BASELINE_HOST = 'claude';

/** One trailing-history record: a typed human prompt on its own local day,
 *  billed that same day so `firstBilledDay` attributes it there. */
function baselineRecord(i, endMs) {
  const d = new Date(endMs);
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const rec = blankSession(`base-${i}`, BASELINE_HOST);
  Object.assign(rec, {
    title: `base-${i}`, project: 'proj', prompts: 2, responses: 1,
    start: endMs - 60_000, end: endMs,
  });
  rec.active = [[endMs - 60_000, endMs]];
  addUsage(rec, day, 'claude-opus-5', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, responses: 1 });
  rec.models = ['claude-opus-5'];
  // One instruction and one tap, so the day carries a real tap share rather
  // than a degenerate 0 or 1.
  rec.promptFPs = [
    { h: `h${i}a`, t: 40, th: [`t${i}a`], p: 'human' },
    { h: `h${i}b`, t: 2, th: [`t${i}b`], p: 'human' },
  ];
  return rec;
}

test('the baseline lookback reaches far enough back for promptBaselines to exist', async () => {
  // 35 consecutive days of history starting 10 days back — comfortably past
  // BASELINE_MIN_ACTIVE_DAYS, and every one of them outside the 7-day window.
  const trailing = Array.from({ length: 35 }, (_v, i) => baselineRecord(i, NOW - (10 + i) * DAY_MS));
  assert.ok(trailing.length > BASELINE_MIN_ACTIVE_DAYS,
    'the fixture must clear the minimum-active-days floor, or a null baseline proves nothing');

  const calls = [];
  const srv = await startDashboard({
    port: 0, fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: { readIndex: spyReadIndex(trailing, calls) }, coachingLedger: NULL_COACHING_LEDGER, labelStore: NULL_LABEL_STORE,
  });
  try {
    const r = await get(`${srv.url}api/usage?days=7`, srv.token);
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const payload = JSON.parse(r.body);

    const baseline = payload.promptBaselines?.[BASELINE_HOST];
    assert.ok(baseline, `promptBaselines must carry the ${BASELINE_HOST} host, got ${JSON.stringify(payload.promptBaselines)}`);
    assert.ok(Number.isFinite(baseline.tapShareP75_trailing90d),
      'the trailing p75 must be a number — null here means the lookback never reached the history');

    assert.equal(payload.totals.sessions, 0,
      'widening discovery must not widen the displayed window: every fixture session is older than 7 days');
  } finally {
    await srv.close();
  }
});

// ── the prompts payload (spec §3) ──────────────────────────────────────────
//
// `prompts.patterns` is `agg.promptPatterns` verbatim — the single projection
// usage-aggregate.mjs builds and `ak usage prompts` also reads. These tests
// therefore assert the SERVER's contribution (that it asks for the projection,
// forwards it intact, and computes the headless fraction the shipped detector's
// way) rather than re-testing the projection itself, which has its own pins.
//
// Fingerprints are built through the REAL scan-path helper rather than
// hand-written, because the whole privacy claim is about what that helper
// writes: a hand-rolled `{h,t,th,p}` would pass a pin it never actually tested.

/** The prompts these fixtures type, kept as data so the privacy pin can scan
 *  the payload for every word of them. */
const FIXTURE_PROMPTS = {
  instruction: 'Commit and push the payload branch.',
  tap: 'yes',
  persona: 'You are a staff release engineer. Review the changelog, confirm the semantic version, '
    + 'and prepare the announcement copy for the maintainers list.',
};

function promptRecord(id, host, endMs, texts) {
  const d = new Date(endMs);
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const rec = blankSession(id, host);
  Object.assign(rec, {
    title: id, project: 'proj', prompts: texts.length, responses: 2,
    start: endMs - 10 * 60_000, end: endMs,
  });
  rec.active = [[endMs - 10 * 60_000, endMs]];
  addUsage(rec, day, 'claude-opus-5', { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, responses: 2 });
  rec.models = ['claude-opus-5'];
  rec.lenSeconds = 600;
  for (const text of texts) notePromptFingerprint(rec, text, 'prompt');
  return rec;
}

/** Six sessions over four days and two hosts: one instruction repeated in
 *  every session (a recurring cluster), a tap in every session, and a persona
 *  opener on the Codex side only. Plus one session that types nothing, which
 *  is what makes the headless fraction non-degenerate. */
const PROMPT_RECORDS = [
  ...Array.from({ length: 6 }, (_v, i) => promptRecord(
    `p-${i}`, i % 2 ? 'codex' : 'claude', NOW - (1 + (i % 4)) * DAY_MS,
    i % 2
      ? [FIXTURE_PROMPTS.instruction, FIXTURE_PROMPTS.tap, FIXTURE_PROMPTS.persona]
      : [FIXTURE_PROMPTS.instruction, FIXTURE_PROMPTS.tap],
  )),
  promptRecord('p-headless', 'claude', NOW - 2 * DAY_MS, []),
];

/** Every string that appears anywhere in `value`, at any depth, keys included
 *  — the privacy pin walks values AND keys because a leak that arrives as an
 *  object key is still a leak. */
function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); allStrings(v, out); }
  }
  return out;
}

async function promptsPayload(days = 7) {
  const calls = [];
  const srv = await startDashboard({
    port: 0, fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: { readIndex: spyReadIndex(PROMPT_RECORDS, calls) }, coachingLedger: NULL_COACHING_LEDGER, labelStore: NULL_LABEL_STORE,
  });
  try {
    const r = await get(`${srv.url}api/usage?days=${days}`, srv.token);
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    return { prompts: JSON.parse(r.body).prompts, calls };
  } finally {
    await srv.close();
  }
}

test('/api/usage asks for the prompt projection and ships it intact', async () => {
  const { prompts, calls } = await promptsPayload();
  assert.ok(prompts, 'the payload must carry a prompts block');
  assert.ok(calls.some((o) => o && o.prompts === true),
    `the server must request the projection, got ${JSON.stringify(calls)}`);

  // 6 typing sessions: 2 prompts each on claude (3 sessions), 3 each on codex
  // (3 sessions) = 6 + 9 = 15 typed; one tap per typing session = 6.
  assert.equal(prompts.typed, 15, 'typed counts provenance-human fingerprints only');
  assert.equal(prompts.taps, 6, 'one tap per typing session');
  assert.equal(prompts.tapShare, 0.4, 'tapShare is taps ÷ typed, not a second derivation');

  assert.deepEqual(Object.keys(prompts.byHost).sort(), ['claude', 'codex']);
  assert.equal(prompts.byHost.codex.personaOpeners, 3, 'the persona opener is a Codex-side shape');
  assert.equal(prompts.byHost.claude.personaOpeners, 0);

  for (const row of Object.values(prompts.statsByDay)) {
    assert.ok(row.typed >= row.taps, 'a day cannot have more taps than typed prompts');
  }

  // No trailing history in this fixture, so a baseline would be an invention.
  for (const b of Object.values(prompts.baselines)) {
    assert.equal(b.tapShareP75_trailing90d, null,
      'under BASELINE_MIN_ACTIVE_DAYS the baseline is null, never a number from a handful of days');
  }
});

test('/api/usage carries a coaching payload shaped {cards, summary}, computed read-only', async () => {
  const { prompts } = await promptsPayload();
  assert.ok(prompts.coaching, 'the prompts payload must carry a coaching key');
  assert.deepEqual(Object.keys(prompts.coaching).sort(), ['cards', 'summary']);
  assert.ok(Array.isArray(prompts.coaching.cards));
  assert.deepEqual(prompts.coaching.summary, { proposed: 0, adopted: 0, dismissed: 0, expired: 0, retired: 0 },
    'PROMPT_RECORDS fires none of the six v1 rules, so the ledger summary must be all zeros, not absent');
});

// Fix round 1, M-8: dashboardCoachingPayload genuinely cannot save (it never
// imports saveLedger) — this pins the READ-ONLY CONTRACT directly, on a REAL
// ledger file with a REAL record, across several polls, rather than only
// incidentally via a bogus ledgerPath that would throw if ever written to.
test('M-8: the ledger file\'s bytes are byte-for-byte unchanged after several /api/usage polls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dash-m8-'));
  const ledgerPath = path.join(dir, 'usage-outcome-ledger.json');
  realSaveLedger(ledgerPath, {
    version: 1,
    records: [{
      id: 'commit-push-claude-md', evidenceHash: 'a'.repeat(16), status: 'dismissed',
      generatedAt: '2026-08-01T00:00:00.000Z', statusAt: '2026-08-01T00:00:00.000Z',
      baseline: { count: 12, clusterKey: 'k', sessions: 8, days: 4 }, windowDays: 30, dismissCount: 1,
    }],
  });
  const before = fs.readFileSync(ledgerPath);

  const calls = [];
  const srv = await startDashboard({
    port: 0, fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: { readIndex: spyReadIndex(PROMPT_RECORDS, calls) },
    coachingLedger: { loadLedger: realLoadLedger, ledgerPath }, labelStore: NULL_LABEL_STORE,
  });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await get(`${srv.url}api/usage?days=7`, srv.token);
      assert.equal(r.status, 200, `expected 200, got ${r.status}`);
      const { coaching } = JSON.parse(r.body).prompts;
      // PROMPT_RECORDS fires none of the six v1 rules (see the payload-shape
      // test above), so the dismissed record has no live card to annotate
      // this pass — but it survives untouched in the ledger the summary
      // counts, which is what proves the poll actually READ the real file
      // rather than a stub that returns an empty ledger.
      assert.equal(coaching.summary.dismissed, 1, 'the poll must read the REAL ledger, not a no-op stub');
    }
  } finally {
    await srv.close();
  }

  const after = fs.readFileSync(ledgerPath);
  assert.ok(before.equals(after), 'the ledger file must be byte-for-byte unchanged after multiple dashboard polls');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── W5 enrichment (spec §6.3/§6.4, deliverable §5): the dashboard applies a
// PERSISTED store read-only — it never calls makeInvoke/enrichLabels/
// synthesizeCards/saveLabelStore (none of those are even imported into
// dashboard-server.mjs). These tests write the store directly with the real
// usage-label-store.mjs module, the same way the M-8 test above writes a
// real ledger, and prove the dashboard reads it without ever mutating it.

test('a persisted enriched label applies to its cluster in the /api/usage payload, and the store file is untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dash-labels-'));
  const labelStorePath = path.join(dir, 'usage-prompt-labels.json');

  // Discover the real cluster key PROMPT_RECORDS produces, the same way a
  // real `--enrich` pass would have — never a hand-guessed hash.
  const before = await promptsPayload();
  const cluster = before.prompts.patterns.clusters[0];
  assert.ok(cluster, 'the fixture must produce at least one cluster to label');

  realSaveLabelStore(labelStorePath, {
    version: 1,
    labels: { [cluster.key]: { name: 'Dashboard-enriched name', source: 'enriched', firstSeen: '2026-08-01T00:00:00.000Z' } },
    cards: {},
  });
  const beforeBytes = fs.readFileSync(labelStorePath);

  const calls = [];
  const srv = await startDashboard({
    port: 0, fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: { readIndex: spyReadIndex(PROMPT_RECORDS, calls) }, coachingLedger: NULL_COACHING_LEDGER,
    labelStore: { loadLabelStore: realLoadLabelStore, labelStorePath },
  });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await get(`${srv.url}api/usage?days=7`, srv.token);
      assert.equal(r.status, 200, `expected 200, got ${r.status}`);
      const { patterns } = JSON.parse(r.body).prompts;
      const labeled = patterns.clusters.find((c) => c.key === cluster.key);
      assert.equal(labeled.label.name, 'Dashboard-enriched name');
      assert.equal(labeled.label.source, 'enriched');
    }
  } finally {
    await srv.close();
  }

  assert.ok(beforeBytes.equals(fs.readFileSync(labelStorePath)),
    'the label store file must be byte-for-byte unchanged after multiple dashboard polls — read-only');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a persisted enriched card rejoins coaching every poll, exactly like a rule card, and a stale one is marked stale', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dash-cards-'));
  const labelStorePath = path.join(dir, 'usage-prompt-labels.json');

  const freshCard = {
    title: 'A dashboard-visible enriched suggestion', finding: 'This recurred 6 times.',
    try: 'Try the obvious thing.', basis: '6 recurrences.', basisNumbers: [6],
    evidenceHash: 'will-be-replaced', generatedAt: '2026-08-01T00:00:00.000Z',
  };
  const staleCard = {
    title: 'A stale suggestion', finding: 'This once recurred 999 times.',
    try: 'Try something else.', basis: '999 recurrences.', basisNumbers: [999],
    // Hashed against a summary that DID contain 999 — simulating "999 was
    // real at synthesis time" — so the drift is genuine: the REAL current
    // findingsSummary (built below) does not contain 999, so citedEvidenceHash
    // recomputes a SMALLER present-set and the hash moves. Hashing against an
    // empty/non-matching summary here would make both computations agree on
    // "nothing present" and never trip staleness at all — not what this test
    // means to prove.
    evidenceHash: citedEvidenceHash({ onceTrue: 999 }, [999]), generatedAt: '2026-08-01T00:00:00.000Z',
  };

  // Compute the fresh card's REAL evidenceHash against what the fixture's
  // own canonical findingsSummary will actually contain (6 typed prompts per
  // typing session — see promptRecord/PROMPT_RECORDS above), so it reads as
  // genuinely fresh rather than stale-by-construction.
  const probe = await promptsPayload(30);
  const summaryNumbers = new Set();
  const walk = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) summaryNumbers.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(probe.prompts.patterns);
  walk(probe.prompts.byHost);
  const realNumber = [...summaryNumbers].find((n) => Number.isInteger(n) && n > 0);
  assert.ok(realNumber !== undefined, 'the fixture must carry at least one real positive integer to ground a card in');
  freshCard.finding = `This recurred ${realNumber} times.`;
  freshCard.basis = `${realNumber} recurrences.`;
  freshCard.basisNumbers = [realNumber];
  freshCard.evidenceHash = citedEvidenceHash(
    { clusters: probe.prompts.patterns.clusters, byHost: probe.prompts.byHost }, [realNumber],
  );

  realSaveLabelStore(labelStorePath, {
    version: 1, labels: {}, cards: { 'enriched-fresh': freshCard, 'enriched-stale': staleCard },
  });

  const calls = [];
  const srv = await startDashboard({
    port: 0, fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: { readIndex: spyReadIndex(PROMPT_RECORDS, calls) }, coachingLedger: NULL_COACHING_LEDGER,
    labelStore: { loadLabelStore: realLoadLabelStore, labelStorePath },
  });
  try {
    const r = await get(`${srv.url}api/usage?days=30`, srv.token);
    assert.equal(r.status, 200, r.body);
    const { coaching } = JSON.parse(r.body).prompts;
    const fresh = coaching.cards.find((c) => c.id === 'enriched-fresh');
    const stale = coaching.cards.find((c) => c.id === 'enriched-stale');
    assert.ok(fresh, `enriched-fresh must reconcile like a rule card: ${JSON.stringify(coaching.cards.map((c) => c.id))}`);
    assert.equal(fresh.status, 'proposed');
    assert.equal(fresh.stale, false);
    assert.ok(stale, 'enriched-stale must also reconcile');
    assert.equal(stale.stale, true, '999 does not appear anywhere in this fixture\'s findings — must read as stale');
  } finally {
    await srv.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the projection reaches the payload with its published shape', async () => {
  const { prompts } = await promptsPayload();
  const pat = prompts.patterns;
  assert.ok(pat, 'promptPatterns must survive into prompts.patterns');

  assert.equal(pat.corpus.typed, 15, 'corpus.typed is the provenance-filtered population');
  assert.ok(pat.corpus.fingerprints >= pat.corpus.typed,
    'the fingerprinted population is the denominator typed sits inside');
  assert.equal(pat.provenance.human, 15, 'every fixture prompt was typed by a person');
  for (const tag of ['human', 'control', 'agent', 'adapter']) {
    assert.equal(typeof pat.provenance[tag], 'number',
      `every provenance tag renders, including ones this corpus never produced (${tag})`);
  }

  const lead = pat.clusters[0];
  assert.equal(lead.count, 6, 'the instruction was typed once in each of the six typing sessions');
  assert.equal(lead.sessions, 6, 'sessions is a COUNT, not a list');
  assert.ok(lead.days >= 2, 'the cluster spans days, which is half of the recurrence disjunction');
  assert.deepEqual(lead.hosts, ['claude', 'codex'], 'hosts is a sorted array of names');
  assert.ok(lead.sampleSessionIds.length <= 3, 'at most three link ids, never a membership dump');
  assert.equal(typeof lead.medianTokens, 'number');
  assert.ok(lead.label.name.length > 0, 'every cluster is named');

  assert.equal(typeof pat.reAsks.pairCount, 'number', 're-asks ship as counts, not as a pair list');
  assert.equal(typeof pat.reAsks.sessionCount, 'number');
  assert.ok(pat.reAsks.gapHist && typeof pat.reAsks.gapHist === 'object');
  assert.ok(Array.isArray(pat.tapLengths) && Array.isArray(pat.exactRepeats));
  assert.ok(!Number.isNaN(Date.parse(pat.computedAt)), 'the projection stamps when it was computed');
});

// Now that decoration converts the scan path's numeric q/o flags to the
// booleans the clustering library reads, a cluster of six identical
// instructions must actually be CLASSIFIED — the whole curated-naming layer
// gates on this, and an 'unknown' here would mean the seam is not doing its job.
test('a recurring instruction cluster is classified, not left unknown', async () => {
  const { prompts } = await promptsPayload();
  const classes = prompts.patterns.clusters.map((c) => c.class);
  assert.ok(classes.some((c) => c !== 'unknown'),
    `every cluster came back unclassified — the q/o decoration is not reaching the library: ${JSON.stringify(classes)}`);
});

test('the headless fraction excludes sessions that carry no fingerprint layer', async () => {
  const { prompts } = await promptsPayload();
  assert.equal(prompts.headless.sessions, 1, 'one fixture session typed nothing');
  assert.equal(prompts.headless.responses, 2, 'and it carried two responses');
  assert.ok(prompts.headless.share > 0 && prompts.headless.share < 1);
  assert.equal(prompts.headless.measuredSessions, 7,
    'the denominator is sessions that CARRY the layer, not every session');
});

// The acceptance criterion in spec §10, applied to the HTTP payload rather
// than the index: nothing the operator typed may appear on this surface, in a
// value or in a key. Word-level rather than whole-string, because a leak that
// arrives truncated or normalized is still a leak.
test('the prompts payload carries no fixture prompt text, at any depth', async () => {
  const { prompts } = await promptsPayload();
  const strings = allStrings(prompts);
  assert.ok(strings.length > 0, 'the walk must actually find strings, or it proves nothing');

  const words = [...new Set(Object.values(FIXTURE_PROMPTS)
    .join(' ').toLowerCase().match(/[a-z]{4,}/g))];
  assert.ok(words.length >= 10, `the fixture must supply real words to hunt for, got ${words.length}`);

  for (const s of strings) {
    const hay = s.toLowerCase();
    for (const w of words) {
      assert.ok(!hay.includes(w),
        `prompt text leaked into the payload: ${JSON.stringify(w)} found in ${JSON.stringify(s)}`);
    }
  }
});

// A structural allowlist, so a field ADDED later cannot quietly carry text
// past the word scan above. Cluster entries are the only place a name string
// reaches this payload, and that name comes from the curated vocabulary.
const CLUSTER_KEYS = new Set(['key', 'label', 'class', 'count', 'sessions', 'days', 'hosts',
  'medianTokens', 'sampleSessionIds', 'kind']);
// `descriptor` (RULING B, final-triage item 2) rides beside `name` only on a
// CHARACTERIZED label — the full "Recurring N-token X · N sessions · N hosts"
// string, still machine-assembled from counts/bands, never prompt text. The
// word-scan test above already covers it (it walks every string reachable
// from the payload); this allowlist only needs to admit the key.
const LABEL_KEYS = new Set(['name', 'source', 'descriptor']);

test('every prompt-pattern entry carries only keys from the allowed set', async () => {
  const { prompts } = await promptsPayload();
  for (const c of prompts.patterns.clusters) {
    for (const k of Object.keys(c)) assert.ok(CLUSTER_KEYS.has(k), `unexpected cluster key ${JSON.stringify(k)}`);
    for (const k of Object.keys(c.label)) assert.ok(LABEL_KEYS.has(k), `unexpected label key ${JSON.stringify(k)}`);
    assert.ok(c.sampleSessionIds.every((id) => typeof id === 'string'),
      'session links are ids, which the masked /api/session route already governs');
  }
});

// ── the bundle's one shared scope ──────────────────────────────────────────
//
// client.mjs concatenates every split module into ONE function scope, so two
// files declaring the same top-level name is a SILENT override: the later
// declaration wins, the earlier file's callers get the wrong function, and
// nothing throws. This was not hypothetical — usage-prompts.mjs shipped a
// `kpiCard` that system-readout.mjs's own `kpiCard` replaced, and the Prompts
// KPI strip rendered with the System tab's markup. No console error, no failing
// assertion; it was caught by looking at the page.
//
// `esc` is the one sanctioned duplicate: usage-rhythm.mjs and
// usage-prompts.mjs each keep a copy on disk so the TESTS can import them as
// real ESM (bootstrap.mjs's `esc` is a build-time placeholder), and client.mjs
// strips both from the bundle.
const BUNDLE_ORDER = [
  'bootstrap.mjs', 'overview.mjs', 'intelligence.mjs', 'poll.mjs', 'usage-rhythm.mjs',
  'usage-prompts.mjs', 'usage.mjs', 'model-lifecycle.mjs', 'usage-orchestrators.mjs',
  'about.mjs', 'system-readout.mjs', 'system-projects.mjs', 'boot.mjs',
];
const STRIPPED_FROM_BUNDLE = new Set(['esc']);

/** Top-level declarations in one split module. A file's top level is the
 *  SMALLEST indentation any declaration in it uses — these files disagree about
 *  whether module scope sits at column 0 or 2, and a fixed guess would either
 *  miss real collisions or report function-local `var`s as global ones. */
function topLevelNames(src) {
  const decl = /^(\s*)(?:export\s+)?(?:function|var)\s+([A-Za-z_$][\w$]*)/;
  const rows = [];
  for (const line of src.split('\n')) {
    const m = decl.exec(line);
    if (m) rows.push({ indent: m[1].length, name: m[2] });
  }
  if (!rows.length) return new Set();
  const top = Math.min(...rows.map((r) => r.indent));
  return new Set(rows.filter((r) => r.indent === top).map((r) => r.name));
}

test('no two client modules declare the same top-level name', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'dashboard', 'client');

  const owner = new Map();
  const collisions = [];
  for (const file of BUNDLE_ORDER) {
    for (const name of topLevelNames(readFileSync(join(dir, file), 'utf8'))) {
      if (owner.has(name) && !STRIPPED_FROM_BUNDLE.has(name)) {
        collisions.push(`${name}: declared in ${owner.get(name)}, silently overridden by ${file}`);
      }
      if (!owner.has(name)) owner.set(name, file);
    }
  }
  assert.deepEqual(collisions, [],
    `${collisions.length} name(s) collide in the shared bundle scope:\n${collisions.join('\n')}`);
  assert.ok(owner.size > 300, `expected the whole client surface, scanned only ${owner.size} names`);
});

test('the sanctioned duplicate escaper is stripped, leaving exactly one in the bundle', () => {
  assert.equal((JS.match(/function esc\(/g) || []).length, 1,
    'two hand copies of esc in one scope would let a later one silently replace the injected escaper');
  assert.equal((JS.match(/^import /gm) || []).length, 0, 'no cross-file import survives into the classic script');
  assert.equal((JS.match(/^\s*export /gm) || []).length, 0, 'no export keyword survives into the classic script');
});

// ── usage-prompts.mjs: the Prompts view's panels ───────────────────────────
//
// Imported as real ESM and exercised on their OUTPUT, not matched against the
// bundle text: a regex over the served string proves a literal shipped, which
// is not the same claim as "the panel renders this correctly". The only
// structural assertions kept are the ones genuinely ABOUT the served artifact —
// the page shell, the escaper strip and the collision scan above.

const PANEL_PROMPTS = {
  typed: 100, taps: 20, tapShare: 0.2,
  byHost: {
    claude: { typed: 60, taps: 6, tapShare: 0.1, p90TypedTokens: 80, personaOpeners: 0, questionShare: 0.3 },
    codex: { typed: 40, taps: 14, tapShare: 0.35, p90TypedTokens: 160, personaOpeners: 7, questionShare: 0.3 },
  },
  statsByDay: {
    '2026-08-18': { typed: 10, taps: 2, byHost: { claude: { typed: 10, taps: 2 } } },
    '2026-08-19': { typed: 12, taps: 6, byHost: { codex: { typed: 12, taps: 6 } } },
    '2026-08-20': { typed: 8, taps: 1, byHost: { claude: { typed: 8, taps: 1 } } },
  },
  baselines: { claude: { tapShareP75_trailing90d: 0.05 }, codex: { tapShareP75_trailing90d: null } },
  headless: { sessions: 3, responses: 40, share: 0.25, measuredSessions: 10, measuredResponses: 160 },
  patterns: {
    corpus: { fingerprints: 250, typed: 100 },
    provenance: { human: 100, control: 60, agent: 70, adapter: 20 },
    tapLengths: [
      { tokens: 1, prompts: 12, sessions: 9, days: 5, hosts: ['claude', 'codex'] },
      { tokens: 3, prompts: 8, sessions: 6, days: 4, hosts: ['codex'] },
    ],
    // Ruling A (final-triage item 1): the SOURCE emits 'other' directly —
    // never 'instruction' — so cluster `aaaa` carries `class: 'other'` here,
    // the real wire shape, not a value this render layer used to rewrite.
    // Ruling B (final-triage item 2): a characterized label now splits `name`
    // (bare lead) from `descriptor` (full string) upstream — clusters `bbbb`/
    // `cccc` carry both.
    clusters: [
      {
        key: 'aaaa', kind: 'instruction', label: { name: 'Commit-and-push instruction', source: 'seed' },
        class: 'other', count: 12, sessions: 9, days: 5, hosts: ['claude', 'codex'],
        medianTokens: 3, sampleSessionIds: ['s1', 's2', 's3'],
      },
      {
        key: 'bbbb', kind: 'question',
        label: {
          name: 'Recurring 44-token prompt', source: 'characterized',
          descriptor: 'Recurring 44-token prompt · 4 sessions · 1 host',
        },
        class: 'question', count: 5, sessions: 4, days: 2, hosts: ['codex'],
        medianTokens: 44, sampleSessionIds: ['s5'],
      },
      {
        key: 'cccc', kind: 'reask',
        label: {
          name: 'Recurring 9-token prompt', source: 'characterized',
          descriptor: 'Recurring 9-token prompt · 3 sessions · 1 host',
        },
        class: 'unknown', count: 3, sessions: 3, days: 2, hosts: ['claude'],
        medianTokens: 9, sampleSessionIds: ['s7'],
      },
    ],
    reAsks: { pairCount: 7, sessionCount: 3, gapHist: { 1: 4, 2: 3 } },
    exactRepeats: [{ key: 'dddd', count: 9, tokens: 2, sessions: 7, days: 4, hosts: ['claude'] }],
    computedAt: '2026-08-20T12:00:00.000Z',
  },
  // P15: the Coaching table shows ONLY patterns that have advice, so the base
  // fixture gives each of its three clusters a clusterKey card. Tests that
  // exercise a SPECIFIC card build their own payload via promptsWithCoaching,
  // which replaces this block wholesale.
  coaching: {
    cards: [
      { id: 'aaaa-card', clusterKey: 'aaaa', targetKind: null, title: 'Commit-and-push retyped',
        try: 'Add a commit-and-push rule to CLAUDE.md.', finding: 'typed 12 times across 9 sessions.',
        source: 'rule', status: 'proposed', draft: { text: 'Commit and push once verified.' } },
      { id: 'bbbb-card', clusterKey: 'bbbb', targetKind: null, title: 'A recurring question',
        try: 'Capture this as a repo skill.', finding: 'asked 5 times across 4 sessions.',
        source: 'rule', status: 'proposed', draft: { text: 'Skill draft.' } },
      { id: 'cccc-card', clusterKey: 'cccc', targetKind: null, title: 'A re-ask pattern',
        try: 'State acceptance criteria up front.', finding: 'recurred 3 times across 3 sessions.',
        source: 'rule', status: 'proposed', draft: { text: 'Done when: <criteria>.' } },
    ],
    summary: null,
  },
};

/** A minimal proposed clusterKey card per cluster. Under P15 the Coaching table
 *  hides any cluster without a joined card, so a fixture that means to render
 *  rows carries one per cluster; fields are kept minimal because these tests
 *  assert row/pill/sort behaviour, not card content. */
function keyCards(clusters) {
  return (clusters || []).map((c) => ({
    id: `${c.key}-card`, clusterKey: c.key, targetKind: null,
    title: `${c.key} advice`, try: `${c.key} advice`, finding: '',
    source: 'rule', status: 'proposed', draft: { text: `${c.key} draft` },
  }));
}

test('the KPI strip renders five tiles, each stating what it does not model', () => {
  const html = promptKpis(PANEL_PROMPTS);
  const tiles = [...html.matchAll(/<div class="kpi"[^>]*title="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(tiles.length, 5, 'spec §3.1 defines five KPIs');
  for (const tip of tiles) {
    assert.match(tip, /Does not model|reframe, not a criticism/,
      `a KPI shipped without its does-not-model line: ${tip.slice(0, 60)}`);
  }
  assert.match(html, />100</, 'typed count comes from corpus.typed');
  assert.match(html, /40% of fingerprinted turns/, '100 typed inside 250 fingerprinted turns');
  assert.match(html, />20%</, '20 of 100 typed prompts sit in a recurring cluster');
  assert.match(html, />30%</, 'the question share is weighted across hosts');
});

// An empty window must not be reported as a measured zero. This is the
// distinction the whole payload draws with null-vs-0, and the panel is the
// last place it can be thrown away.
test('an empty corpus renders an absent state, never a zero', () => {
  const html = promptKpis({
    typed: 0, taps: 0, tapShare: null, byHost: {}, statsByDay: {}, baselines: {}, headless: {},
    patterns: { corpus: { fingerprints: 0, typed: 0 }, provenance: {}, tapLengths: [], clusters: [], reAsks: {}, exactRepeats: [] },
  });
  assert.match(html, /no typed prompts in this window/);
  assert.doesNotMatch(html, /0%/, 'a share of nothing is not a share of zero');
  assert.doesNotMatch(html, /class="kpi"/, 'no tile claims a figure it could not compute');
});

test('a null share renders the absent mark rather than 0%', () => {
  const html = promptKpis({
    ...PANEL_PROMPTS, tapShare: null,
    headless: { ...PANEL_PROMPTS.headless, share: null },
  });
  assert.match(html, /<div class="v">—<\/div>/, 'an unmeasured share prints the em dash');
});

// The chip is the only place a threshold is compared, so it must always name
// what it compared against — a coloured chip with no baseline printed is a
// judgement with its evidence removed.
test('each per-host tap chip names the baseline it was compared against', () => {
  const html = promptKpis(PANEL_PROMPTS);
  assert.match(html, /claude[^<]*10%.*?your p75 5%/s, 'a host with a baseline prints it');
  assert.match(html, /codex[^<]*35%.*?no baseline/s, 'a host without one says so instead of comparing to nothing');
  assert.match(html, /data-tone="bad"/, 'claude is above its own p75, so the chip reads as a rise');
});

test('the repeated share counts every cluster, not the slice the table draws', () => {
  const many = {
    ...PANEL_PROMPTS,
    patterns: {
      ...PANEL_PROMPTS.patterns,
      clusters: Array.from({ length: 40 }, (_v, i) => ({
        key: `k${i}`, label: { name: `Recurring ${i}-token prompt`, source: 'characterized' },
        class: 'other', count: 2, sessions: 3, days: 2, hosts: ['claude'],
        medianTokens: i, sampleSessionIds: ['s1'],
      })),
    },
  };
  // 40 clusters × 2 = 80 of 100 typed, even though the table draws 25 rows.
  assert.match(promptKpis(many), />80%</, 'the KPI sums the whole uncapped list');
  assert.match(promptKpis(many), /40 recurring clusters/);
});

test('the provenance panel names every tag and says which slice the page uses', () => {
  const html = provenancePanel(PANEL_PROMPTS);
  assert.match(html, /You, typing/);
  assert.match(html, /Control records/);
  assert.match(html, /Agent and teammate deliveries/);
  assert.match(html, /Tool-authored headless templates/);
  assert.match(html, /40%/, '100 human of 250 fingerprinted turns');
  assert.match(html, /Only the .*You, typing.* slice reaches any other figure/s,
    'the panel must say the rest of the page sits behind this slice');
  assert.match(html, /over-states rather than under-states/,
    'and that the classification errs in one direction by design');
});

test('a provenance tag the corpus never produced still renders, at zero', () => {
  const html = provenancePanel({
    ...PANEL_PROMPTS,
    patterns: { ...PANEL_PROMPTS.patterns, provenance: { human: 10, control: 0, agent: 0, adapter: 0 } },
  });
  assert.match(html, /Control records/, 'dropping an empty row turns "you have none" into "we did not look"');
});

test('how-you-steer splits only what the fingerprint layer measured, with a non-negative residue', () => {
  const html = steerPanel(PANEL_PROMPTS);
  assert.match(html, /Questions/);
  assert.match(html, /Supervision taps/);
  // 100 typed, 30% questions = 30, 20 taps → 50 residue, and the bars rank.
  assert.match(html, /Statements and instructions \(at least\)<\/span>.*?50 · 50%/s);
  // Final review P4-M3: that 50 is a FLOOR. Both counts are subtracted in
  // full, so every prompt that is BOTH a question and a tap is removed twice
  // — and the panel now says so rather than presenting the floor as the split.
  assert.match(html, /both counts are subtracted in full/,
    'the overlap caveat must render beside the figure it qualifies');
  assert.match(html, /do not sum to 100%/);
  const overlap = steerPanel({
    ...PANEL_PROMPTS, taps: 90,
    byHost: { claude: { typed: 100, questionShare: 0.9 } },
  });
  assert.doesNotMatch(overlap, /-\d/, 'a question that is also a tap must not produce a negative residue');
});

test('tap lengths render as a distribution, because no text exists at this layer', () => {
  const html = tapLengthPanel(PANEL_PROMPTS);
  assert.match(html, /1 token</, 'singular for a one-token tap');
  assert.match(html, /3 tokens</);
  assert.match(html, /12 · 9 sess/, 'each length carries its prompt and session counts');
  const none = tapLengthPanel({ ...PANEL_PROMPTS, patterns: { ...PANEL_PROMPTS.patterns, tapLengths: [] } });
  assert.match(none, /no supervision taps in this window/);
});

// A day the host did not type on is a BREAK in the trend, not a zero and not a
// carried-forward neighbour: sparklineSvg renders a non-finite entry as a gap,
// and this is the function that has to produce one.
test('the per-host tap series gaps a day that host did not type on', () => {
  const series = hostTapSeries(PANEL_PROMPTS.statsByDay, 'claude');
  assert.equal(series.length, 3, 'one slot per day in the window, in order');
  assert.equal(series[0], 0.2, '2026-08-18: 2 taps over 10 typed');
  assert.equal(series[1], null, '2026-08-19 is codex-only, so claude has no share that day');
  assert.equal(series[2], 0.125, '2026-08-20: 1 tap over 8 typed');
});

test('host interplay names both hosts and reads the asymmetry in plain language', () => {
  const html = hostInterplay(PANEL_PROMPTS);
  assert.match(html, /codex/);
  assert.match(html, /claude/);
  assert.match(html, /7<\/b> prompts open by assigning a role/, 'the persona count is a Codex-side fact here');
  // The opaque "windows are unequal" caveat is REPLACED by a plain read of the
  // data (§2); the unequal-histories nuance moves to the panel's `?` tooltip.
  assert.doesNotMatch(html, /Windows are not equal/, 'the opaque caveat is gone from the panel body');
  assert.match(html, /class="pr-host-read"/, 'the panel now carries a plain-language read');
  assert.match(html, /tap <b>codex<\/b> more often than <b>claude<\/b> \(35% vs 10%\)/,
    'codex is tapped more than claude, with both shares stated');
  assert.match(html, /write <b>codex<\/b> longer \(p90 160 vs 80 tokens\)/,
    'and codex runs the longer prompts, with both p90s stated');
});

test('the host read states only a comparison both sides carry, and nothing on a tie or a lone host', () => {
  // A share tie and a single p90 present → no tap clause, only the length one.
  const tie = hostInterplay({
    ...PANEL_PROMPTS,
    byHost: {
      claude: { typed: 60, tapShare: 0.2, p90TypedTokens: 80, personaOpeners: 0 },
      codex: { typed: 40, tapShare: 0.2, p90TypedTokens: 160, personaOpeners: 0 },
    },
  });
  assert.doesNotMatch(tie, /more often/, 'equal tap shares are not a comparison to draw');
  assert.match(tie, /write <b>codex<\/b> longer/, 'but the length difference still reads');
  // No asymmetry at all → no read line rather than an empty one.
  const flat = hostInterplay({
    ...PANEL_PROMPTS,
    byHost: {
      claude: { typed: 60, tapShare: 0.2, p90TypedTokens: 100, personaOpeners: 0 },
      codex: { typed: 40, tapShare: 0.2, p90TypedTokens: 100, personaOpeners: 0 },
    },
  });
  assert.doesNotMatch(flat, /class="pr-host-read"/, 'no asymmetry means no read, not a blank one');
});

// ── the Coaching panel: filters + sortable table (spec §2) ──────────────────
//
// The recurring-patterns table IS the coaching surface now: five columns, kind
// filter pills, and sortable headers, with each row expanding to its coaching
// panel (the expand half is exercised separately, below). These pin the
// collapsed table on the pure builder's output, `coachingPanel(prompts, state)`.

test('the coaching table draws exactly the five spec columns, and none of the retired ones', () => {
  const html = coachingPanel(PANEL_PROMPTS, {});
  const heads = [...html.matchAll(/data-pr-sort="\w+"[^>]*>([^<]*)<span/g)].map((m) => m[1].trim());
  assert.deepEqual(heads, ['Pattern', 'Times typed', 'Sessions', 'Days seen', 'Hosts'],
    'the header is Pattern · Times typed · Sessions · Days seen · Hosts, in order');
  assert.doesNotMatch(html, />Suggested move<|>Open<\/th>/, 'the Suggested-move and Open columns are gone');
  assert.doesNotMatch(html, /pr-src|pr-move|pr-cat/, 'no source sublabel, no move chip, no class chip on a row');
});

test('the coaching table shows a pattern name and its host chips per row', () => {
  const html = coachingPanel(PANEL_PROMPTS, {});
  assert.match(html, /Commit-and-push instruction/, 'a seeded cluster shows its curated name');
  assert.match(html, /<span class="pr-hostchip">claude<\/span>/);
  assert.match(html, /data-pr-open="aaaa"/, 'the pattern name is the expand control, keyed by cluster key');
});

test('the re-ask insight leads the panel, and reads its immediate-repeat share', () => {
  const html = coachingPanel(PANEL_PROMPTS, {});
  assert.match(html, /class="pr-insight"/);
  assert.match(html, /7<\/b> re-asks/);
  assert.match(html, /3<\/b> sessions/);
  assert.match(html, /57%.*?very next turn/s, '4 of 7 pairs landed at gap 1');
  const none = coachingPanel({ ...PANEL_PROMPTS, patterns: { ...PANEL_PROMPTS.patterns, reAsks: { pairCount: 0, sessionCount: 0, gapHist: {} } } }, {});
  assert.match(none, /Every pattern below is one you typed more than once/,
    'no re-ask reads as a neutral prompt to explore, not a fabricated zero');
});

// ── kind filter pills ───────────────────────────────────────────────────────

test('the filter pills list All plus one pill per kind PRESENT, each with its count', () => {
  const html = coachingPanel(PANEL_PROMPTS, {});
  assert.match(html, /data-pr-filter="all"[^>]*>All <span class="fc mono">3</, 'All carries the full count');
  assert.match(html, /data-pr-filter="instruction"[^>]*><span class="sw k-instruction"><\/span>Instructions <span class="fc mono">1</);
  assert.match(html, /data-pr-filter="question"[^>]*>.*?Questions <span class="fc mono">1</s);
  assert.match(html, /data-pr-filter="reask"[^>]*>.*?Re-asks <span class="fc mono">1</s);
  assert.doesNotMatch(html, /data-pr-filter="persona"/, 'no pill for a kind that is not present');
  assert.doesNotMatch(html, /data-pr-filter="tap"/);
});

test('a filter slices the table to its kind, and stacks with the active sort', () => {
  const filtered = coachingPanel(PANEL_PROMPTS, { filter: 'question' });
  assert.deepEqual([...filtered.matchAll(/data-pr-row="(\w+)"/g)].map((m) => m[1]), ['bbbb'],
    'only the question-kind cluster survives the filter');
  assert.match(filtered, /class="fpill on" data-pr-filter="question"/, 'the active pill is marked');
  // The stack: filter to one kind, then sort within it — the sort must apply
  // AFTER the filter, and a higher-count row of another kind must not leak in.
  const manyClusters = [
    { key: 'i1', kind: 'instruction', label: { name: 'A instr', source: 'seed' }, class: 'other', count: 3, sessions: 2, days: 1, hosts: ['claude'], medianTokens: 8, sampleSessionIds: [] },
    { key: 'i2', kind: 'instruction', label: { name: 'B instr', source: 'seed' }, class: 'other', count: 9, sessions: 5, days: 3, hosts: ['claude'], medianTokens: 8, sampleSessionIds: [] },
    { key: 'q1', kind: 'question', label: { name: 'Q', source: 'seed' }, class: 'question', count: 20, sessions: 9, days: 6, hosts: ['claude'], medianTokens: 8, sampleSessionIds: [] },
  ];
  const many = { ...PANEL_PROMPTS, patterns: { ...PANEL_PROMPTS.patterns, clusters: manyClusters },
    coaching: { cards: keyCards(manyClusters), summary: null } };
  const stacked = coachingPanel(many, { filter: 'instruction', sort: { key: 'count', dir: 'desc' } });
  assert.deepEqual([...stacked.matchAll(/data-pr-row="(\w+)"/g)].map((m) => m[1]), ['i2', 'i1'],
    'only instruction rows, ordered by the active count-desc sort');
  assert.doesNotMatch(stacked, /data-pr-row="q1"/, 'the higher-count question row is filtered out, not floated to the top');
});

test('a filter that matches nothing names the empty state rather than drawing a blank grid', () => {
  const html = coachingPanel(PANEL_PROMPTS, { filter: 'persona' });
  assert.match(html, /no patterns of this kind in this window/);
  assert.doesNotMatch(html, /data-pr-row=/, 'no rows are drawn behind the empty message');
});

// ── sortable headers ────────────────────────────────────────────────────────

test('every header is a sort button with a title tooltip and an arrow indicator', () => {
  const html = coachingPanel(PANEL_PROMPTS, {});
  assert.match(html, /data-pr-sort="name"[^>]*title="The recurring prompt cluster\."/);
  assert.match(html, /data-pr-sort="count"[^>]*title="How many times this pattern was typed in the window\."/);
  assert.match(html, /data-pr-sort="sessions"[^>]*title="How many separate sessions/);
  assert.match(html, /data-pr-sort="days"[^>]*title="How many distinct days/);
  assert.match(html, /data-pr-sort="hosts"[^>]*title="Which agents you typed it to\."/);
  assert.match(html, /<span class="arw mono" aria-hidden="true">/, 'each header carries an arrow indicator');
});

test('the default sort is Times typed, descending, and marks the active column', () => {
  const html = coachingPanel(PANEL_PROMPTS, {});
  assert.deepEqual([...html.matchAll(/data-pr-row="(\w+)"/g)].map((m) => m[1]), ['aaaa', 'bbbb', 'cccc'],
    'counts 12 > 5 > 3, descending by default');
  assert.match(html, /aria-sort="descending"><button type="button" data-pr-sort="count"/,
    'the count header carries the descending aria-sort state');
});

test('a numeric sort ascending reverses the order; a name sort orders alphabetically', () => {
  const asc = coachingPanel(PANEL_PROMPTS, { sort: { key: 'count', dir: 'asc' } });
  assert.deepEqual([...asc.matchAll(/data-pr-row="(\w+)"/g)].map((m) => m[1]), ['cccc', 'bbbb', 'aaaa'],
    'ascending count is 3 < 5 < 12');
  assert.match(asc, /aria-sort="ascending"><button type="button" data-pr-sort="count"/);
  const byName = coachingPanel(PANEL_PROMPTS, { sort: { key: 'name', dir: 'asc' } });
  assert.deepEqual([...byName.matchAll(/data-pr-row="(\w+)"/g)].map((m) => m[1]), ['aaaa', 'bbbb', 'cccc'],
    'name sort is alphabetical: "Commit…" before "Recurring 44…" before "Recurring 9…"');
});

test('the Hosts column sorts by how many hosts a pattern spans', () => {
  const html = coachingPanel(PANEL_PROMPTS, { sort: { key: 'hosts', dir: 'desc' } });
  assert.equal([...html.matchAll(/data-pr-row="(\w+)"/g)].map((m) => m[1])[0], 'aaaa',
    'the two-host pattern sorts to the top on a hosts-desc sort');
});

// ── name honesty (kept from the retired table, re-pointed at the panel) ──────
//
// The Type column is gone, so the pattern NAME is the only place a class could
// be over-claimed — neutralising a machine-generated "Recurring N-token
// instruction" lead matters MORE now, not less.

test('a characterized name does not assert a class the rules never split (belt)', () => {
  const html = coachingPanel({
    ...PANEL_PROMPTS,
    patterns: {
      ...PANEL_PROMPTS.patterns,
      clusters: [
        { ...PANEL_PROMPTS.patterns.clusters[0], class: 'other', kind: 'instruction',
          label: { name: 'Recurring 3-token instruction · 9 sessions · both hosts', source: 'characterized' } },
        { ...PANEL_PROMPTS.patterns.clusters[1], class: 'question', kind: 'question',
          label: { name: 'Recurring 44-token question · 4 sessions · 1 host', source: 'characterized' } },
      ],
    },
  }, {});
  assert.match(html, />Recurring 3-token prompt</, 'the class noun is neutralised in the cell');
  assert.match(html, />Recurring 44-token prompt</);
  assert.doesNotMatch(html, />Recurring \d+-token (instruction|question)</, 'no class noun survives into a rendered name');
  assert.match(html, /title="Recurring 3-token prompt · 9 sessions · both hosts"/, 'the title is neutralised alongside the cell');
});

test('a curated name is never rewritten, whatever words it contains', () => {
  const html = coachingPanel({
    ...PANEL_PROMPTS,
    patterns: {
      ...PANEL_PROMPTS.patterns,
      clusters: [{ ...PANEL_PROMPTS.patterns.clusters[0],
        label: { name: 'Recurring 3-token instruction', source: 'curated' } }],
    },
  }, {});
  assert.match(html, />Recurring 3-token instruction</,
    'a person or an enrichment pass wrote this name; the render layer does not second-guess it');
  assert.match(html, /title="Recurring 3-token instruction"/);
});

test('a characterized descriptor is trimmed to its lead, a curated name is not', () => {
  const html = coachingPanel(PANEL_PROMPTS, {});
  assert.match(html, />Recurring 44-token prompt</, 'the redundant span tail is dropped from the cell');
  assert.match(html, /title="Recurring 44-token prompt · 4 sessions · 1 host"/, 'and kept as the tooltip');
  assert.match(html, />Commit-and-push instruction</, 'a curated/seeded name is shown whole');
});

test('a hostile cluster label cannot inject markup into a row', () => {
  const html = coachingPanel({
    ...PANEL_PROMPTS,
    patterns: {
      ...PANEL_PROMPTS.patterns,
      clusters: [{
        ...PANEL_PROMPTS.patterns.clusters[0],
        hosts: ['<img src=x onerror=alert(1)>'],
        label: { name: '<script>alert(1)</script>', source: 'curated' },
      }],
    },
  }, {});
  assert.doesNotMatch(html, /<script/, 'no script element survives the label');
  assert.doesNotMatch(html, /<img/, 'no img element survives a host chip');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'the label is escaped, not dropped');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'and so is the host chip');
});

// ── absent states ──────────────────────────────────────────────────────────
//
// Every panel has a branch for "this window measured nothing", and the copy in
// those branches is the whole point of the view: it is where a zero would
// otherwise be invented. The KPI strip's branch was pinned from the start;
// these are the rest, so the absent path is held to the same standard as the
// populated one.

/** The projection with one field emptied, so each absent branch is reached
 *  without disturbing the others. */
function withPatterns(over) {
  return { ...PANEL_PROMPTS, patterns: { ...PANEL_PROMPTS.patterns, ...over } };
}

test('zero clusters reads as a clean result, not a missing measurement', () => {
  const html = coachingPanel(withPatterns({ clusters: [] }), {});
  assert.match(html, /clean result, not a missing one/,
    'no repetition found is an ANSWER; a bare empty table reads as a failure to look');
  assert.doesNotMatch(html, /<table/, 'and no empty table shell is drawn around it');
});

test('a projection that was never computed says so, differently', () => {
  const html = coachingPanel({ ...PANEL_PROMPTS, patterns: null }, {});
  assert.match(html, /were not computed/);
  assert.doesNotMatch(html, /clean result/,
    '"not computed" and "none found" are different claims and must not share copy');
});

test('a single-host corpus draws no cross-host read', () => {
  const html = hostInterplay({ ...PANEL_PROMPTS, byHost: { claude: PANEL_PROMPTS.byHost.claude } });
  assert.match(html, /claude/);
  assert.doesNotMatch(html, /class="pr-host-read"/,
    'the read compares two hosts; with one host there is no comparison to draw');
});

test('no host at all is named as such, not drawn as an empty grid', () => {
  assert.match(hostInterplay({ ...PANEL_PROMPTS, byHost: {} }),
    /no host carried a typed prompt in this window/);
});

test('the KPI tap chips say when there is no per-host split to show', () => {
  const html = promptKpis({ ...PANEL_PROMPTS, byHost: {} });
  assert.match(html, /no per-host split/);
  assert.doesNotMatch(html, /your p75/, 'and compares against no baseline it does not have');
});

test('an absent provenance split is named, and an all-zero one is not divided by', () => {
  assert.match(provenancePanel(withPatterns({ provenance: null })), /no provenance split/);
  assert.match(provenancePanel(withPatterns({ provenance: { human: 0, control: 0, agent: 0, adapter: 0 } })),
    /no fingerprinted turns in this window/);
});

test('nothing typed leaves the steer split unclassified rather than zeroed', () => {
  const html = steerPanel(withPatterns({ corpus: { fingerprints: 40, typed: 0 } }));
  assert.match(html, /nothing typed in this window to classify/);
  assert.doesNotMatch(html, /0%/, 'a split of nothing is not a split into zeroes');
});

// ── the expanded coaching panel (§2.3–2.5, §4.5) ────────────────────────────
//
// Opening a pattern renders the accordion detail row: Seen in · What you typed ·
// Recommendation · Draft · Dismiss. The last three come from the coaching card
// this pattern joins to (§4.5); What-you-typed is filled from the samples cache
// the client owns, and never shows unmasked text or fetches in the hidden
// posture. These drive the pure builder with an `openKey` + a samples/dismissed
// state, the same object usage.mjs passes at runtime.

// A coaching card carrying the §4.5 association keys, joined to cluster `aaaa`.
function coachCardFx(over = {}) {
  return {
    id: 'commit-push-claude-md', clusterKey: 'aaaa', targetKind: null,
    title: 'Commit-and-push is retyped, not remembered', try: 'Add one line to CLAUDE.md.',
    finding: 'recurred 12 times across 8 sessions.', basis: '12 recurrences.',
    source: 'rule', status: 'proposed', stale: false,
    generatedAt: '2026-08-29T00:00:00.000Z', evidenceHash: 'a'.repeat(16),
    draft: { kind: 'claude-md-line', text: 'Commit and push once verified.' },
    ...over,
  };
}
const promptsWithCoaching = (cards) => ({ ...PANEL_PROMPTS, coaching: { cards, summary: null } });

test('expanding a pattern renders one accordion detail row, with Seen in and What you typed', () => {
  const open = coachingPanel(PANEL_PROMPTS, { openKey: 'aaaa' });
  assert.equal((open.match(/class="detail-row"/g) || []).length, 1, 'one open at a time');
  assert.match(open, /<td colspan="5"><div class="coach">/);
  assert.match(open, />seen in</);
  assert.match(open, />What you typed</);
  assert.doesNotMatch(coachingPanel(PANEL_PROMPTS, {}), /class="detail-row"/, 'a collapsed panel has no detail row');
});

test('Seen in links target the real transcript route AND carry the nav hook (§4.4)', () => {
  const html = coachingPanel(PANEL_PROMPTS, { openKey: 'aaaa' });
  // cluster aaaa carries sampleSessionIds ['s1','s2','s3']; the links resolve
  // through AKDashboardOpenTranscript (data-pr-session), not a bare hash.
  assert.match(html, /class="occ-link mono" href="#usage\/s1" data-pr-session="s1"/);
  assert.match(html, /data-pr-session="s2"/);
  assert.match(html, /\+6 more/, '9 sessions, 3 shown → +6 more');
});

test('Seen in shows session·date once the samples fetch resolves, formatted without a timezone shift', () => {
  const html = coachingPanel(PANEL_PROMPTS, {
    openKey: 'aaaa',
    samples: { aaaa: { state: 'ok', samples: ['yes'], occurrences: [
      { sessionId: 's1', day: '2026-07-24' }, { sessionId: 's2', day: '2026-07-23' }] } },
  });
  assert.match(html, /s\.s1 · Jul 24/);
  assert.match(html, /s\.s2 · Jul 23/);
});

test('the §4.5 join: clusterKey first, then targetKind, else the cluster is hidden (never force-fit)', () => {
  const byKey = coachingPanel(promptsWithCoaching([coachCardFx()]), { openKey: 'aaaa' });
  assert.match(byKey, /Add one line to CLAUDE\.md\./, 'a cluster-specific card supplies the recommendation');
  assert.match(byKey, /data-pr-row="aaaa"/, 'and its cluster is the advised row shown');

  const byKind = coachingPanel(promptsWithCoaching([
    coachCardFx({ id: 'reask-delta', clusterKey: null, targetKind: 'reask', try: 'State the acceptance criteria up front.' }),
  ]), { openKey: 'cccc' }); // cccc has kind 'reask'
  assert.match(byKind, /State the acceptance criteria up front\./, 'a kind-level card joins by targetKind');
  assert.match(byKind, /data-pr-row="cccc"/);

  // A card that matches no cluster leaves every cluster advice-less: under P15
  // the table hides them all and names the clean empty state, never a neutral
  // "no coaching" note behind a still-shown row.
  const none = coachingPanel(promptsWithCoaching([coachCardFx({ clusterKey: 'zzzz', targetKind: 'persona' })]), {});
  assert.doesNotMatch(none, /data-pr-row=/, 'a cluster with no matching card is hidden, not shown blank');
  assert.match(none, /no repeated pattern has coaching advice yet/);
  assert.doesNotMatch(none, /Add one line to CLAUDE\.md/, "another cluster's card is not shown here");
});

test('clusterKey outranks a competing targetKind match on the same row', () => {
  const html = coachingPanel(promptsWithCoaching([
    coachCardFx({ id: 'kind-card', clusterKey: null, targetKind: 'instruction', try: 'KIND ADVICE' }),
    coachCardFx({ id: 'key-card', clusterKey: 'aaaa', targetKind: null, try: 'KEY ADVICE' }),
  ]), { openKey: 'aaaa' }); // aaaa is kind 'instruction' AND has a clusterKey card
  assert.match(html, /KEY ADVICE/);
  assert.doesNotMatch(html, /KIND ADVICE/);
});

test('the recommendation is the action without a Try: prefix, with the finding as the why', () => {
  const html = coachingPanel(promptsWithCoaching([coachCardFx()]), { openKey: 'aaaa' });
  assert.match(html, /class="rec-title">Add one line to CLAUDE\.md\.</);
  assert.doesNotMatch(html, /Try:/, 'the old Try: prefix is gone');
  assert.match(html, /class="rec-why">recurred 12 times across 8 sessions\.</);
});

test('the draft renders in a <pre> with a copy button keyed by the OPEN CLUSTER, omitted when absent', () => {
  const html = coachingPanel(promptsWithCoaching([coachCardFx()]), { openKey: 'aaaa' });
  assert.match(html, /<pre class="draft-pre mono" id="pr-draft-aaaa">Commit and push once verified\.<\/pre>/);
  assert.match(html, /data-pr-copy="aaaa"/, 'keyed by the open cluster, not the card id (one card, many clusters)');
  const noDraft = coachingPanel(promptsWithCoaching([coachCardFx({ draft: undefined })]), { openKey: 'aaaa' });
  assert.doesNotMatch(noDraft, /draft-pre/);
});

test('Dismiss carries the card id + a HOVER explanation; the dismissed state flips to Undo', () => {
  const proposed = coachingPanel(promptsWithCoaching([coachCardFx()]), { openKey: 'aaaa' });
  assert.match(proposed, /data-pr-dismiss="commit-push-claude-md"/);
  assert.match(proposed, /class="dismiss-tip"/, 'the explanation is a hover tooltip, not standing text');
  assert.doesNotMatch(proposed, /coach-foot done/);

  const optimistic = coachingPanel(promptsWithCoaching([coachCardFx()]), { openKey: 'aaaa', dismissed: { 'commit-push-claude-md': true } });
  assert.match(optimistic, /class="coach-foot done"/, 'the optimistic client flag shows the dismissed state');
  assert.match(optimistic, /data-pr-undismiss="commit-push-claude-md"/);

  const persisted = coachingPanel(promptsWithCoaching([coachCardFx({ status: 'dismissed' })]), { openKey: 'aaaa' });
  assert.match(persisted, /class="coach-foot done"/, 'a persisted ledger dismissal shows it too');

  // F1: after a page-load-persisted dismissal, an Undo sets the client flag to
  // false; that EXPLICIT false must override the stale card.status so the row
  // re-renders un-dismissed live, without waiting for the next /api/usage load.
  const undone = coachingPanel(promptsWithCoaching([coachCardFx({ status: 'dismissed' })]),
    { openKey: 'aaaa', dismissed: { 'commit-push-claude-md': false } });
  assert.doesNotMatch(undone, /coach-foot done/, 'an explicit client un-dismiss overrides the persisted status');
  assert.match(undone, /data-pr-dismiss="commit-push-claude-md"/, 'the Dismiss control is back, live');
});

// ── P15: the table shows ONLY patterns that have advice ──────────────────────

test('P15: a cluster with no coaching card is hidden from the table, whatever its count', () => {
  const prompts = {
    ...PANEL_PROMPTS,
    patterns: { ...PANEL_PROMPTS.patterns, clusters: [
      PANEL_PROMPTS.patterns.clusters[0], // aaaa (instruction) — advised
      { key: 'noadv', kind: 'tap', label: { name: 'Bare tap', source: 'seed' }, class: 'other',
        count: 99, sessions: 40, days: 20, hosts: ['claude'], medianTokens: 1, sampleSessionIds: [] },
    ] },
    coaching: { cards: keyCards([PANEL_PROMPTS.patterns.clusters[0]]), summary: null },
  };
  const html = coachingPanel(prompts, {});
  assert.match(html, /data-pr-row="aaaa"/, 'the advised cluster is shown');
  assert.doesNotMatch(html, /data-pr-row="noadv"/, 'the advice-less cluster is hidden even at the highest count');
  assert.doesNotMatch(html, /data-pr-filter="tap"/, 'no pill for a kind with no advice-bearing pattern');
  assert.match(html, /data-pr-filter="all"[^>]*>All <span class="fc mono">1</, 'All counts only the advised set');
});

test('P15: no advice-bearing pattern names the clean empty state, not a blank grid', () => {
  const html = coachingPanel({ ...PANEL_PROMPTS, coaching: { cards: [], summary: null } }, {});
  assert.match(html, /no repeated pattern has coaching advice yet/, 'the named clean-result empty state');
  assert.doesNotMatch(html, /data-pr-row=/, 'no rows behind the message');
  assert.doesNotMatch(html, /class="pr-filters"/, 'and no pills when nothing is advised');
  assert.match(html, /class="pr-insight"/, 'the re-ask insight still leads, so the panel is never truly blank');
});

// ── QE F-1: a kind-level card names its window scope inside a cluster panel ───

test('QE F-1: a kind-level card labels its rationale window-scope; a clusterKey card does not', () => {
  // cccc (kind reask, count 3) joins a kind-level reask card whose finding is a
  // WINDOW aggregate; the panel must name that scope so "107 across 29 sessions"
  // is not read as this count-3 row's.
  const kindJoined = coachingPanel(promptsWithCoaching([
    coachCardFx({ id: 'reask-delta', clusterKey: null, targetKind: 'reask',
      try: 'State the acceptance criteria up front.', finding: '107 re-asks across 29 sessions.' }),
  ]), { openKey: 'cccc' });
  assert.match(kindJoined,
    /class="rec-scope">Across all re-ask patterns this window:<\/span> 107 re-asks across 29 sessions\./,
    'the kind-level finding is prefixed with its window-scope label');

  // A clusterKey card's numbers already are this cluster's, so no scope prefix.
  const keyJoined = coachingPanel(promptsWithCoaching([coachCardFx()]), { openKey: 'aaaa' });
  assert.match(keyJoined, /class="rec-why">recurred 12 times across 8 sessions\.</, 'the finding renders plainly');
  assert.doesNotMatch(keyJoined, /rec-scope/, 'a cluster-specific card gets no window-scope prefix');
});

// ── F-5: the sort is stable across ties ──────────────────────────────────────

test('F-5: equal-value rows keep a deterministic order across a re-sort (name tiebreak)', () => {
  const tied = [
    { key: 't-b', kind: 'instruction', label: { name: 'Bravo', source: 'seed' }, class: 'other', count: 5, sessions: 3, days: 2, hosts: ['claude'], medianTokens: 8, sampleSessionIds: [] },
    { key: 't-a', kind: 'instruction', label: { name: 'Alpha', source: 'seed' }, class: 'other', count: 5, sessions: 3, days: 2, hosts: ['claude'], medianTokens: 8, sampleSessionIds: [] },
  ];
  const prompts = { ...PANEL_PROMPTS, patterns: { ...PANEL_PROMPTS.patterns, clusters: tied },
    coaching: { cards: keyCards(tied), summary: null } };
  const rowsOf = (h) => [...h.matchAll(/data-pr-row="([\w-]+)"/g)].map((m) => m[1]);
  const desc = rowsOf(coachingPanel(prompts, { sort: { key: 'count', dir: 'desc' } }));
  const asc = rowsOf(coachingPanel(prompts, { sort: { key: 'count', dir: 'asc' } }));
  assert.deepEqual(desc, ['t-a', 't-b'], 'a count tie breaks on the name, Alpha before Bravo');
  assert.deepEqual(asc, ['t-a', 't-b'], 'and the tiebreak is direction-stable, so a re-sort never shuffles ties');
});

test('the card source chip is three-valued: rule / enriched / unknown (F-9, re-pointed at the expand panel)', () => {
  assert.match(coachingPanel(promptsWithCoaching([coachCardFx({ source: 'rule' })]), { openKey: 'aaaa' }), /class="pr-card-source" data-source="rule"/);
  assert.match(coachingPanel(promptsWithCoaching([coachCardFx({ source: 'enriched' })]), { openKey: 'aaaa' }), /data-source="enriched"/);
  assert.match(coachingPanel(promptsWithCoaching([coachCardFx({ source: undefined })]), { openKey: 'aaaa' }), /data-source="unknown"/);
});

test('What you typed shows masked samples when the fetch has resolved (shown posture)', () => {
  const html = coachingPanel(PANEL_PROMPTS, {
    openKey: 'aaaa', posture: 'shown',
    samples: { aaaa: { state: 'ok', samples: ['yes', 'yep'], occurrences: [] } },
  });
  assert.match(html, /class="verbatim">yes<\/div>/);
  assert.match(html, /class="verbatim">yep<\/div>/);
  assert.match(html, /secrets redacted server-side/);
});

test('What you typed shows loading, an honest empty, and an honest error from the samples cache', () => {
  const loading = coachingPanel(PANEL_PROMPTS, { openKey: 'aaaa', posture: 'shown', samples: { aaaa: { state: 'loading' } } });
  assert.match(loading, /loading your masked prompts/);
  const empty = coachingPanel(PANEL_PROMPTS, { openKey: 'aaaa', posture: 'shown', samples: { aaaa: { state: 'empty', occurrences: [] } } });
  assert.match(empty, /no readable sample survived masking/);
  const err = coachingPanel(PANEL_PROMPTS, { openKey: 'aaaa', posture: 'shown', samples: { aaaa: { state: 'error' } } });
  assert.match(err, /couldn&rsquo;t load this pattern&rsquo;s text/);
});

test('the hidden posture shows a terminal pointer and renders NO verbatim text, even with samples cached', () => {
  const html = coachingPanel(PANEL_PROMPTS, {
    openKey: 'aaaa', posture: 'hidden',
    samples: { aaaa: { state: 'ok', samples: ['yes'], occurrences: [] } },
  });
  assert.match(html, /Prompt text is hidden/);
  assert.match(html, /ak usage prompts --deep/);
  assert.doesNotMatch(html, /class="verbatim"/, 'the hidden posture never renders a sample, cached or not');
});

test('a masked sample is still escaped — the panel never emits raw markup from the endpoint', () => {
  const html = coachingPanel(PANEL_PROMPTS, {
    openKey: 'aaaa', posture: 'shown',
    samples: { aaaa: { state: 'ok', samples: ['<img src=x onerror=alert(1)>'], occurrences: [] } },
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('SEC-9: hostile coaching-card prose puts zero control or bidi codepoints in the expanded panel', () => {
  const html = coachingPanel(promptsWithCoaching([coachCardFx({
    title: DOM_HOSTILE, try: DOM_HOSTILE, finding: DOM_HOSTILE,
    draft: { kind: 'claude-md-line', text: DOM_HOSTILE },
  })]), { openKey: 'aaaa' });
  assert.match(html, /class="rec-title"/, 'guard: the card block rendered, so this is not a vacuous pass');
  const hit = html.match(DOM_FORBIDDEN);
  assert.equal(hit, null, `rendered HTML carries U+${hit ? hit[0].charCodeAt(0).toString(16).padStart(4, '0') : ''}`);
});


// Structural by necessity: these assert what the SERVED DOCUMENT contains, so
// there is no behaviour to exercise instead — the panels cannot render into
// containers the page never shipped, and the tab cannot route to a panel with
// no ARIA relationship to it.
test('the served page ships the Prompts rail entry and its panel containers', () => {
  assert.match(PAGE, /id="usage-tab-prompts"[^>]*data-view="prompts"[^>]*aria-controls="v-prompts"/,
    'the rail button must point at the view it opens');
  assert.match(PAGE, /id="v-prompts"[^>]*role="tabpanel"[^>]*aria-labelledby="usage-tab-prompts"/,
    'and the view must point back, or the tab relationship is one-way');
  for (const id of ['u-pr-kpis', 'u-pr-provenance', 'u-pr-steer', 'u-pr-taps',
    'u-pr-hosts', 'u-pr-coaching']) {
    assert.match(PAGE, new RegExp(`id="${id}"`), `panel container ${id} is missing from the served page`);
  }
  // The retired containers (the taxonomy box and the split re-asks/patterns
  // tables) are gone — the Coaching panel absorbed them (§2).
  for (const id of ['u-pr-taxonomy', 'u-pr-reasks', 'u-pr-patterns']) {
    assert.doesNotMatch(PAGE, new RegExp(`id="${id}"`), `retired container ${id} still ships`);
  }
  // Rail placement, spec §3: between Findings and Sessions.
  const order = [...PAGE.matchAll(/data-view="(\w+)"/g)].map((m) => m[1]);
  assert.ok(order.indexOf('prompts') > order.indexOf('findings')
    && order.indexOf('prompts') < order.indexOf('sessions'),
  `Prompts must sit between Findings and Sessions, order was ${JSON.stringify(order)}`);
});

test('the served page ships the prompt-text posture toggle, and its note no longer over-promises', () => {
  assert.match(PAGE, /id="u-pr-posture"[^>]*role="group"/, 'the shown/hidden toggle ships in the Prompts view');
  assert.match(PAGE, /data-pr-posture="shown"[^>]*aria-pressed="true"/, 'default is shown');
  assert.match(PAGE, /data-pr-posture="hidden"[^>]*aria-pressed="false"/);
  assert.match(JS, /pt-posture/, 'the client persists the posture to localStorage');
  // §5: prompt text now DOES reach the page (masked) — the note must not claim
  // otherwise, or it lies about the very thing the Coaching panel does.
  assert.doesNotMatch(PAGE, /No prompt text is stored in the index or sent to this page/,
    'the stale "nothing sent to this page" promise is gone now that masked exemplars are fetched');
  assert.match(PAGE, /masked, with secrets\s+redacted server-side/,
    'the note states the new masked-on-demand reality instead');
});

test('the whole-history chip ships hidden, for the one view that needs it', () => {
  assert.match(PAGE, /id="usage-days-all"[^>]*data-days="365"[^>]*hidden/,
    'All-history starts hidden and is revealed by setUsageView, so other views keep the 7/14/30 row');
  assert.match(JS, /usage-days-all/, 'and the client actually toggles it');
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

// ── SEC-9: control and bidi characters never reach the DOM ─────────────────
// The security review's LOW finding, and the DOM half of SEC-2's HIGH. `esc`
// replaced only [&<>"'], so a 24-character label carrying U+202E and a raw ESC
// cleared `isValidLabelName` and rendered six control/bidi codepoints into the
// page — one of them INSIDE a title= attribute, where U+202E reverses the rest
// of the cell and a row reads as a different label than the one it is.
//
// This drives the render functions DIRECTLY with hostile values rather than
// through the store, on purpose: the store gate is the primary fix, and this
// boundary must hold without depending on it.

const DOM_FORBIDDEN = new RegExp(`[${[
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069],
].map(([lo, hi]) => `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`).join('')}]`);

const DOM_HOSTILE = `RLO${String.fromCharCode(0x202e)}drowssap `
  + `${String.fromCharCode(0x1b)}[31mESC${String.fromCharCode(0x07)}`
  + `${String.fromCharCode(0x1b)}]52;c;cm0gLXJmIH4=${String.fromCharCode(0x07)}`
  + `${String.fromCharCode(0x00)}${String.fromCharCode(0x9b)}${String.fromCharCode(0x200b)}`;

test('SEC-9: a hostile cluster label puts zero control or bidi codepoints in the coaching table (text OR title attribute)', () => {
  const html = coachingPanel({
    ...PANEL_PROMPTS,
    patterns: {
      ...PANEL_PROMPTS.patterns,
      clusters: [{
        ...PANEL_PROMPTS.patterns.clusters[0],
        label: { name: DOM_HOSTILE, source: 'enriched', descriptor: DOM_HOSTILE },
      }],
    },
  }, {});
  assert.match(html, /<table class="pr-coach"/, 'guard: the table actually rendered, so this is not a vacuous pass');
  const hit = html.match(DOM_FORBIDDEN);
  assert.equal(hit, null,
    `rendered HTML carries U+${hit ? hit[0].charCodeAt(0).toString(16).padStart(4, '0') : ''}`);
  assert.ok(html.includes('drowssap'),
    'the LETTERS are ordinary text and stay; it is the U+202E that reversed the cell that must not');
});

test('SEC-9: esc still escapes the five HTML metacharacters it always did', () => {
  const html = coachingPanel({
    ...PANEL_PROMPTS,
    patterns: {
      ...PANEL_PROMPTS.patterns,
      clusters: [{
        ...PANEL_PROMPTS.patterns.clusters[0],
        label: { name: '<img src=x onerror=alert(1)> & "q" \'s\'', source: 'curated' },
      }],
    },
  }, {});
  assert.ok(!html.includes('<img src=x'), 'the tag must not survive as markup');
  assert.ok(html.includes('&lt;img src=x'), 'it survives as escaped text, as before');
  assert.ok(html.includes('&quot;') && html.includes('&#39;') && html.includes('&amp;'));
});

test('SEC-9: the escaper actually SHIPPED to the browser is the stripping one, not a stale copy', () => {
  // Three copies of `esc` exist by design: groups.mjs's (the real one,
  // injected into the bundle via esc.toString()), and byte-identical on-disk
  // copies in usage-rhythm.mjs / usage-prompts.mjs that exist so the
  // direct-import tests above have something to run. client.mjs strips those
  // two from the bundle. The tests above exercise the on-disk copies — so
  // without this, groups.mjs could lose the strip and every one of them would
  // stay green while the shipped page rendered raw control bytes.
  // The CONTROL characters go; the printable payload text stays, which is
  // exactly right — an OSC sequence without its introducer and terminator is
  // inert prose, and rewriting a reader's visible text would be its own lie.
  assert.equal(groupsEsc(`a${String.fromCharCode(0x1b)}]0;PWNED${String.fromCharCode(0x07)}b`),
    'a]0;PWNEDb', 'groups.mjs\'s esc — the source of the injected copy — must strip');
  assert.equal(groupsEsc(`x${String.fromCharCode(0x202e)}y`), 'xy');
  assert.equal(groupsEsc('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;', 'and still escape');
  assert.match(JS, /function esc\(s\) \{[\s\S]{0,600}?0x202e/,
    'the bundle\'s one esc must be the stripping implementation, not the five-character escaper');
});

// The card `source` chip (rule / enriched / unknown) now renders inside the
// EXPANDED coaching panel (§4.5), not a standalone card wall — its F-9
// coverage moves to the expand-commit tests appended below.

// ── QE review F-5 (MEDIUM): the dashboard's ledger-write contract ──────────
// Originally "the dashboard NEVER writes the ledger" — the review injected a
// real `saveLedger(ledgerPath, ledger)` into dashboardCoachingPayload and
// nothing failed, so the contract was pinned by keeping the writers out of
// scope entirely. ADR-0039 amendment 3 (Coaching redesign §4.3) relaxes that
// for ONE non-inference, non-sensitive local write: the dismiss endpoint. So
// `saveLedger` is now in scope — but ONLY on the dismiss write path, never in
// the READ path a /api/usage poll runs. The label-store writer and the raw
// atomic writer stay entirely out of this file (the store is CLI-only; the one
// sanctioned write goes through the ledger module's own saveLedger). A read-path
// regression here silently resurrects every CLI-dismissed card on the next poll,
// and is caught behaviorally by the poll test directly below.

test('F-5: the label-store/atomic writers never appear, and saveLedger only on the §4.3 dismiss path', async () => {
  const { fileURLToPath } = await import('node:url');
  const src = fs.readFileSync(
    fileURLToPath(new URL('../../src/lib/dashboard-server.mjs', import.meta.url)), 'utf8');
  // These two never belong in this file at all — unchanged from the original
  // read-only contract.
  for (const writer of ['saveLabelStore', 'writePrivateFileAtomic']) {
    const uses = src.split('\n')
      .map((line, i) => [i + 1, line.trim()])
      .filter(([, line]) => line.includes(writer) && !line.startsWith('//') && !line.startsWith('*'));
    assert.deepEqual(uses, [],
      `${writer} is referenced in dashboard-server.mjs outside a comment: ${JSON.stringify(uses)}`);
  }
  // saveLedger is permitted, but every non-comment reference must be a SANCTIONED
  // one: the import, or the write path's injectable-override default. Anything
  // else (e.g. a saveLedger call smuggled into dashboardCoachingPayload) fails.
  const saveLedgerLines = src.split('\n')
    .map((line, i) => [i + 1, line.trim()])
    .filter(([, line]) => line.includes('saveLedger') && !line.startsWith('//') && !line.startsWith('*'));
  const sanctioned = saveLedgerLines.filter(([, line]) =>
    line.startsWith('loadLedger, saveLedger,') // the import
    || line.includes('coachingLedger?.saveLedger ?? saveLedger')); // the write-path override default
  assert.deepEqual(saveLedgerLines, sanctioned,
    `saveLedger is used outside the sanctioned §4.3 dismiss path: ${
      JSON.stringify(saveLedgerLines.filter((l) => !sanctioned.includes(l)))}`);
  assert.ok(sanctioned.length >= 1, 'guard: the check is not vacuous — the dismiss path really binds saveLedger');
});

test('F-5: no number of /api/usage polls creates the ledger file the dashboard was pointed at', () => {
  // Behavioral half. `loadLedger` is overridden, so nothing reads from disk —
  // which means the ONLY thing that could bring this path into existence is a
  // write. Pointing it at a directory that does not exist makes the proof
  // unambiguous: `writePrivateFileAtomic` mkdirs recursively, so if any poll
  // wrote, the directory would be there.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dash-f5-'));
  const neverWritten = path.join(dir, 'never-written');
  const ledgerPath = path.join(neverWritten, 'usage-outcome-ledger.json');
  const dismissed = {
    version: 1,
    records: [{
      id: 'commit-push-claude-md', evidenceHash: 'a'.repeat(16), status: 'dismissed',
      generatedAt: '2026-08-01T00:00:00.000Z', statusAt: '2026-08-01T00:00:00.000Z',
      baseline: { count: 12, clusterKey: 'k', sessions: 8, days: 4 }, windowDays: 30, dismissCount: 1,
    }],
  };
  return (async () => {
    const calls = [];
    let loads = 0;
    const srv = await startDashboard({
      port: 0,
      fetchStatus: async () => ({ overall: 'ok', rows: [] }),
      usage: { readIndex: spyReadIndex(PROMPT_RECORDS, calls) },
      coachingLedger: {
        loadLedger: () => { loads++; return JSON.parse(JSON.stringify(dismissed)); },
        ledgerPath,
      },
      labelStore: NULL_LABEL_STORE,
    });
    try {
      for (let i = 0; i < 3; i++) {
        const r = await get(`${srv.url}api/usage?days=7`, srv.token);
        assert.equal(r.status, 200, `expected 200, got ${r.status}`);
        assert.equal(JSON.parse(r.body).prompts.coaching.summary.dismissed, 1,
          'guard: the poll really did reconcile against the injected ledger');
      }
    } finally {
      await srv.close();
    }
    assert.ok(loads >= 3, 'guard: the ledger was read on every poll, so the write path was reachable');
    assert.equal(fs.existsSync(neverWritten), false,
      'a poll wrote the ledger — every CLI dismissal would be resurrected on the next one');
    fs.rmSync(dir, { recursive: true, force: true });
  })();
});

// ── QE re-verification R-1: F-2's WIRING, pinned at the DASHBOARD call site ─
// Probe N7 flipped `canonicalBasis: days === CANONICAL_WINDOW_DAYS` to a bare
// `true` here and survived. This payload is read-only so it can never PERSIST
// an expiry — but both surfaces reconcile through one function precisely so
// they cannot disagree about a card's status, and a dashboard that renders
// "expired — evidence no longer present" over evidence that is entirely
// present is telling the operator something false.

test('R-1: a non-canonical dashboard poll does not report a proposed card as expired', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dash-r1-'));
  const ledgerPath = path.join(dir, 'usage-outcome-ledger.json');
  const proposedRecord = {
    version: 1,
    records: [{
      id: 'commit-push-claude-md', evidenceHash: 'a'.repeat(16), status: 'proposed',
      generatedAt: '2026-08-01T00:00:00.000Z', statusAt: '2026-08-01T00:00:00.000Z',
      baseline: { count: 12, clusterKey: 'k', sessions: 8, days: 4 }, windowDays: 30, dismissCount: 0,
    }],
  };
  const calls = [];
  const srv = await startDashboard({
    port: 0,
    fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    // PROMPT_RECORDS fires none of the six v1 rules, so NO card is derived on
    // any poll — which is the "card did not fire this pass" condition, and the
    // whole question is whether a NON-canonical poll may call that expiry.
    usage: { readIndex: spyReadIndex(PROMPT_RECORDS, calls) },
    coachingLedger: { loadLedger: () => JSON.parse(JSON.stringify(proposedRecord)), ledgerPath },
    labelStore: NULL_LABEL_STORE,
  });
  try {
    const narrow = await get(`${srv.url}api/usage?days=7`, srv.token);
    assert.equal(narrow.status, 200, `expected 200, got ${narrow.status}`);
    const summary = JSON.parse(narrow.body).prompts.coaching.summary;
    assert.equal(summary.expired, 0,
      'a 7-day view must not report a card expired on evidence it never looked at');
    assert.equal(summary.proposed, 1);
  } finally {
    await srv.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R-1: a CANONICAL dashboard poll still reports a genuinely unseen card as expired', async () => {
  // The other half: the fail-safe default must not disarm real expiry at the
  // one window where the ledger is entitled to draw that conclusion.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dash-r1b-'));
  const ledgerPath = path.join(dir, 'usage-outcome-ledger.json');
  const proposedRecord = {
    version: 1,
    records: [{
      id: 'commit-push-claude-md', evidenceHash: 'a'.repeat(16), status: 'proposed',
      generatedAt: '2026-08-01T00:00:00.000Z', statusAt: '2026-08-01T00:00:00.000Z',
      baseline: { count: 12, clusterKey: 'k', sessions: 8, days: 4 }, windowDays: 30, dismissCount: 0,
    }],
  };
  const calls = [];
  const srv = await startDashboard({
    port: 0,
    fetchStatus: async () => ({ overall: 'ok', rows: [] }),
    usage: { readIndex: spyReadIndex(PROMPT_RECORDS, calls) },
    coachingLedger: { loadLedger: () => JSON.parse(JSON.stringify(proposedRecord)), ledgerPath },
    labelStore: NULL_LABEL_STORE,
  });
  try {
    const canonical = await get(`${srv.url}api/usage?days=30`, srv.token);
    assert.equal(canonical.status, 200);
    assert.equal(JSON.parse(canonical.body).prompts.coaching.summary.expired, 1,
      'at the canonical window, a card that did not fire IS expired — the fix must not disarm that');
  } finally {
    await srv.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
