#!/usr/bin/env node
//
// harvest.test.cjs — unit tests for `ak x harvest` orchestration (src/lib/harvest.mjs).
//
// NO MOCKS, NO STUBS. harvest's runtime path drives REAL CLIs (ruflo/agentdb) and
// is proven end-to-end, against real data, by `ak x verify harvest`. These unit
// tests cover only the PURE, deterministic pieces:
//   1. planHarvest — the exact grounded verbs + args it will run;
//   2. parseConsolidate / parseStored — parsers asserted against REAL captured
//      output from the installed agentdb CLI (ANSI codes included), so a change
//      in the tool's output shape fails here instead of silently harvesting nothing.
//
// Run: node tests/harvest.test.cjs   (exit 0 = pass, 1 = fail)

const path = require('path');
const { planHarvest, parseConsolidate, parseStored } =
  require(path.resolve(__dirname, '..', 'src', 'lib', 'harvest.mjs'));

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

console.log('harvest orchestration (src/lib/harvest.mjs)');

// ── planHarvest: the exact grounded verbs, in order ─────────────────────────
test('planHarvest returns the two grounded verbs, in order', () => {
  const steps = planHarvest();
  eq(steps.length, 2);
  eq(steps[0].cmd, 'ruflo');
  eq(steps[0].args.slice(0, 2), ['hooks', 'post-task'], 'step 1 = ruflo hooks post-task');
  assert(steps[0].args.includes('--success') && steps[0].args.includes('true'), 'records --success true');
  eq(steps[1].cmd, 'agentdb');
  eq(steps[1].args.slice(0, 2), ['skill', 'consolidate'], 'step 2 = agentdb skill consolidate');
  eq(steps[1].args[steps[1].args.length - 1], 'true', 'consolidate persists (trailing true)');
  eq(steps[1].tool, 'agentdb', 'step 2 is tagged agentdb so it can be skipped when absent');
});

test('planHarvest honors overridden params + default minReward is agentdb-native 0.7', () => {
  eq(planHarvest()[1].args, ['skill', 'consolidate', '3', '0.7', '7', 'true'], 'defaults match agentdb (3,0.7,7)');
  const s = planHarvest({ taskId: 'sess-9', minAttempts: 5, minReward: 0.75, days: 14 });
  assert(s[0].args.includes('sess-9'), 'taskId threaded into post-task');
  eq(s[1].args, ['skill', 'consolidate', '5', '0.75', '14', 'true']);
});

test('no daemon/background/swarm verb appears in the plan', () => {
  planHarvest().forEach((s) => {
    const joined = [s.cmd, ...s.args].join(' ');
    assert(!/\bdaemon\b|\bstart\b|\bswarm\b/.test(joined), 'no backgrounding verb: ' + joined);
  });
});

// ── parseConsolidate: REAL captured agentdb output (with ANSI) ──────────────
// Captured live from `agentdb skill consolidate 1 0.5 30 true` on a seeded store.
const REAL_CREATED =
  '\x1b[1m\x1b[36m\n🔄 Consolidating Episodes into Skills with Pattern Extraction\x1b[0m\n' +
  '\x1b[34mℹ Min Reward: 0.5\x1b[0m\n' +
  '\x1b[32m✅ Created 1 new skills, updated 0 existing skills in 11ms\x1b[0m\n' +
  'Extracted Patterns:\n  Avg Reward: 0.88\n';
const REAL_NONE =
  '\x1b[32m✅ Created 0 new skills, updated 0 existing skills in 2ms\x1b[0m\n' +
  '\x1b[33m⚠ No episodes met the criteria for skill consolidation\x1b[0m\n';

test('parseConsolidate extracts created/updated/avgReward from REAL output', () => {
  const p = parseConsolidate(REAL_CREATED);
  eq(p.created, 1); eq(p.updated, 0); eq(p.avgReward, 0.88); eq(p.noEpisodes, false);
});

test('parseConsolidate flags the real "no episodes" case (created 0, noEpisodes true)', () => {
  const p = parseConsolidate(REAL_NONE);
  eq(p.created, 0); eq(p.updated, 0); eq(p.noEpisodes, true);
});

test('parseConsolidate returns nulls (never fabricated 0s) when the line is absent', () => {
  const p = parseConsolidate('some unrelated output with no consolidate line');
  eq(p.created, null); eq(p.updated, null); eq(p.avgReward, null);
});

test('parseStored reads the real "Stored episode #N" acknowledgement', () => {
  eq(parseStored('\x1b[32m✅ Stored episode #2\x1b[0m').episode, 2);
  eq(parseStored('no episode line here').episode, null);
});

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
