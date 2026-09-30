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

test('a missing KB cannot inherit a stale installed release or eternal hold from the surviving plugin', async () => {
  const kb = path.join(home, 'missing-kb');
  process.env.RUVNET_BRAIN_KB = kb;
  fs.mkdirSync(path.join(paths.claudeDir(), 'plugins', 'cache', 'ruvnet-brain'), { recursive: true });
  writeKitConfig(home, { versionCheck: { ttlHours: 24, ruvnetBrain: {
    installedRelease: '4.3.22', last: Date.now(), latest: '4.3.28', releaseAssetAvailable: true,
    heldRefresh: { ...hold, at: Date.now() },
  } } });
  const absent = await brain.drift({ cacheOnly: true });
  assert.equal(absent.kbState, 'missing');
  assert.equal(absent.installedRelease, null, 'a remembered release is not a release on disk');
  const actionable = brainReleaseRow(absent);
  assert.match(actionable.message, /KB missing/i);
  assert.equal(actionable.repair, 'sync');
  brain.recordHeldRefresh({ latest: '4.3.28', detail: 'fresh install also refused' });
  assert.equal(brainReleaseRow(await brain.drift({ cacheOnly: true })).repair, 'manual',
    'a missing-KB refusal must still bound the next attempt');
});

test('unreadable KB evidence stays unknown and does not become an automatic install', async (t) => {
  const kb = path.join(home, 'unreadable-kb');
  process.env.RUVNET_BRAIN_KB = kb;
  writeKitConfig(home, { versionCheck: { ttlHours: 24, ruvnetBrain: {
    installedRelease: '4.3.22', last: Date.now(), latest: '4.3.22', releaseAssetAvailable: true,
  } } });
  const original = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    if (file === path.join(kb, 'forge-mcp-all.mjs')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(file, ...args);
  });
  const b = await brain.drift({ cacheOnly: true });
  assert.equal(b.kbState, 'unknown');
  assert.equal(b.installedRelease, '4.3.22', 'an access error must not erase remembered state');
  const row = brainReleaseRow(b);
  assert.equal(row.level, 'warn');
  assert.equal(row.repair, 'manual');
  assert.match(row.message, /entrypoint.*unavailable/i);
});

test('missing KB state cannot bypass an absent or unverified release asset', () => {
  for (const releaseAssetAvailable of [false, null]) {
    const row = brainReleaseRow({ present: true, kbState: 'missing', installedRelease: null,
      latest: '4.3.28', outdated: true, releaseAssetAvailable });
    assert.equal(row.fix, null);
    assert.match(row.message, /KB missing/);
  }
});

test('readable entrypoint metadata cannot hide denied file access', async (t) => {
  const kb = path.join(home, 'denied-read-kb');
  process.env.RUVNET_BRAIN_KB = kb;
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, 'forge-mcp-all.mjs'), '');
  writeKitConfig(home, { versionCheck: { ruvnetBrain: {
    installedRelease: '4.3.22', last: Date.now(), latest: '4.3.28', releaseAssetAvailable: true,
  } } });
  const original = fs.accessSync;
  t.mock.method(fs, 'accessSync', (file, ...args) => {
    if (file === path.join(kb, 'forge-mcp-all.mjs')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(file, ...args);
  });
  const b = await brain.drift({ cacheOnly: true });
  assert.equal(b.kbState, 'unknown');
  assert.equal(brainReleaseRow(b).repair, 'manual');
});
