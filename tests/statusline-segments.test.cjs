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

// The security overlay ships in the same block (it must: the strip regex in
// statusline.mjs is non-global, so a second ruflo-seg block would leak on re-injection).
let rufloLocalSecurity, rufloHonestInsight, rufloAidefenceState;
try {
  // eslint-disable-next-line no-eval
  rufloLocalSecurity = eval('(function(){' + block + '\nreturn rufloLocalSecurity;})()');
  // eslint-disable-next-line no-eval
  rufloHonestInsight = eval('(function(){' + block + '\nreturn rufloHonestInsight;})()');
  // eslint-disable-next-line no-eval
  rufloAidefenceState = eval('(function(){' + block + '\nreturn rufloAidefenceState;})()');
} catch (e) {
  console.error('FATAL: could not extract security overlay fns:', e.message);
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
// Note: the aidefence segment is ALARM-ONLY and reads the *global* ruflo install, so on
// a machine whose ruflo is missing aidefence it legitimately renders here. Assert only
// that the project-data segments (SONA / route / proof) are gated off — those are what
// an empty fixture controls. The aidefence polarity is covered by its own suite below,
// against fixture trees rather than whatever this machine happens to have installed.
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

// ── security overlay: ruflo's fabricated CVE counter ────────────────────────
// Upstream getSecurityStatus() (@claude-flow/cli funnel/local-signals.js) hardcodes
// `const totalCves = 3` — ruflo's OWN v3 roadmap items, not the rendered project's risk —
// and derives cvesFixed from scans.length, a FILE count. So a pristine repo is told it
// has 3 CVEs, and running the suggested scan "fixes" one by writing a file. The overlay
// reports what the newest scan actually found and never invents a CVE.
console.log('\nsecurity overlay (fabricated-CVE fix)');

const scanFixture = (files) => mkFixture(Object.fromEntries(
  Object.entries(files).map(([f, o]) => ['.claude/security-scans/' + f, o])));
const iso = (ms) => new Date(Date.now() + ms).toISOString();

test('never scanned → PENDING (honest unknown, not a false green)', () => {
  const r = rufloLocalSecurity(mkFixture({}), { status: 'UPSTREAM' });
  assert(r.status === 'PENDING', 'expected PENDING, got ' + r.status);
});

test('clean fresh scan → CLEAN', () => {
  const r = rufloLocalSecurity(scanFixture({
    'scan-all-full.json': { timestamp: iso(0), summary: { total: 0 }, findings: [] },
  }), null);
  assert(r.status === 'CLEAN', 'expected CLEAN, got ' + r.status);
});

test('real findings → "N ISSUES" with the true count', () => {
  const r = rufloLocalSecurity(scanFixture({
    'scan.json': { timestamp: iso(0), summary: { critical: 1, high: 2, total: 3 }, findings: [1, 2, 3] },
  }), null);
  assert(r.status === '3 ISSUES', 'expected "3 ISSUES", got ' + r.status);
});

test('single finding is singular ("1 ISSUE")', () => {
  const r = rufloLocalSecurity(scanFixture({
    'scan.json': { timestamp: iso(0), summary: { total: 1 }, findings: [1] },
  }), null);
  assert(r.status === '1 ISSUE', 'expected "1 ISSUE", got ' + r.status);
});

test('clean but stale scan → STALE (not a stale green tick)', () => {
  const r = rufloLocalSecurity(scanFixture({
    'scan.json': { timestamp: iso(-30 * 864e5), summary: { total: 0 }, findings: [] },
  }), null);
  assert(r.status === 'STALE', 'expected STALE, got ' + r.status);
});

// THE regression this whole patch exists for.
test('N clean scan FILES never fabricate CVEs (the upstream file-count bug)', () => {
  const r = rufloLocalSecurity(scanFixture({
    'a.json': { timestamp: iso(0), summary: { total: 0 }, findings: [] },
    'b.json': { timestamp: iso(1), summary: { total: 0 }, findings: [] },
    'c.json': { timestamp: iso(2), summary: { total: 0 }, findings: [] },
  }), null);
  assert(r.status === 'CLEAN', 'three clean scans must be CLEAN, got ' + r.status);
  assert(r.totalCves === 0 && r.cvesFixed === 0, 'file count must never become a CVE count');
});

test('totalCves/cvesFixed are pinned to 0 in every state (⚠ N CVEs can never fire)', () => {
  const states = [
    mkFixture({}),
    scanFixture({ 's.json': { timestamp: iso(0), summary: { total: 0 }, findings: [] } }),
    scanFixture({ 's.json': { timestamp: iso(0), summary: { total: 9 }, findings: [1] } }),
    scanFixture({ 's.json': { timestamp: iso(-30 * 864e5), summary: { total: 0 }, findings: [] } }),
  ];
  for (const dir of states) {
    const r = rufloLocalSecurity(dir, null);
    assert(r.totalCves === 0 && r.cvesFixed === 0,
      'CVE counters must stay 0, got ' + JSON.stringify(r));
  }
});

test('newest scan wins over older ones', () => {
  const r = rufloLocalSecurity(scanFixture({
    'old.json': { timestamp: iso(-864e5), summary: { total: 7 }, findings: [1] },
    'new.json': { timestamp: iso(0), summary: { total: 0 }, findings: [] },
  }), null);
  assert(r.status === 'CLEAN', 'newest (clean) scan must win, got ' + r.status);
});

test('malformed scan JSON is ignored, never throws', () => {
  const dir = mkFixture({
    '.claude/security-scans/broken.json': 'not json at all{{',
    '.claude/security-scans/good.json': JSON.stringify({ timestamp: iso(0), summary: { total: 2 }, findings: [1, 2] }),
  });
  const r = rufloLocalSecurity(dir, null);
  assert(r.status === '2 ISSUES', 'expected "2 ISSUES" from the readable scan, got ' + r.status);
});

test('findings[] length is used when summary.total is absent', () => {
  const r = rufloLocalSecurity(scanFixture({
    'scan.json': { timestamp: iso(0), findings: [1, 2, 3, 4] },
  }), null);
  assert(r.status === '4 ISSUES', 'expected "4 ISSUES", got ' + r.status);
});

// ── insight row: the CLI bakes the fabricated count into promo TEXT ──────────
// funnel/insights.js computes `pending = totalCves - cvesFixed` CLI-side and ships a
// finished sentence, so overlaying data.security alone still leaves "⚠ 1 CVE pending"
// on line 3. promo.js drops the insight id, so this must match on text.
const cveInsight = (n) => ({ text: `⚠ ${n} CVE${n === 1 ? '' : 's'} pending — Run ruflo security scan --depth full`, kind: 'insight' });

test('fabricated CVE insight is dropped when the real scan is CLEAN', () => {
  const r = rufloHonestInsight(cveInsight(1), { status: 'CLEAN', cvesFixed: 0, totalCves: 0 });
  assert(r === null, 'clean scan must not nag about CVEs, got ' + JSON.stringify(r));
});

test('CVE insight becomes an honest scan-pending prompt when never scanned', () => {
  const r = rufloHonestInsight(cveInsight(3), { status: 'PENDING', cvesFixed: 0, totalCves: 0 });
  absent(r.text, 'CVE');
  contains(r.text, 'scan pending');
});

test('CVE insight becomes a real issue count when the scan found things', () => {
  const r = rufloHonestInsight(cveInsight(1), { status: '4 ISSUES', cvesFixed: 0, totalCves: 0 });
  contains(r.text, '4 security issues');
  absent(r.text, 'CVE');
});

test('CVE insight reports a stale scan honestly', () => {
  const r = rufloHonestInsight(cveInsight(2), { status: 'STALE', cvesFixed: 0, totalCves: 0 });
  contains(r.text, 'scan stale');
  absent(r.text, 'CVE');
});

test('non-CVE insights pass through untouched (funnel rotation preserved)', () => {
  const tip = { text: '💾 ruflo session restore --latest brings back your last session', kind: 'educational' };
  assert(rufloHonestInsight(tip, { status: 'CLEAN' }) === tip, 'educational tip must pass through by identity');
  const other = { text: '🧬 flywheel headline', kind: 'insight' };
  assert(rufloHonestInsight(other, { status: 'CLEAN' }) === other, 'non-CVE insight must pass through by identity');
});

test('null/!text promo is safe', () => {
  assert(rufloHonestInsight(null, { status: 'CLEAN' }) === null, 'null promo stays null');
  const weird = { kind: 'insight' };
  assert(rufloHonestInsight(weird, { status: 'CLEAN' }) === weird, 'promo without text passes through');
});

// ── AI defense (AIMDS): ALARM-ONLY, three-state, fail-safe ──────────────────
// Inverted from a permanent green "🛡 aidefence on" per issue #8's no-static-green-badge
// rule, and because that 🛡 collided with ruflo's line-2 scan shield — a DIFFERENT concern
// (`security scan` audits source; `security defend`/AIMDS screens prompts).
//
// The three-state contract is the safety property, not a nicety: inverting a signal also
// inverts its failure mode. "off" must require positive evidence (a real ruflo install
// lacking aidefence); an unresolvable probe must stay "unknown"/silent, never fail loud
// and wrong. Fixture trees are used so these hold regardless of what this machine has.
console.log('\naidefence segment (alarm-only inversion)');

const rufloTree = ({ aidefence }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  const root = path.join(dir, 'ruflo');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ruflo', version: '3.32.0' }));
  if (aidefence) {
    const ad = path.join(root, 'node_modules', '@claude-flow', 'aidefence');
    fs.mkdirSync(ad, { recursive: true });
    fs.writeFileSync(path.join(ad, 'package.json'), JSON.stringify({ name: '@claude-flow/aidefence' }));
  }
  return root;
};

test('aidefence installed → "on" (segment stays silent)', () => {
  assert(rufloAidefenceState(rufloTree({ aidefence: true })) === 'on');
});

test('ruflo present without aidefence → "off" (the alarm state)', () => {
  assert(rufloAidefenceState(rufloTree({ aidefence: false })) === 'off');
});

// The fail-safe: no ruflo located → we know nothing → must NOT claim the defense is off.
test('ruflo not locatable → "unknown", never "off"', () => {
  assert(rufloAidefenceState('') === 'unknown', 'empty root must be unknown');
  assert(rufloAidefenceState(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now())) === 'unknown',
    'nonexistent root must be unknown');
});

test('a directory without ruflo/package.json is "unknown", not "off"', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-'));   // exists, but is not a ruflo install
  assert(rufloAidefenceState(bare) === 'unknown');
});

// End-to-end through the REAL segment. rufloFindRufloRoot reads process.execPath, which
// no fixture can control from in-process, so the probe is overridden (function
// declarations hoist, so the binding is reassignable) and the actual rendered string is
// asserted — rather than pattern-matching the template source, which would pass even if
// the segment never wired the probe up.
function renderWithRufloRoot(root) {
  // eslint-disable-next-line no-eval
  const seg = eval('(function(){' + block
    + '\nrufloFindRufloRoot = function(){ return ' + JSON.stringify(root) + '; };'
    + '\nreturn rufloActivationSegments;})()');
  return strip(seg(mkFixture({})));
}

test('aidefence present → segment renders NOTHING (issue #8: no static green badge)', () => {
  const out = renderWithRufloRoot(rufloTree({ aidefence: true }));
  absent(out, 'aidefence');
  absent(out, '🛡');          // must never collide with ruflo's line-2 scan shield
});

test('aidefence missing → the alarm renders, with no 🛡 and a named fix', () => {
  const out = renderWithRufloRoot(rufloTree({ aidefence: false }));
  contains(out, '⚠ aidefence OFF');
  contains(out, 'ak sync');
  absent(out, '🛡');
});

test('unresolvable ruflo → silent (a probe miss must never fail loud and wrong)', () => {
  const out = renderWithRufloRoot('');
  absent(out, 'aidefence');
});

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
