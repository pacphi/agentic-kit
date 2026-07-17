#!/usr/bin/env node
//
// agentdb.test.cjs — unit tests for the agentdb coherence classifier
// (src/lib/agentdb.mjs). agentdb is a data-plane CLI whose global copy writes
// the SAME cognitive store ruflo's bundled agentdb writes; a CORE version skew
// between them is a store-corruption risk. classifyCoherence() is a PURE
// function over {global, bundled} version strings — tested here against real
// inputs (no stubs), covering every branch.
//
// Run: node tests/agentdb.test.cjs   (exit 0 = pass, 1 = fail)

const path = require('path');
const { classifyCoherence } = require(path.resolve(__dirname, '..', 'src', 'lib', 'agentdb.mjs'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  \x1b[32m✓\x1b[0m ' + name); passed++; }
  catch (e) { console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { assert(a === b, (msg || 'not equal') + ` (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

console.log('agentdb coherence classifier (src/lib/agentdb.mjs)');

test('absent global → not present, ok, target = bundled', () => {
  const c = classifyCoherence({ global: null, bundled: '3.0.0-alpha.17' });
  eq(c.present, false); eq(c.ok, true); eq(c.target, '3.0.0-alpha.17');
});

test('present global but unknown bundled → ok, no target (nothing to pin to)', () => {
  const c = classifyCoherence({ global: '3.0.0-alpha.17', bundled: null });
  eq(c.present, true); eq(c.ok, true); eq(c.skew, null); eq(c.target, null);
});

test('identical versions → coherent (skew null, ok)', () => {
  const c = classifyCoherence({ global: '3.0.0-alpha.17', bundled: '3.0.0-alpha.17' });
  eq(c.ok, true); eq(c.skew, null); eq(c.target, '3.0.0-alpha.17');
});

test('same core, different prerelease → tolerated (skew prerelease, ok)', () => {
  const c = classifyCoherence({ global: '3.0.0-alpha.17', bundled: '3.0.0-alpha.12' });
  eq(c.ok, true); eq(c.skew, 'prerelease'); eq(c.target, '3.0.0-alpha.12');
});

test('different core (minor) → CORE SKEW, not ok, target = bundled', () => {
  const c = classifyCoherence({ global: '3.1.0-alpha.1', bundled: '3.0.0-alpha.17' });
  eq(c.ok, false); eq(c.skew, 'core'); eq(c.target, '3.0.0-alpha.17');
});

test('different core (major) → CORE SKEW, not ok', () => {
  const c = classifyCoherence({ global: '4.0.0', bundled: '3.0.0-alpha.17' });
  eq(c.ok, false); eq(c.skew, 'core');
});

test('different core (patch) → CORE SKEW (store schema authority is exact base)', () => {
  const c = classifyCoherence({ global: '3.0.1', bundled: '3.0.0' });
  eq(c.ok, false); eq(c.skew, 'core');
});

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
