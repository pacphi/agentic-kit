#!/usr/bin/env node
//
// health-history.test.cjs — unit tests for the persisted health-history ring.
//
// The ring records one entry per `sync` convergence: learning-row count, native
// agentdb slot count, drift state, and security presence. detectRegression()
// compares the last two entries and surfaces backslides (learning shrank, slots
// dropped, drift regressed current→outdated, security present→absent) so `status`
// can alarm on them. These are PURE functions — no file I/O in the core — so the
// test exercises them directly. loadRing/appendToConfig are the thin cfg shims the
// integrator persists via saveKitConfig.
//
// Run: node tests/health-history.test.cjs   (exit 0 = pass, 1 = fail)

const path = require('path');
const {
  append, summarize, detectRegression, loadRing, appendToConfig,
} = require(path.resolve(__dirname, '..', 'src', 'lib', 'health-history.mjs'));

// ── harness ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  \x1b[32m✓\x1b[0m ' + name); passed++; }
  catch (e) { console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  assert(A === B, (msg || 'not equal') + `\n      got:      ${A}\n      expected: ${B}`);
}
const entry = (o = {}) => ({
  ts: 1000, learningRows: 10, nativeSlots: 5, driftOutdated: false, securityPresent: true, ...o,
});

// ── append: cap behavior + immutability ──────────────────────────────────────
console.log('append (ring cap + immutability)');

test('append returns a NEW array and does not mutate the input', () => {
  const ring = [entry({ ts: 1 })];
  const out = append(ring, entry({ ts: 2 }));
  assert(out !== ring, 'must return a new array reference');
  eq(ring.length, 1, 'input ring must be untouched');
  eq(out.length, 2, 'new ring has the appended entry');
  eq(out[1].ts, 2, 'appended entry is last');
});

test('append keeps insertion order (oldest first, newest last)', () => {
  let ring = [];
  for (let i = 1; i <= 4; i++) ring = append(ring, entry({ ts: i }));
  eq(ring.map((e) => e.ts), [1, 2, 3, 4]);
});

test('append drops the OLDEST once past the cap', () => {
  let ring = [];
  for (let i = 1; i <= 5; i++) ring = append(ring, entry({ ts: i }), 3);
  eq(ring.length, 3, 'ring capped at 3');
  eq(ring.map((e) => e.ts), [3, 4, 5], 'oldest dropped, newest kept');
});

test('append default cap is 30', () => {
  let ring = [];
  for (let i = 1; i <= 35; i++) ring = append(ring, entry({ ts: i }));
  eq(ring.length, 30, 'default cap 30');
  eq(ring[0].ts, 6, 'entries 1–5 dropped');
  eq(ring[29].ts, 35, 'newest retained');
});

test('append onto undefined/missing ring treats it as empty', () => {
  const out = append(undefined, entry({ ts: 7 }));
  eq(out.length, 1);
  eq(out[0].ts, 7);
});

// ── summarize ────────────────────────────────────────────────────────────────
console.log('\nsummarize');

test('summarize projects an entry to the tracked scalar fields', () => {
  const s = summarize({ ts: 9, learningRows: 3, nativeSlots: 2, driftOutdated: true, securityPresent: false, junk: 'x' });
  eq(s.learningRows, 3);
  eq(s.nativeSlots, 2);
  eq(s.driftOutdated, true);
  eq(s.securityPresent, false);
  assert(!('junk' in s), 'summarize drops untracked fields');
});

// ── detectRegression: every branch ───────────────────────────────────────────
console.log('\ndetectRegression (every branch)');

test('no regression when nothing worsened', () => {
  const ring = [entry({ ts: 1 }), entry({ ts: 2 })];
  eq(detectRegression(ring), []);
});

test('no regression when metrics IMPROVE', () => {
  const ring = [
    entry({ learningRows: 5, nativeSlots: 2, driftOutdated: true, securityPresent: false }),
    entry({ learningRows: 9, nativeSlots: 6, driftOutdated: false, securityPresent: true }),
  ];
  eq(detectRegression(ring), []);
});

test('learningRows shrank → one regression', () => {
  const ring = [entry({ learningRows: 20 }), entry({ learningRows: 12 })];
  const r = detectRegression(ring);
  eq(r.length, 1);
  eq(r[0].metric, 'learningRows');
  eq(r[0].from, 20);
  eq(r[0].to, 12);
  assert(/learning/i.test(r[0].message), 'message mentions learning: ' + r[0].message);
});

test('native agentdb slot count dropped → one regression', () => {
  const ring = [entry({ nativeSlots: 8 }), entry({ nativeSlots: 3 })];
  const r = detectRegression(ring);
  eq(r.length, 1);
  eq(r[0].metric, 'nativeSlots');
  eq(r[0].from, 8);
  eq(r[0].to, 3);
});

test('drift current→outdated → one regression', () => {
  const ring = [entry({ driftOutdated: false }), entry({ driftOutdated: true })];
  const r = detectRegression(ring);
  eq(r.length, 1);
  eq(r[0].metric, 'drift');
  eq(r[0].from, false);
  eq(r[0].to, true);
  assert(/outdated/i.test(r[0].message), 'message mentions outdated: ' + r[0].message);
});

test('drift outdated→current is NOT a regression (recovery)', () => {
  const ring = [entry({ driftOutdated: true }), entry({ driftOutdated: false })];
  eq(detectRegression(ring), []);
});

test('security present→absent → one regression', () => {
  const ring = [entry({ securityPresent: true }), entry({ securityPresent: false })];
  const r = detectRegression(ring);
  eq(r.length, 1);
  eq(r[0].metric, 'security');
  eq(r[0].from, true);
  eq(r[0].to, false);
  assert(/security/i.test(r[0].message), 'message mentions security: ' + r[0].message);
});

test('security absent→present is NOT a regression (recovery)', () => {
  const ring = [entry({ securityPresent: false }), entry({ securityPresent: true })];
  eq(detectRegression(ring), []);
});

test('multiple simultaneous regressions all surface', () => {
  const ring = [
    entry({ learningRows: 30, nativeSlots: 9, driftOutdated: false, securityPresent: true }),
    entry({ learningRows: 10, nativeSlots: 4, driftOutdated: true, securityPresent: false }),
  ];
  const r = detectRegression(ring);
  eq(r.length, 4, 'all four backslides detected');
});

test('multiple regressions cover each metric exactly once', () => {
  const ring = [
    entry({ learningRows: 30, nativeSlots: 9, driftOutdated: false, securityPresent: true }),
    entry({ learningRows: 10, nativeSlots: 4, driftOutdated: true, securityPresent: false }),
  ];
  const metrics = detectRegression(ring).map((x) => x.metric).sort();
  eq(metrics, ['drift', 'learningRows', 'nativeSlots', 'security']);
});

test('fewer than two entries → no regression (nothing to compare)', () => {
  eq(detectRegression([]), []);
  eq(detectRegression([entry()]), []);
  eq(detectRegression(undefined), []);
});

test('only the LAST two entries are compared', () => {
  const ring = [
    entry({ ts: 1, learningRows: 100 }), // ancient, ignored
    entry({ ts: 2, learningRows: 5 }),
    entry({ ts: 3, learningRows: 6 }),   // grew vs prev → no regression
  ];
  eq(detectRegression(ring), []);
});

test('missing numeric fields are treated as 0 (no spurious regression, no crash)', () => {
  const ring = [{ ts: 1 }, { ts: 2 }];
  eq(detectRegression(ring), []);
});

// ── loadRing / appendToConfig (thin cfg shims) ───────────────────────────────
console.log('\nloadRing / appendToConfig');

test('loadRing returns [] when cfg has no health', () => {
  eq(loadRing({}), []);
  eq(loadRing({ health: {} }), []);
  eq(loadRing(undefined), []);
});

test('loadRing returns the stored ring', () => {
  const ring = [entry({ ts: 1 })];
  eq(loadRing({ health: { ring } }), ring);
});

test('appendToConfig seeds cfg.health.ring and returns the cfg', () => {
  const cfg = {};
  const out = appendToConfig(cfg, entry({ ts: 1 }));
  assert(out === cfg, 'returns the same cfg object for chaining');
  eq(cfg.health.ring.length, 1);
  eq(cfg.health.ring[0].ts, 1);
});

test('appendToConfig appends onto an existing ring and respects the cap', () => {
  const cfg = { health: { ring: [] } };
  for (let i = 1; i <= 35; i++) appendToConfig(cfg, entry({ ts: i }));
  eq(cfg.health.ring.length, 30);
  eq(cfg.health.ring[0].ts, 6);
});

test('appendToConfig preserves other cfg.health keys', () => {
  const cfg = { health: { ring: [], somethingElse: 'keep' } };
  appendToConfig(cfg, entry({ ts: 1 }));
  eq(cfg.health.somethingElse, 'keep');
});

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
