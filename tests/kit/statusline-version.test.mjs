// A statusline that claims a HIGHER Ruflo version than anything installed.
// Ruflo's helper bakes `let ver` as a floor and renders the highest version it
// finds, so once a wrong high value is baked in (a test fixture's fake 9.9.9
// once reached a real project that way) nothing on the render path lowers it.
// ak must (1) say so in `ak status` and the drift nudge, and (2) let the sync
// statusline step repair it through RUFLO's own refresh: clear the helper stamp
// so Ruflo regenerates the helper with its own baked value, then re-inject the
// footer. ak never writes a version itself.
//
// Hermetic: a synthetic global root plays the installed ruflo + @claude-flow/cli,
// and its helper-refresh.js MODELS THE REAL ONE'S STAMP GATE — it rewrites the
// helper only when the stamp is missing or older than the CLI. A fake that
// rewrites unconditionally would pass even if ak never cleared the stamp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, assertSandboxed, captureLog, rmrf } from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-statusline-version');
const paths = await import('../../src/lib/paths.mjs');
const { fixStatusline, statuslineVersionAhead } = await import('../../src/lib/statusline.mjs');
const { default: statuslineSection } = await import('../../src/commands/status/sections/statusline.mjs');
const { localDrift } = await import('../../src/lib/nudge.mjs');
const { SYNC_STEPS } = await import('../../src/commands/sync.mjs');
assertSandboxed(paths, HOME);

const CLI_VERSION = '3.45.0';
const helperSource = (ver) => `#!/usr/bin/env node
function getPkgVersion() {
  let ver = "${ver}";
  return ver;
}
function generateStatusline() { return 'RuFlo V' + getPkgVersion(); }
console.log(generateStatusline())
`;
// What Ruflo's signed package ships: its own (lower) baked floor.
const PRISTINE = helperSource('3.32.8');

const STAMP_AWARE_REFRESH = `import fs from 'node:fs';
import path from 'node:path';
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
export async function autoRefreshHelpersIfStale(root) {
  const dir = path.join(root, '.claude', 'helpers');
  const version = ${JSON.stringify(CLI_VERSION)};
  if (!fs.existsSync(path.join(dir, 'hook-handler.cjs'))) return { refreshed: false };
  let stamped = '';
  try { stamped = fs.readFileSync(path.join(dir, '.helpers-version'), 'utf8').trim(); } catch {}
  if (stamped && cmp(stamped, version) >= 0) return { refreshed: false };
  fs.writeFileSync(path.join(dir, 'statusline.cjs'), ${JSON.stringify(PRISTINE)});
  fs.writeFileSync(path.join(dir, '.helpers-version'), version);
  return { refreshed: true };
}
`;
const BLOCKED_REFRESH = `export async function autoRefreshHelpersIfStale() {
  return { refreshed: false, blocked: 'signed helpers manifest missing or signature invalid' };
}
`;

function fixture({ baked = '9.9.9', stamp = CLI_VERSION, refresh = 'stamp-aware', rufloInstalled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(HOME, 'fx-'));
  const proj = path.join(dir, 'proj');
  const helpers = path.join(proj, '.claude', 'helpers');
  fs.mkdirSync(helpers, { recursive: true });
  fs.mkdirSync(path.join(proj, '.git'));
  fs.writeFileSync(path.join(helpers, 'statusline.cjs'), helperSource(baked));
  fs.writeFileSync(path.join(helpers, 'hook-handler.cjs'), '');
  if (stamp !== null) fs.writeFileSync(path.join(helpers, '.helpers-version'), stamp);
  const groot = path.join(dir, 'groot');
  fs.mkdirSync(groot, { recursive: true });
  if (rufloInstalled) {
    const cli = path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli');
    fs.mkdirSync(path.join(cli, 'dist', 'src', 'init'), { recursive: true });
    fs.writeFileSync(path.join(groot, 'ruflo', 'package.json'), JSON.stringify({ name: 'ruflo', version: CLI_VERSION }));
    fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@claude-flow/cli', version: CLI_VERSION }));
    if (refresh) {
      fs.writeFileSync(path.join(cli, 'dist', 'src', 'init', 'helper-refresh.js'),
        refresh === 'blocked' ? BLOCKED_REFRESH : STAMP_AWARE_REFRESH);
    }
  }
  paths._setGlobalRootForTest(groot);
  const read = (name) => { try { return fs.readFileSync(path.join(helpers, name), 'utf8'); } catch { return null; } };
  return { proj, helpers, read, baked: () => (read('statusline.cjs') ?? '').match(/let ver = "([^"]+)"/)?.[1] };
}

// ── detection ────────────────────────────────────────────────────────────────

test('a baked version above every installed ruflo is reported with both versions', () => {
  const { proj } = fixture();
  assert.deepEqual(statuslineVersionAhead(proj), { baked: '9.9.9', installed: CLI_VERSION });
});

test('a baked version at or below the installed ruflo is Ruflo\'s normal floor, not drift', () => {
  assert.equal(statuslineVersionAhead(fixture({ baked: '3.32.8' }).proj), null);
  assert.equal(statuslineVersionAhead(fixture({ baked: CLI_VERSION }).proj), null);
});

test('nothing to compare when ruflo is not installed or the helper is absent', () => {
  assert.equal(statuslineVersionAhead(fixture({ rufloInstalled: false }).proj), null);
  const { proj, helpers } = fixture();
  fs.rmSync(path.join(helpers, 'statusline.cjs'));
  assert.equal(statuslineVersionAhead(proj), null);
});

// ── ak status + nudge ────────────────────────────────────────────────────────

test('status warns about the higher version and plans the sync statusline repair', async () => {
  const { proj } = fixture();
  const rows = await statuslineSection.collect({ cfg: {}, cwd: proj });
  const hit = rows.find((r) => r.subsystem === 'statusline' && /v9\.9\.9/.test(r.message));
  assert.ok(hit, JSON.stringify(rows));
  assert.equal(hit.level, 'warn');
  assert.match(hit.message, /installed ruflo is v3\.45\.0/);
  assert.match(hit.fix ?? '', /ruflo's own refresh/);
});

test('status stays quiet about the version when the baked floor is lower than installed', async () => {
  const { proj } = fixture({ baked: '3.32.8' });
  const rows = await statuslineSection.collect({ cfg: {}, cwd: proj });
  assert.equal(rows.some((r) => /installed ruflo is/.test(r.message)), false, JSON.stringify(rows));
});

test('with ruflo\'s refresh locked, status names the manual edit instead of planning a sync fix', async () => {
  const { proj, helpers } = fixture();
  fs.writeFileSync(path.join(helpers, '.LOCKED'), '');
  const rows = await statuslineSection.collect({ cfg: {}, cwd: proj });
  const hit = rows.find((r) => /v9\.9\.9/.test(r.message));
  assert.ok(hit, JSON.stringify(rows));
  assert.equal(hit.fix, null, 'sync cannot perform this repair, so it must not plan it');
  assert.match(hit.message, /\.LOCKED/);
  assert.match(hit.message, /let ver/);
});

test('the drift nudge names the statusline Ruflo version too', async () => {
  const { proj } = fixture();
  const lines = await localDrift({ cwd: proj, cfg: {}, targets: [] });
  assert.ok(lines.includes('statusline Ruflo version'), JSON.stringify(lines));
});

// ── sync repair through Ruflo's own refresh ─────────────────────────────────

test('fixStatusline clears the stamp so Ruflo regenerates the helper, then re-injects the footer', () => {
  const fx = fixture();
  const r = fixStatusline(fx.proj);
  assert.equal(r.versionRepair, 'repaired');
  assert.equal(fx.baked(), '3.32.8', 'Ruflo\'s own baked floor, never a value ak wrote');
  assert.equal(fx.read('.helpers-version'), CLI_VERSION, 'Ruflo re-stamped the regenerated helpers');
  assert.match(fx.read('statusline.cjs'), /ruflo-seg:BEGIN/);
  assert.equal(statuslineVersionAhead(fx.proj), null);
});

test('without the version defect the stamp is left alone (no gratuitous refresh)', () => {
  const fx = fixture({ baked: '3.32.8' });
  const r = fixStatusline(fx.proj);
  assert.equal(r.versionRepair, null);
  assert.equal(fx.baked(), '3.32.8');
  assert.equal(fx.read('.helpers-version'), CLI_VERSION);
});

test('a blocked refresh restores the stamp and reports the repair as failed', () => {
  const fx = fixture({ refresh: 'blocked' });
  const r = fixStatusline(fx.proj);
  assert.equal(r.versionRepair, 'failed');
  assert.equal(fx.read('.helpers-version'), CLI_VERSION, 'the stamp ak cleared is put back');
  assert.equal(fx.baked(), '9.9.9', 'ak never writes the version itself');
  assert.match(fx.read('statusline.cjs'), /ruflo-seg:BEGIN/, 'the footer is still injected');
});

test('dryRun never clears the stamp', () => {
  const fx = fixture();
  const r = fixStatusline(fx.proj, { dryRun: true });
  assert.equal(r.versionRepair, null);
  assert.equal(fx.read('.helpers-version'), CLI_VERSION);
  assert.equal(fx.baked(), '9.9.9');
});

test('the sync statusline step reports a repaired version and warns on a failed one', async () => {
  const step = SYNC_STEPS.find((s) => s.id === 'statusline');
  const good = fixture();
  const { out: repaired } = await captureLog(() => step.run({ cwd: good.proj }));
  assert.match(repaired, /Ruflo regenerated the helper.*no longer shows v9\.9\.9/);
  const bad = fixture({ refresh: 'blocked' });
  const { out: failed } = await captureLog(() => step.run({ cwd: bad.proj }));
  assert.match(failed, /still shows Ruflo v9\.9\.9.*installed v3\.45\.0/);
  assert.match(failed, /let ver/);
});

test.after(() => rmrf(HOME));
