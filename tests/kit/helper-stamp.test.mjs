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
// Hermetic: a synthetic global root stands in for the installed CLI, and the
// fake helper-refresh.js MODELS THE REAL ONE FAITHFULLY — it pristine-copies
// statusline.cjs (wiping any injected footer) before recording its invocation.
// That wipe is load-bearing: it is what makes the ordering test able to FAIL
// on inject-then-refresh. A sentinel-only fake passes both orderings and
// guards nothing (found by review; do not simplify it back).
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

// Faithful stand-in for @claude-flow/cli's helper-refresh: pristine-copies
// statusline.cjs (the wipe), then records root + options for assertions.
const FAKE_REFRESH = `import fs from 'node:fs';
import path from 'node:path';
export async function autoRefreshHelpersIfStale(root, opts) {
  const sl = path.join(root, '.claude', 'helpers', 'statusline.cjs');
  fs.writeFileSync(sl, ${JSON.stringify(HOST)});
  fs.writeFileSync(path.join(root, 'REFRESHED'), JSON.stringify({ root, opts }));
  return { refreshed: true };
}
`;

// A refresh that rejects: the child must exit 1 → refreshRufloHelpers false.
const THROWING_REFRESH = `export async function autoRefreshHelpersIfStale() {
  throw new Error('refresh exploded');
}
`;

// A refresh that hangs (keep-alive interval so the child can't drain its loop):
// the timeout must kill it → refreshRufloHelpers false.
const HANGING_REFRESH = `export function autoRefreshHelpersIfStale() {
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}
`;

// A BLOCKED refresh: upstream's signed-manifest gate refuses to copy and
// RESOLVES {blocked} rather than rejecting — must still surface as false.
const BLOCKED_REFRESH = `export async function autoRefreshHelpersIfStale() {
  return { refreshed: false, blocked: 'helpers manifest signature invalid' };
}
`;

const REFRESH_BODIES = { faithful: FAKE_REFRESH, throws: THROWING_REFRESH, hangs: HANGING_REFRESH, blocked: BLOCKED_REFRESH };

function fixture({ cliVersion = '3.32.7', stamp, refreshModule } = {}) {
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
      fs.writeFileSync(path.join(cli, 'dist', 'src', 'init', 'helper-refresh.js'),
        REFRESH_BODIES[refreshModule]);
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

test('a v-prefixed stamp matching the CLI is NOT stale (no permanent false-arm)', () => {
  // Unstripped, 'v3.32.7' goes NaN in the compare and reads stale FOREVER —
  // arming a pointless refresh on every status/sync. Pinned so it stays fixed.
  const { proj } = fixture({ cliVersion: '3.32.7', stamp: 'v3.32.7' });
  assert.equal(helperStampStale(proj), false);
});

test('an empty stamp file is stale (self-correcting: the refresh rewrites it)', () => {
  const { proj } = fixture({ cliVersion: '3.32.7', stamp: '' });
  assert.equal(helperStampStale(proj), true);
});

test('a garbage stamp is stale by design (one refresh converges it, not sticky)', () => {
  const { proj } = fixture({ cliVersion: '3.32.7', stamp: 'not-a-version' });
  assert.equal(helperStampStale(proj), true);
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
  const { proj } = fixture({});
  assert.equal(refreshRufloHelpers(proj), false);
});

test('invokes ruflo refresh with the project root and alsoRefreshGlobal', () => {
  const { proj } = fixture({ refreshModule: 'faithful' });
  assert.equal(refreshRufloHelpers(proj), true);
  const rec = JSON.parse(fs.readFileSync(path.join(proj, 'REFRESHED'), 'utf8'));
  assert.equal(rec.root, proj);
  assert.equal(rec.opts.alsoRefreshGlobal, true);
});

test('a rejecting refresh returns false — true means it RAN, not that a child spawned', () => {
  const { proj } = fixture({ refreshModule: 'throws' });
  assert.equal(refreshRufloHelpers(proj), false);
});

test('a hung refresh is killed by the timeout and returns false', () => {
  const { proj } = fixture({ refreshModule: 'hangs' });
  assert.equal(refreshRufloHelpers(proj, { timeoutMs: 1000 }), false);
});

test('a BLOCKED refresh (signature gate resolved {blocked}) returns false', () => {
  // Upstream resolves — not rejects — when the Ed25519 manifest gate refuses
  // to copy. "true" must mean ran-unblocked, or a tampered install would read
  // as a successful heal while nothing was written.
  const { proj } = fixture({ refreshModule: 'blocked' });
  assert.equal(refreshRufloHelpers(proj), false);
});

// --- fixStatusline ordering: refresh BEFORE inject; dryRun stays read-only -----

test('refresh-then-inject: footer survives the wipe the refresh performs', () => {
  // The faithful fake WIPES statusline.cjs when it runs. Only the correct
  // ordering (refresh first, inject second) leaves the footer present; an
  // inject-then-refresh regression ends with a pristine file and FAILS here.
  const { proj, sl } = fixture({ refreshModule: 'faithful' });
  fixStatusline(proj);
  assert.ok(fs.existsSync(path.join(proj, 'REFRESHED')), 'refresh must have run');
  assert.match(fs.readFileSync(sl, 'utf8'), /ruflo-seg:BEGIN/);
});

test('dryRun never triggers the refresh (status stays read-only)', () => {
  const { proj } = fixture({ refreshModule: 'faithful' });
  fixStatusline(proj, { dryRun: true });
  assert.equal(fs.existsSync(path.join(proj, 'REFRESHED')), false);
});
