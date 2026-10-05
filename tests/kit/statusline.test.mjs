// fixStatusline's injected blocks. Hermetic: a synthetic global-root fixture stands
// in for the installed CLI, so no npm, network or real ruflo install is involved.
//
// The CVE-counter overlay (the stopgap for ruvnet/ruflo#2694: a hardcoded
// `totalCves = 3` with cvesFixed from scans.length) is retired: the fix shipped in
// Ruflo 3.32.2, below the support window's floor. fixStatusline still strips an old
// block for one release; it never injects one, even on a CLI that has the defect.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import { fixStatusline } from '../../src/lib/statusline.mjs';
import { projectStatuslineFooter, projectStatuslineLoader } from '../../src/lib/paths.mjs';
import statuslineSection from '../../src/commands/status/sections/statusline.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import { redirectToolState, spawnEnv } from './helpers/home-sandbox.mjs';

// The rendered footer caches ruflo-daemon-count.json and ruvnet-brain-kb-size.json
// in os.tmpdir() for 30 s (src/lib/daemons.mjs, statusline-footer.cjs), shared with
// the developer's live footer; a test render must never poison those caches.
const toolState = redirectToolState('ak-sl');
after(() => toolState.restore());

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

// The ruvnet/ruflo#2694 defect shape (buggy) and its repair; fixStatusline ignores both now.
const signalsSrc = (buggy) => (buggy
  ? 'export function getSecurityStatus(cwd) {\n  let cvesFixed = 0;\n  const totalCves = 3;\n  cvesFixed = Math.min(totalCves, scans.length);\n}\n'
  : 'export function getSecurityStatus(cwd) {\n  const findings = readScan(cwd);\n  return { status: findings.length ? "ISSUES" : "CLEAN" };\n}\n');

function fixture({ buggyUpstream, rufloVersion }) {
  const dir = tempDir('ak-sl');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, '.claude', 'helpers'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'helpers', 'statusline.cjs'), HOST);

  const groot = path.join(dir, 'groot');
  const funnel = path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'funnel');
  fs.mkdirSync(funnel, { recursive: true });
  fs.writeFileSync(path.join(funnel, 'local-signals.js'), signalsSrc(buggyUpstream));
  if (rufloVersion) {
    fs.writeFileSync(path.join(groot, 'ruflo', 'package.json'), JSON.stringify({ name: 'ruflo', version: rufloVersion }));
  }
  _setGlobalRootForTest(groot);
  return { proj, sl: path.join(proj, '.claude', 'helpers', 'statusline.cjs') };
}

const count = (s, re) => (s.match(re) || []).length;
// The footer and bin fix live in the kit's loader files, never in Ruflo's signed helper.
const footerOf = (proj) => fs.readFileSync(projectStatuslineFooter(proj), 'utf8');
const loaderOf = (proj) => projectStatuslineLoader(proj);

// An old security block as an earlier ak injected it (ruvnet/ruflo#2694 stopgap).
const OLD_SEC_BLOCK = [
  '/* ruflo-sec:BEGIN */',
  'try {',
  '  if (typeof getStatuslineData === "function") {',
  '    var _rufloOrigGetStatuslineData = getStatuslineData;',
  '    getStatuslineData = function(){',
  '      var d = _rufloOrigGetStatuslineData.apply(this, arguments);',
  '      try { if (d) { d.security = rufloLocalSecurity(process.cwd(), d.security); d.promo = rufloHonestInsight(d.promo, d.security); } } catch(e){}',
  '      return d;',
  '    };',
  '  }',
  '} catch(e){}',
  '/* ruflo-sec:END */',
].join('\n');

test('an old CVE overlay block is stripped and never re-injected, even on a CLI with the defect', () => {
  const { proj, sl } = fixture({ buggyUpstream: true });
  fs.writeFileSync(sl, HOST.replace('let ver', `${OLD_SEC_BLOCK}\nlet ver`));
  const r = fixStatusline(proj);
  assert.equal(r.applied, true);
  assert.equal('securityOverlay' in r, false, 'the result no longer reports an overlay');
  const out = fs.readFileSync(sl, 'utf8');
  assert.doesNotMatch(out, /ruflo-sec/);
  assert.doesNotMatch(out, /rufloLocalSecurity|rufloHonestInsight/);
  assert.equal(out, HOST, 'the signed helper is restored to Ruflo\'s own text');
  assert.match(footerOf(proj), /ruflo-seg:BEGIN/, 'the activation footer lives in the kit footer file');
});

test('status never reports a statusline/cve row, even on a CLI with the defect', async () => {
  const { proj, sl } = fixture({ buggyUpstream: true });
  fs.writeFileSync(sl, HOST.replace('let ver', `${OLD_SEC_BLOCK}\nlet ver`));
  const rows = await statuslineSection.collect({ cfg: {}, cwd: proj });
  assert.deepEqual(rows.filter((r) => r.subsystem === 'statusline/cve'), []);
  assert.equal(rows.find((r) => r.subsystem === 'statusline').level, 'warn', 'the old block is drift sync removes');
});

test('the footer template no longer carries the CVE overlay functions', () => {
  const footer = fs.readFileSync(new URL('../../src/templates/statusline-footer.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(footer, /function rufloLocalSecurity|function rufloHonestInsight/);
});

test('the loader and footer files are syntactically valid', () => {
  const { proj } = fixture({ buggyUpstream: true });
  fixStatusline(proj);
  // throws on bad syntax
  execFileSync(process.execPath, ['--check', loaderOf(proj)], { stdio: 'ignore' }); // spawn-env: inherits (syntax check only, runs nothing)
  execFileSync(process.execPath, ['--check', projectStatuslineFooter(proj)], { stdio: 'ignore' }); // spawn-env: inherits (syntax check only, runs nothing)
});

test('injection is idempotent — repeated syncs never stack blocks', () => {
  const { proj, sl } = fixture({ buggyUpstream: true });
  fixStatusline(proj); fixStatusline(proj);
  const r3 = fixStatusline(proj);
  const out = fs.readFileSync(sl, 'utf8');
  const footer = footerOf(proj);
  assert.equal(count(out, /ruflo-(sec|seg|bin):BEGIN/g), 0, 'nothing is injected into the signed helper');
  assert.equal(count(footer, /ruflo-seg:BEGIN/g), 1);
  assert.equal(count(footer, /ruflo-bin:BEGIN/g), 1);
  assert.equal(r3.applied, false, 'a converged file must report no change');
});

// ── bin-resolution wrapper ────────────────────────────────────────────────────
// Upstream's resolveCliBinCandidates probes filenames no shipped package ships,
// so delegation silently falls through to a possibly-stale npx cache. The wrapper
// prepends bins that actually exist. Crucially it has NO retirement gate — the
// fabricated "⚠ 1 CVE" survived on a machine whose gate had correctly retired the
// security overlay, precisely because the render path executed a stale npx copy
// the gate never probed.

test('bin wrapper is injected on a fixed CLI', () => {
  // buggyUpstream:false = the exact state that bit us: CVE counter fixed, bin path broken.
  const { proj, sl } = fixture({ buggyUpstream: false });
  fixStatusline(proj);
  const out = footerOf(proj);
  assert.match(out, /ruflo-bin:BEGIN/);
  assert.match(out, /function rufloRealCliBins/, 'footer helper the wrapper depends on');
  assert.equal(fs.readFileSync(sl, 'utf8'), HOST, 'the signed helper is untouched');
});

test('bin wrapper prepends real bins ahead of upstream candidates at run time', () => {
  const { proj } = fixture({ buggyUpstream: false });
  // A project-local ruflo whose REAL bin layout (bin/ruflo.js, nested cli) exists on disk.
  const rufloBin = path.join(proj, 'node_modules', 'ruflo', 'bin');
  fs.mkdirSync(rufloBin, { recursive: true });
  fs.writeFileSync(path.join(rufloBin, 'ruflo.js'), '');
  fixStatusline(proj);
  const stdout = execFileSync(process.execPath, [loaderOf(proj)], { cwd: proj, encoding: 'utf8', env: spawnEnv(path.join(path.dirname(proj), 'home')) });
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
  const stdout = execFileSync(process.execPath, [loaderOf(proj)], { cwd: proj, encoding: 'utf8', env: spawnEnv(path.join(path.dirname(proj), 'home')) });
  assert.match(stdout, /^x/, 'typeof guard: the wrapper must not break a template it does not fit');
});

// ── Ruflo owns the version its helper shows ──────────────────────────────────
// Ruflo bakes `let ver` into statusline.cjs as a FLOOR and, at render time, shows
// the HIGHEST version among that floor and every install it can find. A value ak
// wrote there never self-corrects when it is too high: a test fixture's fake
// `ruflo: 9.9.9` leaked into a real project and its statusline read "RuFlo V9.9.9".
// fixStatusline must leave the baked value exactly as Ruflo wrote it.

for (const [label, rufloVersion] of [['higher (the 9.9.9 leak)', '9.9.9'], ['lower', '2.0.0']]) {
  test(`fixStatusline keeps Ruflo's baked version when installed ruflo is ${label}`, () => {
    const { proj, sl } = fixture({ buggyUpstream: false, rufloVersion });
    const r = fixStatusline(proj);
    const out = fs.readFileSync(sl, 'utf8');
    assert.match(out, /let ver = "3\.0\.0";/, 'the helper\'s own baked version must survive injection');
    assert.doesNotMatch(out, new RegExp(`let ver = "${rufloVersion.replace(/\./g, '\\.')}"`));
    assert.match(footerOf(proj), /ruflo-seg:BEGIN/, 'the kit footer is still installed');
    assert.equal(r.applied, true);
  });
}

test('a converged helper stays converged when the installed ruflo version changes', () => {
  const { proj, sl } = fixture({ buggyUpstream: false, rufloVersion: '9.9.9' });
  fixStatusline(proj);
  fs.writeFileSync(path.join(_globalRootOf(sl), 'ruflo', 'package.json'),
    JSON.stringify({ name: 'ruflo', version: '3.45.0' }));
  assert.equal(fixStatusline(proj, { dryRun: true }).applied, false,
    'status must not report drift that only a version rewrite would "fix"');
});

// The fixture's groot sits next to the project dir: <tmp>/proj/... and <tmp>/groot.
function _globalRootOf(slPath) {
  return path.join(slPath, '..', '..', '..', '..', 'groot');
}
