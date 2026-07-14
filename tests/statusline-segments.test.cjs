#!/usr/bin/env node
//
// statusline-segments.test.cjs — unit tests for the activation-footer renderer.
//
// The renderer `rufloActivationSegments(cwd)` is embedded in shell/ruflo-functions.sh
// (between the /* ruflo-seg:BEGIN */ … /* ruflo-seg:END */ markers) and injected into
// .claude/helpers/statusline.cjs by ruflo-fix-statusline-version. This test extracts
// that exact source block, evals it, and exercises it against fixture project dirs so
// the footer's honesty-gating and field formatting are verified independently of any
// running ruflo install. Covers issue #8's proof/verdict segment + the existing
// SONA / route-Q segments.
//
// Run: node tests/statusline-segments.test.cjs   (exit 0 = pass, 1 = fail)

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'templates', 'statusline-footer.cjs');

// ── Load the renderer source from the kit template ───────────────────────────
const sh = fs.readFileSync(SRC, 'utf8');
const m = sh.match(/\/\* ruflo-seg:BEGIN \*\/([\s\S]*?)\/\* ruflo-seg:END \*\//);
if (!m) { console.error('FATAL: could not find ruflo-seg block in ' + SRC); process.exit(2); }
const block = m[1];

// Load the function into this process. The block defines `function rufloActivationSegments(cwd){…}`.
// SECURITY: eval() here runs FIRST-PARTY source — the exact bytes of the kit's own template
// (read above), not external/user input. This is the only faithful way to test
// the injected renderer without duplicating it. The eval doubles as a syntax check on the block.
let rufloActivationSegments;
try {
  // eslint-disable-next-line no-eval
  rufloActivationSegments = eval('(function(){' + block + '\nreturn rufloActivationSegments;})()');
} catch (e) {
  console.error('FATAL: extracted segment block is not valid JS:', e.message);
  process.exit(2);
}

// ── Test harness ────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
function mkFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-test-'));
  for (const [rel, data] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, typeof data === 'string' ? data : JSON.stringify(data));
  }
  return dir;
}
function test(name, fn) {
  try { fn(); console.log('  \x1b[32m✓\x1b[0m ' + name); passed++; }
  catch (e) { console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function contains(hay, needle) { assert(hay.includes(needle), `expected output to contain ${JSON.stringify(needle)}\n      got: ${JSON.stringify(hay)}`); }
function absent(hay, needle) { assert(!hay.includes(needle), `expected output NOT to contain ${JSON.stringify(needle)}\n      got: ${JSON.stringify(hay)}`); }

console.log('statusline activation-footer renderer');

// ── empty / absent ────────────────────────────────────────────────────────
// Note: aidefence is sourced from the *global* ruflo install, so it may render on
// a machine that has ruflo installed. Assert only that the project-data segments
// (SONA / route / proof) are gated off — those are what an empty fixture controls.
test('empty project → no SONA/route/proof segments', () => {
  const out = strip(rufloActivationSegments(mkFixture({})));
  absent(out, '🧠 SONA');
  absent(out, '📈 RL');
  absent(out, 'proof');
});

// ── SONA segment ────────────────────────────────────────────────────────────
test('SONA segment renders patterns + traj from neural/stats.json', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/neural/stats.json': { patternsLearned: 50, trajectoriesRecorded: 110 },
  })));
  contains(out, '🧠 SONA');
  contains(out, '50 patterns');
  contains(out, '110 traj');
});

test('SONA segment absent when counts are zero', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/neural/stats.json': { patternsLearned: 0, trajectoriesRecorded: 0 },
  })));
  absent(out, '🧠 SONA');
});

// ── route Q-learner segment ───────────────────────────────────────────────
test('route 📈 RL renders ε/δ̄/|Q|/upd when updateCount > 0', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.swarm/q-learning-model.json': {
      stats: { updateCount: 42, epsilon: 0.83, avgTDError: 0.012 },
      qTable: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 },
    },
  })));
  contains(out, '📈 RL');
  contains(out, 'ε0.83');
  contains(out, 'δ̄0.012');
  contains(out, '|Q|6');
  contains(out, 'upd42');
});

test('route 📈 RL gated off when updateCount is 0 (no zero-state noise)', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.swarm/q-learning-model.json': { stats: { updateCount: 0, epsilon: 1.0 }, qTable: {} },
  })));
  absent(out, '📈 RL');
});

// ── proof / verdict segment — ALARM-ONLY (issue #8, user decision) ──────────
// PASS is the expected state and is rendered SILENTLY; only a FAIL (regression) surfaces.
test('proof PASS is silent (alarm-only — no static green badge)', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': {
      verdict: 'PASS', deltaPP: 50, ci95: 8, pValue: 0.0004, cohensD: 999,
    },
  })));
  absent(out, 'proof');
  absent(out, '✅');
});

test('proof FAIL renders ◷ with Δpp/CI/p/d and exact p-value formatting', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': {
      verdict: 'FAIL', deltaPP: 12, ci95: 9, pValue: 0.21, cohensD: 0.4,
    },
  })));
  contains(out, '◷ proof FAIL');
  contains(out, 'Δ+12pp');
  contains(out, 'CI±9');
  contains(out, 'p=0.210');
  contains(out, 'd0.4');
  absent(out, '✅');
});

test('proof FAIL with cohensD 999 sentinel → d∞', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': { verdict: 'FAIL', cohensD: 999 },
  })));
  contains(out, 'd∞');
});

test('proof FAIL handles negative deltaPP sign', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': { verdict: 'FAIL', deltaPP: -5, ci95: 3, pValue: 0.5, cohensD: 0.1 },
  })));
  contains(out, 'Δ-5pp');
});

test('proof segment absent on malformed improvement.json (no crash)', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': '{ this is not json',
  })));
  absent(out, 'proof');
});

test('proof segment absent on invalid verdict value', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': { verdict: 'MAYBE', deltaPP: 1 },
  })));
  absent(out, 'proof');
});

test('proof FAIL renders with only verdict present (all stat fields missing)', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': { verdict: 'FAIL' },
  })));
  contains(out, '◷ proof FAIL');
});

test('pValue exactly 0.001 renders p=0.001 (not p<.001) — boundary lock', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': { verdict: 'FAIL', pValue: 0.001 },
  })));
  contains(out, 'p=0.001');
  absent(out, 'p<.001');
});

test('cohensD near-sentinel 998.99 renders literally (sentinel is exact 999, not a threshold)', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': { verdict: 'FAIL', cohensD: 998.99 },
  })));
  contains(out, 'd998.99');
  absent(out, 'd∞');
});

// ── proof FAIL age annotation (stale-FAIL honesty) ──────────────────────────
const NOW = Math.floor(Date.now() / 1000);
test('fresh FAIL (ts now) shows no age token', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': { verdict: 'FAIL', deltaPP: 2, ts: NOW },
  })));
  contains(out, '◷ proof FAIL');
  absent(out, 'ago');
});

test('FAIL 3d old shows "3d ago"', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': { verdict: 'FAIL', deltaPP: 2, ts: NOW - 3 * 86400 },
  })));
  contains(out, '3d ago');
});

test('FAIL 5h old shows "5h ago"', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/improvement.json': { verdict: 'FAIL', deltaPP: 2, ts: NOW - 5 * 3600 },
  })));
  contains(out, '5h ago');
});

// ── combined + per-line layout (each segment on its own line) ───────────────
test('SONA, route, and proof FAIL each render on their OWN line', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/neural/stats.json': { patternsLearned: 50, trajectoriesRecorded: 110 },
    '.swarm/q-learning-model.json': { stats: { updateCount: 7, epsilon: 0.5, avgTDError: 0.02 }, qTable: { a: 1 } },
    '.claude-flow/improvement.json': { verdict: 'FAIL', deltaPP: 3, ci95: 5, pValue: 0.4, cohensD: 0.2 },
  })));
  contains(out, '🧠 SONA');
  contains(out, '📈 RL');
  contains(out, '◷ proof FAIL');
  // Each on its own line: SONA and 📈 RL must NOT share a line.
  const lines = out.split('\n').filter(Boolean);
  const sonaLine = lines.find((l) => l.includes('🧠 SONA'));
  assert(sonaLine && !sonaLine.includes('📈 RL'), 'SONA and 📈 RL must be on separate lines, got: ' + JSON.stringify(sonaLine));
  assert(lines.some((l) => l.includes('📈 RL') && !l.includes('🧠 SONA')), '📈 RL must be on its own line');
});

test('SONA and route render on separate lines even with a silent PASS', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/neural/stats.json': { patternsLearned: 50, trajectoriesRecorded: 110 },
    '.swarm/q-learning-model.json': { stats: { updateCount: 7, epsilon: 0.5, avgTDError: 0.02 }, qTable: { a: 1 } },
    '.claude-flow/improvement.json': { verdict: 'PASS', deltaPP: 33, ci95: 5, pValue: 0.001, cohensD: 1.2 },
  })));
  const lines = out.split('\n').filter(Boolean);
  assert(lines.some((l) => l.includes('🧠 SONA') && !l.includes('📈 RL')), 'SONA on its own line');
  assert(lines.some((l) => l.includes('📈 RL')), '📈 RL present on its own line');
  absent(out, 'proof');   // PASS stays silent
});

// ── Δ LoRA must remain omitted (F4 gate, #519) ──────────────────────────────
test('Δ LoRA field is never rendered (F4 gate honored)', () => {
  const out = strip(rufloActivationSegments(mkFixture({
    '.claude-flow/neural/stats.json': { patternsLearned: 50, trajectoriesRecorded: 110, deltaNorm: 0.42 },
  })));
  absent(out, 'LoRA');
  absent(out, 'Δ LoRA');
});

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
