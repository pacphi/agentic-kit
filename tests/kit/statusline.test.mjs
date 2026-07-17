// fixStatusline's security-overlay injection — the stopgap for ruflo's fabricated
// CVE counter (@claude-flow/cli funnel/local-signals.js getSecurityStatus: a hardcoded
// `totalCves = 3` naming ruflo's OWN v3 roadmap items, with cvesFixed derived from
// scans.length — a FILE count). Hermetic: a synthetic global-root fixture stands in for
// the installed CLI, so the upstream-defect gate can be driven both ways without npm,
// network, or a real ruflo install.
//
// The retirement test is the important one: the kit must STOP patching the moment
// upstream ships a fix, without anyone editing a pinned version number here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import { fixStatusline, upstreamCveCounterFabricated } from '../../src/lib/statusline.mjs';

// Minimal stand-in for ruflo's real statusline: only the shapes fixStatusline keys
// off. resolveCliBinCandidates models the upstream defect — candidates that never
// exist — and generateStatusline prints what the resolver returns so a test can RUN
// the patched file and observe the wrapper's effect, not just its presence.
const HOST = `#!/usr/bin/env node
let ver = "3.0.0";
function applyLocalOverlays(data) { return data; }
function getStatuslineData() { return { security: { status: 'IN_PROGRESS', cvesFixed: 2, totalCves: 3 } }; }
function resolveCliBinCandidates() { return ['/orig']; }
function generateStatusline() { return 'BINS:' + resolveCliBinCandidates().join('|'); }
console.log(generateStatusline())
`;

// The buggy shape fixStatusline probes for; `fixed` models an upstream repair.
const signalsSrc = (buggy) => (buggy
  ? 'export function getSecurityStatus(cwd) {\n  let cvesFixed = 0;\n  const totalCves = 3;\n  cvesFixed = Math.min(totalCves, scans.length);\n}\n'
  : 'export function getSecurityStatus(cwd) {\n  const findings = readScan(cwd);\n  return { status: findings.length ? "ISSUES" : "CLEAN" };\n}\n');

function fixture({ buggyUpstream }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-sl-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, '.claude', 'helpers'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'helpers', 'statusline.cjs'), HOST);

  const groot = path.join(dir, 'groot');
  const funnel = path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'funnel');
  fs.mkdirSync(funnel, { recursive: true });
  fs.writeFileSync(path.join(funnel, 'local-signals.js'), signalsSrc(buggyUpstream));
  _setGlobalRootForTest(groot);
  return { proj, sl: path.join(proj, '.claude', 'helpers', 'statusline.cjs') };
}

const count = (s, re) => (s.match(re) || []).length;

test('gate detects the fabricated CVE counter in a buggy CLI', () => {
  fixture({ buggyUpstream: true });
  assert.equal(upstreamCveCounterFabricated(), true);
});

test('gate goes quiet once upstream repairs getSecurityStatus', () => {
  fixture({ buggyUpstream: false });
  assert.equal(upstreamCveCounterFabricated(), false);
});

test('overlay is injected while the upstream defect is present', () => {
  const { proj, sl } = fixture({ buggyUpstream: true });
  const r = fixStatusline(proj);
  assert.equal(r.securityOverlay, true);
  const out = fs.readFileSync(sl, 'utf8');
  assert.match(out, /ruflo-sec:BEGIN/);
  assert.match(out, /function rufloLocalSecurity/);
  assert.match(out, /d\.security = rufloLocalSecurity/);
  assert.match(out, /d\.promo = rufloHonestInsight/);
});

test('injected statusline is syntactically valid', () => {
  const { proj, sl } = fixture({ buggyUpstream: true });
  fixStatusline(proj);
  execFileSync(process.execPath, ['--check', sl], { stdio: 'ignore' });   // throws on bad syntax
});

test('injection is idempotent — repeated syncs never stack blocks', () => {
  const { proj, sl } = fixture({ buggyUpstream: true });
  fixStatusline(proj); fixStatusline(proj);
  const r3 = fixStatusline(proj);
  const out = fs.readFileSync(sl, 'utf8');
  assert.equal(count(out, /ruflo-sec:BEGIN/g), 1);
  assert.equal(count(out, /ruflo-seg:BEGIN/g), 1);
  assert.equal(count(out, /ruflo-bin:BEGIN/g), 1);
  assert.equal(r3.applied, false, 'a converged file must report no change');
});

// ── bin-resolution wrapper ────────────────────────────────────────────────────
// Upstream's resolveCliBinCandidates probes filenames no shipped package ships,
// so delegation silently falls through to a possibly-stale npx cache. The wrapper
// prepends bins that actually exist. Crucially it has NO retirement gate — the
// fabricated "⚠ 1 CVE" survived on a machine whose gate had correctly retired the
// security overlay, precisely because the render path executed a stale npx copy
// the gate never probed.

test('bin wrapper is injected even when the security overlay is retired', () => {
  // buggyUpstream:false = the exact state that bit us: CVE gate retired, bin path broken.
  const { proj, sl } = fixture({ buggyUpstream: false });
  const r = fixStatusline(proj);
  assert.equal(r.securityOverlay, false, 'precondition: the gated overlay must be off');
  const out = fs.readFileSync(sl, 'utf8');
  assert.match(out, /ruflo-bin:BEGIN/);
  assert.match(out, /function rufloRealCliBins/, 'footer helper the wrapper depends on');
});

test('bin wrapper prepends real bins ahead of upstream candidates at run time', () => {
  const { proj, sl } = fixture({ buggyUpstream: false });
  // A project-local ruflo whose REAL bin layout (bin/ruflo.js, nested cli) exists on disk.
  const rufloBin = path.join(proj, 'node_modules', 'ruflo', 'bin');
  fs.mkdirSync(rufloBin, { recursive: true });
  fs.writeFileSync(path.join(rufloBin, 'ruflo.js'), '');
  fixStatusline(proj);
  const stdout = execFileSync(process.execPath, [sl], { cwd: proj, encoding: 'utf8' });
  const real = stdout.indexOf(path.join(rufloBin, 'ruflo.js'));
  const orig = stdout.indexOf('/orig');
  assert.notEqual(real, -1, 'the on-disk bin upstream can never find must be a candidate');
  assert.notEqual(orig, -1, "upstream's own candidates must survive as the tail");
  assert.ok(real < orig, 'real bins come first — they are the ones verified to exist');
});

test('bin wrapper is inert on a template without resolveCliBinCandidates', () => {
  const { proj, sl } = fixture({ buggyUpstream: false });
  fs.writeFileSync(sl, '#!/usr/bin/env node\nlet ver = "3.0.0";\nconsole.log("x")\n');
  fixStatusline(proj);
  const stdout = execFileSync(process.execPath, [sl], { cwd: proj, encoding: 'utf8' });
  assert.match(stdout, /^x/, 'typeof guard: the wrapper must not break a template it does not fit');
});

// The self-retirement contract: no version pin, no manual cleanup step.
test('overlay retires itself once upstream is fixed', () => {
  const { proj, sl } = fixture({ buggyUpstream: true });
  fixStatusline(proj);
  assert.match(fs.readFileSync(sl, 'utf8'), /ruflo-sec:BEGIN/);

  // Upstream ships the fix underneath us; the next sync must strip the stopgap.
  const funnel = path.join(_globalRootOf(sl), 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'funnel');
  fs.writeFileSync(path.join(funnel, 'local-signals.js'), signalsSrc(false));

  const r = fixStatusline(proj);
  assert.equal(r.securityOverlay, false);
  const out = fs.readFileSync(sl, 'utf8');
  assert.equal(count(out, /ruflo-sec:BEGIN/g), 0, 'stopgap must be gone');
  assert.match(out, /ruflo-seg:BEGIN/, 'the activation footer must survive');
});

// The fixture's groot sits next to the project dir: <tmp>/proj/... and <tmp>/groot.
function _globalRootOf(slPath) {
  return path.join(slPath, '..', '..', '..', '..', 'groot');
}
