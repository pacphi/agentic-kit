// B-deps D3 (#237 comments): when the Brain installer or its updater REFUSES a
// refresh (a private-overlay preflight, a stale updater's walker bug) the cause
// is upstream, yet status kept `fix: 'sync refreshes the KB'`, so every sync
// re-ran the refused refresh and failed again. A refused refresh is held as
// blocked — visible, with its cause and the user's options, but not planned —
// until the (installed, latest) release pair changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, assertSandboxed, writeKitConfig, rmrf } from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-brain-held');
const paths = await import('../../src/lib/paths.mjs');
const { installRuvnetBrain } = await import('../../src/lib/heal.mjs');
const brain = await import('../../src/lib/ruvnet-brain.mjs');
const { brainReleaseRow } = await import('../../src/commands/status/sections/ruvnet-brain.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);

const KB = path.join(HOME, 'brain-kb');
process.env.RUVNET_BRAIN_KB = KB;

function seedBrain({ release = '4.3.22', cache = {} } = {}) {
  rmrf(paths.configDir(), KB);
  fs.mkdirSync(KB, { recursive: true });
  fs.writeFileSync(path.join(KB, 'forge-mcp-all.mjs'), '');
  fs.writeFileSync(path.join(KB, 'SOURCE.json'), JSON.stringify({ releaseTag: `v${release}` }));
  writeKitConfig(HOME, {
    versionCheck: {
      ttlHours: 24, last: Date.now(), seen: {},
      ruvnetBrain: { last: Date.now(), latest: '4.3.28', releaseAssetAvailable: true, ...cache },
    },
  });
}

const REFUSAL = [
  '\u001b[31m✗ install stopped:\u001b[0m private overlay preflight failed: node_modules/.bin/semver: symbolic link is not a governed regular file — refusing to update.',
  '',
  "Nothing is left half-installed — fix the above and re-run the same command (it's safe to re-run).",
].join('\n');

async function refresh({ stderr = REFUSAL, code = 1, present = true, updater = present, disk = () => '4.3.22' } = {}) {
  const held = [];
  const r = await installRuvnetBrain({
    runner: async () => ({ code, stdout: '', stderr }),
    latestRelease: async () => ({ version: '4.3.28', releaseAssetAvailable: true }),
    present: () => present,
    updaterPresent: () => updater,
    releaseOnDisk: disk,
    recordRelease: () => {},
    recordRefusal: (refusal) => held.push(refusal),
  });
  return { r, held };
}

test('a refused refresh of an existing Brain is recorded with its cause and the latest release', async () => {
  const { r, held } = await refresh();
  assert.equal(r.ok, false);
  assert.equal(held.length, 1);
  assert.equal(held[0].latest, '4.3.28');
  assert.match(held[0].detail, /private overlay preflight failed/);
});

test('a transient failure or a first install is never held', async () => {
  const transient = await refresh({ stderr: 'npm error code ETIMEDOUT\nnpm error network request failed' });
  assert.equal(transient.held.length, 0, 'a network blip must be retried by the next sync');
  const first = await refresh({ present: false });
  assert.equal(first.held.length, 0, 'nothing installed means nothing to hold back');
});

test('an updater that ran without changing the release is held too', async () => {
  const { r, held } = await refresh({ code: 0, stderr: '' });
  assert.equal(r.status, 'degraded');
  assert.equal(held.length, 1, 'otherwise every sync re-runs a no-op updater');
  assert.match(held[0].detail, /still v4\.3\.22/);
});

test('status holds the refresh as blocked, names the cause and the options, until the pair changes', async () => {
  seedBrain();
  brain.recordHeldRefresh({ detail: 'install stopped: private overlay preflight failed', latest: '4.3.28' });
  const saved = loadKitConfig().versionCheck.ruvnetBrain.heldRefresh;
  assert.equal(saved.installed, '4.3.22', 'the installed side resolves disk-first, like drift()');
  assert.equal(saved.latest, '4.3.28');

  const blocked = brainReleaseRow(await brain.drift());
  assert.equal(blocked.level, 'warn');
  assert.equal(blocked.repair, 'manual', 'sync must not re-run a refused refresh; the options are the user\'s');
  assert.match(blocked.message, /v4\.3\.28/);
  assert.match(blocked.message, /private overlay preflight failed/);
  assert.match(blocked.fix, /npx ruvnet-brain --update/);
  assert.match(blocked.fix, /"ruvnetBrain": false/);

  const newer = brainReleaseRow({ ...(await brain.drift()), latest: '4.3.29' });
  assert.equal(newer.fix, 'sync refreshes the KB', 'a new release is a new attempt');
  fs.writeFileSync(path.join(KB, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v4.3.23' }));
  const moved = brainReleaseRow(await brain.drift());
  assert.equal(moved.fix, 'sync refreshes the KB', 'a changed install is a new attempt');
});

test('a successful install clears the held refresh', () => {
  seedBrain({ cache: { heldRefresh: { detail: 'x', installed: '4.3.22', latest: '4.3.28', at: 1 } } });
  brain.recordInstalledRelease('4.3.28');
  const cached = loadKitConfig().versionCheck.ruvnetBrain;
  assert.equal(cached.installedRelease, '4.3.28');
  assert.equal('heldRefresh' in cached, false);
});

// ADR-0061: forge-update's legacy-backup reclaim (issue #35) refuses to make
// another full-KB rollback copy while old kb.bak-*/kb.install-preserved-*
// snapshots remain. Verified 2026-09-27 that --update can never clear this —
// only npx ruvnet-brain --uninstall (which never touches those snapshots) then
// a fresh reinstall does. This is a *distinct* held refusal, not a new "held"
// mechanism: it must still be recorded, still block sync from retrying, and
// still clear on a real version change — only the offered `fix` text differs.
const RECLAIM_STUCK = [
  '  🧠  RuvNet Brain — refresh',
  '    [forge-update] ERROR: unresolved rollback state exists; refusing to create another full-KB copy.',
  '      kb.bak-2026-07-13T10-47-54-235Z: inventory is incomplete; refusing destructive reclaim',
  '  Restore or reconcile that copy first, then re-run.',
].join('\n');

test('a reclaim-stuck refusal is held exactly like any other refusal', async () => {
  const { r, held } = await refresh({ stderr: RECLAIM_STUCK });
  assert.equal(r.ok, false);
  assert.equal(held.length, 1);
  assert.equal(held[0].latest, '4.3.28');
  assert.match(held[0].detail, /unresolved rollback state exists/);
});

test('status gives a reclaim-stuck hold different, actionable remediation — and leaves every other hold alone', async () => {
  seedBrain();
  brain.recordHeldRefresh({
    detail: '[forge-update] ERROR: unresolved rollback state exists; refusing to create another full-KB copy.',
    latest: '4.3.28',
  });
  const stuck = brainReleaseRow(await brain.drift());
  assert.equal(stuck.level, 'warn');
  assert.equal(stuck.repair, 'manual', 'still never auto-run — a forced fresh install can itself be '
    + 'refused for a Brain with private stores, after downloading the whole bundle (#237 §4)');
  assert.match(stuck.fix, /npx ruvnet-brain --uninstall/);
  assert.match(stuck.fix, /ak sync/);
  assert.match(stuck.fix, /ruvnet-brain#335/);
  assert.doesNotMatch(stuck.fix, /fix the cause, then run `npx ruvnet-brain --update`/,
    'that instruction sends the user back into the exact same refusal forever');

  // Regression guard: an ordinary (non-reclaim) held refusal is completely unaffected.
  seedBrain();
  brain.recordHeldRefresh({ detail: 'install stopped: private overlay preflight failed', latest: '4.3.28' });
  const ordinary = brainReleaseRow(await brain.drift());
  assert.match(ordinary.fix, /npx ruvnet-brain --update/);
  assert.doesNotMatch(ordinary.fix, /--uninstall/);
});

test('after --uninstall, ak\'s existing install routing already takes the fresh path — no new logic needed', async () => {
  // updaterPresent() is false once kb/forge-update.mjs is gone (that's what
  // --uninstall removes); present() stays true (the plugin cache survives).
  // installRuvnetBrain must fall to the pinned --force --version fresh-install
  // branch, and a successful run must clear the hold, exactly as ADR-0061 §5 says.
  const calls = [];
  const r = await installRuvnetBrain({
    runner: async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: '', stderr: '' }; },
    latestRelease: async () => ({ version: '4.3.29', releaseAssetAvailable: true }),
    present: () => true,
    updaterPresent: () => false,
    releaseOnDisk: () => '4.3.29',
    recordRelease: () => {},
    recordRefusal: () => { throw new Error('a successful fresh install must not be held'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('--force'), 'a present install without an updater is a forced reinstall');
  assert.ok(calls[0].args.includes('--version'), 'pinned to the resolved tag, never a bare latest');
});
