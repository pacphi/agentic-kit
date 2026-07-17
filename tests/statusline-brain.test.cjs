#!/usr/bin/env node
//
// statusline-brain.test.cjs — unit tests for the 🧿 RuvNet-Brain footer segment.
//
// Mirrors statusline-segments.test.cjs: extracts the `rufloActivationSegments(cwd)`
// source block from the kit template, evals it, and exercises it against fixture
// KB dirs pointed at via RUVNET_BRAIN_KB. Asserts the brain segment RENDERS when a
// fixture KB dir contains the forge-mcp-all.mjs entrypoint (the same presence probe
// as src/lib/ruvnet-brain.mjs) and is ABSENT (honesty-gated — never fabricated) when
// the KB is missing or the entrypoint is not there.
//
// Run: node tests/statusline-brain.test.cjs   (exit 0 = pass, 1 = fail)

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
function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-')); }
function test(name, fn) {
  try { fn(); console.log('  \x1b[32m✓\x1b[0m ' + name); passed++; }
  catch (e) { console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function contains(hay, needle) { assert(hay.includes(needle), `expected output to contain ${JSON.stringify(needle)}\n      got: ${JSON.stringify(hay)}`); }
function absent(hay, needle) { assert(!hay.includes(needle), `expected output NOT to contain ${JSON.stringify(needle)}\n      got: ${JSON.stringify(hay)}`); }

// Render an empty project fixture with RUVNET_BRAIN_KB pointed at `kb` (or unset when null).
function renderWithKb(kb) {
  const prev = process.env.RUVNET_BRAIN_KB;
  if (kb === null) delete process.env.RUVNET_BRAIN_KB; else process.env.RUVNET_BRAIN_KB = kb;
  try { return strip(rufloActivationSegments(mkdir())); }
  finally { if (prev === undefined) delete process.env.RUVNET_BRAIN_KB; else process.env.RUVNET_BRAIN_KB = prev; }
}

// Build a fixture KB dir. `entry` controls whether the forge-mcp-all.mjs probe file exists.
function mkKb({ entry = true, dataBytes = 0 } = {}) {
  const kb = mkdir();
  if (entry) fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '// entrypoint\n');
  if (dataBytes > 0) fs.writeFileSync(path.join(kb, 'agentdb.rvf'), Buffer.alloc(dataBytes));
  // A __MACOSX artifact dir must never be counted toward KB size (it is a directory).
  fs.mkdirSync(path.join(kb, '__MACOSX'), { recursive: true });
  return kb;
}

console.log('statusline RuvNet-Brain segment (🧿)');

// ── honesty gate: absent ────────────────────────────────────────────────────
test('no KB dir (RUVNET_BRAIN_KB → empty temp) → no 🧿 brain row', () => {
  absent(renderWithKb(mkdir()), '🧿');
});

test('KB dir without forge-mcp-all.mjs entrypoint → no 🧿 (presence probe gates)', () => {
  const kb = mkKb({ entry: false, dataBytes: 4096 });
  absent(renderWithKb(kb), '🧿');
});

test('RUVNET_BRAIN_KB pointing at a nonexistent path → no 🧿', () => {
  absent(renderWithKb(path.join(os.tmpdir(), 'brain-nope-' + Date.now())), '🧿');
});

// ── present ─────────────────────────────────────────────────────────────────
test('KB with forge-mcp-all.mjs entrypoint → 🧿 brain row renders', () => {
  const out = renderWithKb(mkKb({ entry: true }));
  contains(out, '🧿');
});

test('KB with sized data files → 💾 size chip (mirrors the QE size logic)', () => {
  const out = renderWithKb(mkKb({ entry: true, dataBytes: 2 * 1024 * 1024 }));
  contains(out, '🧿');
  contains(out, '💾');
  contains(out, 'MB');
});

test('brain row occupies its OWN line, never merged with other segments', () => {
  const out = renderWithKb(mkKb({ entry: true, dataBytes: 1024 }));
  const lines = out.split('\n').filter(Boolean);
  const bl = lines.find((l) => l.includes('🧿'));
  assert(bl, 'expected a 🧿 line, got: ' + JSON.stringify(lines));
});

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
