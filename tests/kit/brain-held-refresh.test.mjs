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
  assert.equal(blocked.fix, null, 'sync must not re-run a refused refresh');
  assert.match(blocked.message, /v4\.3\.28/);
  assert.match(blocked.message, /private overlay preflight failed/);
  assert.match(blocked.message, /npx ruvnet-brain --update/);
  assert.match(blocked.message, /"ruvnetBrain": false/);

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
