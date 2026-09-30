import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, assertSandboxed, writeKitConfig, rmrf } from './helpers/home-sandbox.mjs';

const home = sandboxHome('ak-brain-recovery');
after(() => rmrf(home));
const paths = await import('../../src/lib/paths.mjs');
const brain = await import('../../src/lib/ruvnet-brain.mjs');
const { brainReleaseRow } = await import('../../src/commands/status/sections/ruvnet-brain.mjs');
assertSandboxed(paths, home);

const now = 1_800_000_000_000;
const hour = 3_600_000;
const hold = { installed: '4.3.22', latest: '4.3.28', detail: 'private overlay refusal', at: now };
const observation = { installedRelease: '4.3.22', latest: '4.3.28', heldRefresh: hold };

test('a held version pair permits a half-open retry at its configured TTL boundary', () => {
  const b = { ...observation, holdTtlHours: 6, heldRefresh: { ...hold, at: now - 6 * hour } };
  assert.equal(brain.activeHeldRefresh(b, { now }), null);
  assert.ok(brain.activeHeldRefresh({ ...b, heldRefresh: { ...b.heldRefresh, at: b.heldRefresh.at + 1 } }, { now }));
});

test('invalid TTL configuration falls back to a bounded default instead of expiring fresh refusals', () => {
  for (const holdTtlHours of [undefined, 0, -1, '1', {}, Symbol('ttl'), NaN, Infinity, 1e308]) {
    const b = { ...observation, holdTtlHours, heldRefresh: { ...hold, at: now - 23 * hour } };
    assert.ok(brain.activeHeldRefresh(b, { now }), String(holdTtlHours));
    assert.equal(brain.activeHeldRefresh({ ...b, heldRefresh: { ...hold, at: now - 24 * hour } }, { now }), null);
  }
});

test('missing, malformed and future hold times cannot block the same release pair forever', () => {
  for (const at of [undefined, null, 'yesterday', 0, -1, NaN, Infinity, now + 1]) {
    assert.equal(brain.activeHeldRefresh({ ...observation, heldRefresh: { ...hold, at } }, { now }), null, String(at));
  }
});

test('positive fractional TTL hours do not become a full-day hold', () => {
  const b = { ...observation, holdTtlHours: 1 / 7, heldRefresh: { ...hold, at: now - 720_000 } };
  assert.equal(brain.activeHeldRefresh(b, { now }), null);
});

test('an unusable current clock does not authorize a retry of a fresh refusal', () => {
  assert.equal(brain.activeHeldRefresh(observation, { now: NaN }), hold);
});

test('an expired hold becomes a sync repair while a newly recorded refusal stays manual', async () => {
  const kb = path.join(home, 'kb');
  process.env.RUVNET_BRAIN_KB = kb;
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '');
  fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ releaseTag: 'v4.3.22' }));
  writeKitConfig(home, { versionCheck: { ttlHours: 6,
    ruvnetBrain: { last: Date.now(), latest: '4.3.28', releaseAssetAvailable: true,
      heldRefresh: { ...hold, at: Date.now() - 7 * hour } } } });
  const configFile = path.join(paths.configDir(), 'kit.json');
  const before = fs.readFileSync(configFile);
  assert.equal(brainReleaseRow(await brain.drift({ cacheOnly: true })).repair, 'sync');
  assert.deepEqual(fs.readFileSync(configFile), before, 'a status read must preserve the stored refusal');
  brain.recordHeldRefresh({ latest: '4.3.28', detail: 'still refused' });
  assert.equal(brainReleaseRow(await brain.drift({ cacheOnly: true })).repair, 'manual');
});
