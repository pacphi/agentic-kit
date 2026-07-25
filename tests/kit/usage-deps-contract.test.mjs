import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, _resetForTest } from '../../src/lib/usage-index.mjs';
import { costOf, priceFor, PRICES_AS_OF } from '../../src/lib/pricing.mjs';
import { classify } from '../../src/lib/usage-classify.mjs';
import { detectInsights } from '../../src/lib/usage-insights.mjs';

// ADR-0009 follow-up decision 4 — the `deps` seam, executed for real.
//
// Every other usage-index test injects doubles, and every pricing/classify/
// insights test calls its module directly. Nobody has run BOTH sides of the seam
// at once, so "two sides agreed on a shape neither executed" is the actual state
// of the code — the same condition that shipped `[object Object]` category chips.
//
// This is a CONTRACT test. It asserts the shapes the production renderers
// depend on, at the boundary. It deliberately asserts NO analytic values and NO
// category names: those belong to usage-classify.test.mjs / pricing.test.mjs /
// usage-insights.test.mjs, and duplicating them here would make this a
// change-detector on the very modules it exists to keep honest.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'usage');

// The fixtures carry literal 2026-07-24 timestamps; pin `now` one day later or
// the window silently empties as the corpus ages.
const NOW = Date.parse('2026-07-25T12:00:00.000Z');

/** Severities `renderFindings` knows how to style (usage-insights.mjs:197). */
const SEVERITIES = new Set(['warn', 'info', 'ok']);

/**
 * Copy the fixture corpus, then thicken it until the $-computing detectors have
 * something to compute. The shipped fixtures are three sessions worth $0.015 —
 * enough to exercise `classify` and `costOf`, but every finding they produce is
 * $-free, which would leave the `impact` contract's number branch untested.
 */
function corpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-deps-'));
  fs.cpSync(FIXTURES, path.join(dir, 'corpus'), { recursive: true });
  const proj = path.join(dir, 'corpus', 'claude', '-Users-me-proj');

  // Sessions shaped like real ones: a large startup cache write, a little work,
  // then done. Titles vary so the classifier sees real signal on some and none
  // on others, and both outcomes reach the seam.
  const titles = [
    'Fix the failing login test', 'Refactor the payment module', 'asdf',
    'Review the release notes', 'zzz', 'Add a migration for the orders table',
  ];
  titles.forEach((title, i) => {
    const day = 20 + (i % 5); // spread across the window so byDay/trend see motion
    const hh = String(2 + (i % 3)).padStart(2, '0');
    fs.writeFileSync(path.join(proj, `synth${i}.jsonl`), [
      JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: `synth${i}` }),
      JSON.stringify({
        type: 'user', sessionId: `synth${i}`, cwd: '/Users/me/proj',
        timestamp: `2026-07-${day}T${hh}:00:00.000Z`,
        message: { role: 'user', content: [{ type: 'text', text: title }] },
      }),
      JSON.stringify({
        type: 'assistant', sessionId: `synth${i}`, cwd: '/Users/me/proj',
        timestamp: `2026-07-${day}T${hh}:04:00.000Z`,
        message: {
          role: 'assistant', model: i % 2 ? 'claude-sonnet-5' : 'claude-opus-5',
          usage: {
            input_tokens: 2_000, output_tokens: 1_500,
            cache_read_input_tokens: 400_000, cache_creation_input_tokens: 120_000,
          },
          content: [{ type: 'text', text: 'done' }, { type: 'tool_use', name: 'Edit', input: {} }],
        },
      }),
    ].join('\n') + '\n');
  });

  return {
    dir,
    roots: {
      claude: path.join(dir, 'corpus', 'claude'),
      codex: path.join(dir, 'corpus', 'codex'),
    },
    cachePath: path.join(dir, 'cache', 'usage-index.json'),
  };
}

/**
 * The REAL modules, wired exactly as `loadDeps` wires them
 * (usage-index.mjs:604-617), with every call and return recorded. Recording at
 * the seam — rather than calling the modules directly — is the whole point:
 * what matters is the shape that actually crosses the boundary.
 */
function realDeps(log) {
  return {
    costOf: (usage) => { const out = costOf(usage); log.cost.push({ usage, out }); return out; },
    pricesAsOf: PRICES_AS_OF,
    classify: (session) => { const out = classify(session); log.classify.push({ session, out }); return out; },
    detectInsights: (agg) => { const out = detectInsights(agg); log.insights.push(out); return out; },
  };
}

/**
 * Build the aggregate once per test run, through the real seam.
 *
 * ⚠ This memo is only sound because `node --test` runs the tests within a file
 * SEQUENTIALLY by default, which is what the repo's `test` script relies on.
 * Adding `{ concurrency: true }` to this file would let two tests race into the
 * unguarded `if (_built)` and build twice — and the `_resetForTest()` below
 * would then clear module state out from under an in-flight build. If this file
 * ever needs concurrency, memoise the PROMISE rather than the result.
 */
let _built = null;
async function seam() {
  if (_built) return _built;
  const log = { cost: [], classify: [], insights: [] };
  const sb = corpus();
  _resetForTest();
  const agg = await buildIndex({
    days: 14, now: NOW, roots: sb.roots, cachePath: sb.cachePath, deps: realDeps(log),
  });
  _built = { agg, log };
  return _built;
}

// ── classify(): `basis` is a string primitive ───────────────────────────────

test('classify returns {category, confidence, basis} for every session at the seam', async () => {
  const { log } = await seam();
  assert.ok(log.classify.length >= 4, 'the corpus must actually exercise the classifier');

  for (const { out } of log.classify) {
    assert.equal(typeof out, 'object');
    assert.notEqual(out, null);
    assert.equal(typeof out.category, 'string', 'category must be a string primitive');
    assert.ok(out.category.length > 0, 'an empty category is not a classification');
    assert.equal(typeof out.confidence, 'number');
    assert.ok(Number.isFinite(out.confidence), 'confidence must be a real number');
    assert.ok(out.confidence >= 0 && out.confidence <= 1, `confidence out of range: ${out.confidence}`);
  }
});

test('classify basis is a STRING PRIMITIVE, never an object that stringifies', async () => {
  // Load-bearing. The row expander writes `basis` straight into the DOM through
  // esc(). An object there renders "[object Object]" — verbatim the bug the
  // project-tree category chips already shipped once. `assert.ok(basis)` would
  // pass on an object; only a typeof check catches it.
  const { log } = await seam();
  for (const { out } of log.classify) {
    assert.equal(typeof out.basis, 'string', `basis must be a string, got ${JSON.stringify(out.basis)}`);
    assert.ok(out.basis.length > 0, 'an empty basis justifies nothing');
    assert.notEqual(String(out.basis), '[object Object]');
  }
});

test('the basis that lands on the wire is still a string after aggregation', async () => {
  // The seam is only half the journey: the value the browser receives is
  // `session.basis` on the aggregate, and that is what the expander renders.
  const { agg } = await seam();
  assert.ok(agg.sessions.length > 0);
  for (const s of agg.sessions) {
    assert.equal(typeof s.basis, 'string', `session ${s.id} basis is not a string`);
    assert.equal(typeof s.category, 'string');
    assert.equal(typeof s.confidence, 'number');
  }
});

// ── costOf(): finite, non-negative, for every id the corpus emits ────────────

test('costOf returns a finite non-negative number for every call at the seam', async () => {
  const { log } = await seam();
  assert.ok(log.cost.length > 0, 'the corpus must actually exercise pricing');

  for (const { usage, out } of log.cost) {
    assert.equal(typeof out, 'number', `costOf(${usage?.model}) returned ${typeof out}`);
    assert.ok(Number.isFinite(out), `costOf(${usage?.model}) returned ${out}`);
    assert.ok(out >= 0, `costOf(${usage?.model}) returned a negative cost: ${out}`);
  }
});

test('a model absent from the rate table is still priced, not zeroed or NaN', async () => {
  // The fixture corpus emits `gpt-5.6`, which the table carries only as
  // `gpt-5.6-sol` / `-terra` / `-luna` — so the bare id falls to FALLBACK_PRICE.
  // Asserted as a PROPERTY of the corpus, not as a literal id, so this keeps
  // meaning if the fixtures change: what must hold is that the unmatched branch
  // is exercised at all.
  const { agg, log } = await seam();
  const models = [...new Set(agg.sessions.flatMap((s) => s.models))];
  const unmatched = models.filter((m) => priceFor(m).matched === false);
  assert.ok(unmatched.length >= 1,
    `the corpus must emit at least one model absent from the rate table; saw ${models.join(', ')}`);

  const calls = log.cost.filter((c) => unmatched.includes(c.usage?.model));
  assert.ok(calls.length >= 1, 'the unmatched model must have reached costOf');
  for (const { usage, out } of calls) {
    assert.ok(Number.isFinite(out), `unmatched ${usage.model} priced as ${out}`);
    assert.ok(out >= 0);
  }
});

test('every session cost on the aggregate is a finite non-negative number', async () => {
  const { agg } = await seam();
  for (const s of agg.sessions) {
    assert.ok(Number.isFinite(s.cost), `session ${s.id} cost is ${s.cost}`);
    assert.ok(s.cost >= 0);
  }
  assert.ok(Number.isFinite(agg.totals.cost), `totals.cost is ${agg.totals.cost}`);
  assert.ok(agg.totals.cost >= 0);
});

test('pricesAsOf crosses the seam under the name the aggregate publishes', async () => {
  // `loadDeps` maps pricing's PRICES_AS_OF onto a deps key spelled `pricesAsOf`.
  // A rename on either side would leave the panel showing "prices as of null"
  // with nothing failing.
  const { agg } = await seam();
  assert.equal(agg.pricesAsOf, PRICES_AS_OF);
  assert.equal(typeof agg.pricesAsOf, 'string');
});

// ── detectInsights(): the shapes renderFindings branches on ─────────────────

test('every finding carries string title, finding and action', async () => {
  const { agg } = await seam();
  assert.ok(Array.isArray(agg.insights));
  assert.ok(agg.insights.length >= 1, 'the corpus must actually produce findings');

  for (const f of agg.insights) {
    for (const key of ['title', 'finding', 'action']) {
      assert.equal(typeof f[key], 'string', `${f.id}.${key} is ${typeof f[key]}, not a string`);
      assert.ok(f[key].length > 0, `${f.id}.${key} is empty`);
    }
    assert.equal(typeof f.id, 'string');
  }
});

test('every finding severity is one renderFindings knows how to style', async () => {
  const { agg } = await seam();
  for (const f of agg.insights) {
    assert.ok(SEVERITIES.has(f.severity),
      `${f.id} severity ${JSON.stringify(f.severity)} is outside {${[...SEVERITIES].join(', ')}}`);
  }
});

test('a finding impact is a finite number or null — never NaN, string, or undefined', async () => {
  // `null` is this module's EXPLICIT encoding of "no $ claimed" — it IS the
  // ADR §6 guarantee, not a defect. usage-insights.mjs:211 defaults every
  // finding to `impact: null` via `push`, the JSDoc at :199 declares
  // `impact:number|null`, and tests/kit/usage-insights.test.mjs:79 asserts
  // `impact === null` for every non-computable detector as an invariant.
  // renderFindings branches on `typeof f.impact === "number"`
  // (dashboard-server.mjs:1941), and null fails that check, so it lands on the
  // "no $ claimed" path correctly.
  //
  // The negative half is what earns this test its place. NaN and Infinity PASS
  // the typeof check and would render "~$NaN/window" — the fabricated dollar
  // claim §6 exists to forbid. A numeric STRING fails it and silently
  // suppresses a claim that WAS computed. `undefined` is indistinguishable from
  // a detector that dropped the field.
  //
  // Note the DELIBERATE asymmetry with decision 2's `originalChars`, where
  // ABSENCE is the signal. The two modules use opposite conventions on purpose;
  // a future reader should not unify them.
  const { agg } = await seam();
  for (const f of agg.insights) {
    assert.ok('impact' in f, `${f.id} omits impact entirely`);
    if (f.impact === null) continue;              // the "no $ claimed" encoding (ADR §6)
    assert.equal(typeof f.impact, 'number', `${f.id} impact is ${typeof f.impact}`);
    assert.ok(Number.isFinite(f.impact), `${f.id} impact is ${f.impact}`);
  }
});

test('at least one finding computes a dollar figure, so the number branch is real', async () => {
  // Without this the impact contract could pass vacuously on a corpus where
  // every detector stayed silent about money.
  const { agg } = await seam();
  const computed = agg.insights.filter((f) => typeof f.impact === 'number');
  assert.ok(computed.length >= 1,
    `no finding computed an impact; ids seen: ${agg.insights.map((f) => f.id).join(', ') || '(none)'}`);
  for (const f of computed) assert.ok(f.impact > 0, `${f.id} claims a non-positive dollar figure`);
});

// ── the §4 invariant survives the real seam ─────────────────────────────────

test('engagedSeconds <= spanUnionSeconds <= spanMinutes*60 through the real modules', async () => {
  // ADR-0009 §4. Asserted here as well as in usage-index.test.mjs because that
  // suite proves it under doubles: a real `detectInsights` receives the whole
  // aggregate and could, in principle, mutate the totals it was handed.
  const { agg } = await seam();
  const { engagedSeconds, spanUnionSeconds, spanMinutes } = agg.totals;

  assert.ok(Number.isFinite(engagedSeconds));
  assert.ok(Number.isFinite(spanUnionSeconds));
  assert.ok(Number.isFinite(spanMinutes));
  assert.ok(engagedSeconds <= spanUnionSeconds,
    `engaged ${engagedSeconds}s must not exceed the span union ${spanUnionSeconds}s`);
  assert.ok(spanUnionSeconds <= spanMinutes * 60,
    `the span union ${spanUnionSeconds}s must not exceed the summed spans ${spanMinutes * 60}s`);
  assert.ok(engagedSeconds > 0, 'a corpus with work in it must report engaged time');
});
