// helperStampStale / refreshRufloHelpers — closing the recurring statusline
// footer wipe. Root cause (identified 2026-07-18): @claude-flow/cli's
// version-stamped helper auto-refresh runs on EVERY ruflo CLI command and,
// when `.claude/helpers/.helpers-version` lags the installed CLI version,
// pristine-copies statusline.cjs over the kit's injected footer. Sync used to
// inject onto the stale-stamped file, so the first ruflo command afterwards
// (in practice the daemon start) wiped the footer — observed with statusline.cjs,
// .helpers-version, and daemon.pid mtimes matching to the second.
//
// The fix has two halves, both under test here:
//   · helperStampStale — status flags the ARMED wipe before it fires;
//   · refreshRufloHelpers + fixStatusline ordering — sync triggers ruflo's own
//     refresh FIRST, then injects onto the freshly-stamped copy.
// Hermetic: a synthetic global root stands in for the installed CLI, and a fake
// helper-refresh.js records its invocation (root + options) to a sentinel file,
// so the subprocess wiring is proven end to end — no npm, network, or ruflo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import { helperStampStale, refreshRufloHelpers, fixStatusline } from '../../src/lib/statusline.mjs';

// Minimal host: just the shapes fixStatusline keys off, runnable post-injection.
const HOST = `#!/usr/bin/env node
let ver = "3.0.0";
function generateStatusline() { return 'ok'; }
console.log(generateStatusline())
`;

// A stand-in for @claude-flow/cli's helper-refresh module. Writes what it was
// called with, so tests can assert the kit passed the right root and options.
const FAKE_REFRESH = `import fs from 'node:fs';
import path from 'node:path';
export async function autoRefreshHelpersIfStale(root, opts) {
  fs.writeFileSync(path.join(root, 'REFRESHED'), JSON.stringify({ root, opts }));
  return { refreshed: true };
}
`;

function fixture({ cliVersion = '3.32.7', stamp, refreshModule = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-stamp-'));
  const proj = path.join(dir, 'proj');
  const helpers = path.join(proj, '.claude', 'helpers');
  fs.mkdirSync(helpers, { recursive: true });
  fs.writeFileSync(path.join(helpers, 'statusline.cjs'), HOST);
  if (stamp !== undefined) fs.writeFileSync(path.join(helpers, '.helpers-version'), stamp);

  const groot = path.join(dir, 'groot');
  if (cliVersion !== null) {
    const cli = path.join(groot, 'ruflo', 'node_modules', '@claude-flow', 'cli');
    fs.mkdirSync(path.join(cli, 'dist', 'src', 'init'), { recursive: true });
    fs.writeFileSync(path.join(cli, 'package.json'),
      JSON.stringify({ name: '@claude-flow/cli', version: cliVersion }));
    if (refreshModule) {
      fs.writeFileSync(path.join(cli, 'dist', 'src', 'init', 'helper-refresh.js'), FAKE_REFRESH);
    }
  }
  _setGlobalRootForTest(groot);
  return { proj, sl: path.join(helpers, 'statusline.cjs') };
}

// --- helperStampStale: the armed-wipe predicate --------------------------------

test('stale when the stamp lags the installed CLI', () => {
  const { proj } = fixture({ cliVersion: '3.32.7', stamp: '3.32.2' });
  assert.equal(helperStampStale(proj), true);
});

test('current when the stamp matches the installed CLI', () => {
  const { proj } = fixture({ cliVersion: '3.32.7', stamp: '3.32.7' });
  assert.equal(helperStampStale(proj), false);
});

test('a stamp AHEAD of the CLI is not stale (refresh is forward-only)', () => {
  const { proj } = fixture({ cliVersion: '3.32.2', stamp: '3.32.7' });
  assert.equal(helperStampStale(proj), false);
});

test('missing stamp with a resolvable CLI counts as stale (first refresh pending)', () => {
  const { proj } = fixture({ cliVersion: '3.32.7' }); // no stamp written
  assert.equal(helperStampStale(proj), true);
});

test('no installed CLI → never stale (nothing exists to refresh anything)', () => {
  const { proj } = fixture({ cliVersion: null, stamp: '3.32.2' });
  assert.equal(helperStampStale(proj), false);
});

// --- refreshRufloHelpers: the subprocess trigger -------------------------------

test('absent helper-refresh module → false, no throw', () => {
  const { proj } = fixture({ refreshModule: false });
  assert.equal(refreshRufloHelpers(proj), false);
});

test('invokes ruflo refresh with the project root and alsoRefreshGlobal', () => {
  const { proj } = fixture({ refreshModule: true });
  assert.equal(refreshRufloHelpers(proj), true);
  const rec = JSON.parse(fs.readFileSync(path.join(proj, 'REFRESHED'), 'utf8'));
  assert.equal(rec.root, proj);
  assert.equal(rec.opts.alsoRefreshGlobal, true);
});

// --- fixStatusline ordering: refresh BEFORE inject; dryRun stays read-only -----

test('fixStatusline refreshes helpers first, then injects the footer', () => {
  const { proj, sl } = fixture({ refreshModule: true });
  fixStatusline(proj);
  assert.ok(fs.existsSync(path.join(proj, 'REFRESHED')), 'refresh must have run');
  assert.match(fs.readFileSync(sl, 'utf8'), /ruflo-seg:BEGIN/);
});

test('dryRun never triggers the refresh (status stays read-only)', () => {
  const { proj } = fixture({ refreshModule: true });
  fixStatusline(proj, { dryRun: true });
  assert.equal(fs.existsSync(path.join(proj, 'REFRESHED')), false);
});
