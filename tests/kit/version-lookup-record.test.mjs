// The version lookups behind `ak status`, `ak status --refresh` and `ak sync`
// (ADR-0063, "The `record` parameter"):
// - `record: false` looks the version up and reports it without saving kit.json
//   (`ak sync --dry-run`'s preview).
// - A failed lookup never erases a good one: when the Brain's GitHub release
//   or ruvector's npm lookup answers nothing, or every npm lookup of the
//   managed packages (driftReport) or of the kit itself (selfDrift) does, the
//   recorded latest (and the Brain's asset fact) stays in kit.json and the
//   drift reports it as a cache fallback. `last` is restamped: retried once per
//   TTL window (`force` retries sooner), so an offline `ak status` or dashboard
//   poll does not wait on the lookup every time. `observedAt` keeps when the
//   recorded latest was actually seen, so no label claims the failed attempt
//   observed it. `record: false` and a cache-only read never write.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sandboxHome, assertSandboxed, rmrf, writeKitConfig, offlineKitConfig, fakeGlobalRoot, captureLog,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-version-lookup-record');
const paths = await import('../../src/lib/paths.mjs');
const { driftReport, selfDrift, KIT_PKG } = await import('../../src/lib/versions.mjs');
const brain = await import('../../src/lib/ruvnet-brain.mjs');
const ruvector = await import('../../src/lib/ruvector.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);

const KB = path.join(HOME, 'brain-kb');
const PKG_ROOT = path.join(HOME, 'installed-kit');
const savedKb = process.env.RUVNET_BRAIN_KB;
process.env.RUVNET_BRAIN_KB = KB;
// No real network: a Brain lookup that ignored its injected fetchImpl would
// reach GitHub; here it fails instead.
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('the real network was reached (test)'); };
after(() => {
  if (savedKb === undefined) delete process.env.RUVNET_BRAIN_KB; else process.env.RUVNET_BRAIN_KB = savedKb;
  globalThis.fetch = savedFetch;
  rmrf(HOME);
});

const HOUR = 3600_000;
const STALE = Date.now() - 48 * HOUR;
const kitJsonText = () => fs.readFileSync(paths.kitConfigPath(), 'utf8');

/** kit.json with every version record stamped `last`; an installed ruflo,
 *  agentic-qe, ruvector 1.2.0, kit 4.0.0 and Brain release 4.3.22. */
function seed(last = STALE) {
  const cfg = offlineKitConfig();
  cfg.versionCheck = {
    ttlHours: 24, last, seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9' },
    self: { last, best: { version: '4.0.0', tag: 'latest' } },
    ruvnetBrain: { last, latest: '4.3.28', releaseAssetAvailable: true, installedRelease: '4.3.22' },
    ruvector: { last, latest: '1.5.0' },
  };
  writeKitConfig(HOME, cfg);
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9', ruvector: '1.2.0' }));
  fs.mkdirSync(PKG_ROOT, { recursive: true });
  fs.writeFileSync(path.join(PKG_ROOT, 'package.json'), JSON.stringify({ name: KIT_PKG, version: '4.0.0' }));
  rmrf(KB);
  fs.mkdirSync(KB, { recursive: true });
  fs.writeFileSync(path.join(KB, 'forge-mcp-all.mjs'), '');
}

const release = (tag) => async () => ({
  ok: true, json: async () => ({ tag_name: tag, assets: [{ name: 'ruvnet-brain.zip', browser_download_url: 'x' }] }),
});
const failingFetch = async () => { throw new Error('offline (test)'); };
const rateLimited = async () => ({ ok: false, json: async () => ({}) });

// ── record: false ────────────────────────────────────────────────────────────

test('driftReport and selfDrift with record:false report a live answer and save nothing', async () => {
  seed(Date.now());
  const before = kitJsonText();
  const drift = await driftReport({ force: true, record: false, fetchLatest: async () => '9.9.10' });
  assert.deepEqual(drift.map((r) => [r.pkg, r.latest, r.latestSource, r.outdated]),
    [['ruflo', '9.9.10', 'live', true], ['agentic-qe', '9.9.10', 'live', true]]);
  const self = await selfDrift({ pkgRoot: PKG_ROOT, force: true, record: false, fetchLatest: async () => '4.1.0' });
  assert.deepEqual([self.latest, self.outdated], ['4.1.0', true]);
  assert.equal(kitJsonText(), before);
});

test('the Brain drift with record:false reports the release it fetched and saves nothing', async () => {
  seed(Date.now());
  const before = kitJsonText();
  const d = await brain.drift({ force: true, record: false, fetchImpl: release('v4.3.29') });
  assert.deepEqual([d.latest, d.releaseAssetAvailable, d.latestSource, d.outdated], ['4.3.29', true, 'live', true]);
  assert.equal(kitJsonText(), before);
});

test('ruvector drift with record:false reports the version it fetched and saves nothing', async () => {
  seed(Date.now());
  const before = kitJsonText();
  const d = await ruvector.drift({ force: true, record: false, fetchLatest: async () => '1.6.0' });
  assert.deepEqual([d.installed, d.latest, d.latestSource, d.outdated], ['1.2.0', '1.6.0', 'live', true]);
  assert.equal(kitJsonText(), before);
});

test('a successful lookup is still recorded by default', async () => {
  seed();
  const b = await brain.drift({ force: true, fetchImpl: release('v4.3.29') });
  const r = await ruvector.drift({ force: true, fetchLatest: async () => '1.6.0' });
  assert.equal(b.latest, '4.3.29');
  assert.equal(r.latest, '1.6.0');
  const saved = loadKitConfig().versionCheck;
  assert.equal(saved.ruvnetBrain.latest, '4.3.29');
  assert.equal(saved.ruvnetBrain.installedRelease, '4.3.22', 'the install record survives the cache write');
  assert.ok(saved.ruvnetBrain.last > STALE);
  assert.equal(saved.ruvnetBrain.observedAt, saved.ruvnetBrain.last, 'a successful lookup is an observation');
  assert.equal(saved.ruvector.latest, '1.6.0');
  assert.ok(saved.ruvector.last > STALE);
  assert.equal(saved.ruvector.observedAt, saved.ruvector.last);
});

/** Remove the Brain and ruvector records, as on a machine that never looked them up. */
function dropRecords() {
  const cfg = loadKitConfig();
  delete cfg.versionCheck.ruvnetBrain;
  delete cfg.versionCheck.ruvector;
  writeKitConfig(HOME, cfg);
}

// ── a failed lookup never erases a good one ──────────────────────────────────

for (const [name, fetchImpl] of [['a network failure', failingFetch], ['a refused request', rateLimited]]) {
  test(`a forced Brain lookup that fails (${name}) keeps the recorded release and restamps last`, async () => {
    seed();
    const d = await brain.drift({ force: true, fetchImpl });
    const saved = loadKitConfig().versionCheck.ruvnetBrain;
    assert.deepEqual([saved.latest, saved.releaseAssetAvailable, saved.installedRelease], ['4.3.28', true, '4.3.22'],
      "kit.json keeps the recorded latest, its asset fact and the install record");
    assert.ok(saved.last > STALE, 'last is restamped, so the next lookup waits one TTL window');
    assert.equal(saved.observedAt, STALE, 'when the recorded latest was actually seen');
    assert.deepEqual([d.latest, d.releaseAssetAvailable, d.latestSource, d.latestObservedAt, d.outdated],
      ['4.3.28', true, 'cache-fallback', STALE, true]);
  });
}

test('an expired Brain cache whose lookup fails is not retried within the TTL; force retries it', async () => {
  seed();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('offline (test)'); };
  await brain.drift({ fetchImpl });
  const d = await brain.drift({ fetchImpl });
  assert.equal(calls, 1, 'the restamped cache is fresh again');
  assert.deepEqual([d.latestSource, d.latest, d.latestObservedAt], ['cache', '4.3.28', STALE],
    'the label still names when the latest was observed, not the failed attempt');
  const forced = await brain.drift({ force: true, fetchImpl });
  assert.equal(calls, 2, '--refresh forces a retry');
  assert.equal(forced.latestObservedAt, STALE, 'a repeated failure carries the observation time forward');
  assert.equal(loadKitConfig().versionCheck.ruvnetBrain.observedAt, STALE);
});

test('a forced ruvector lookup that fails keeps the recorded latest and restamps last', async () => {
  seed();
  const d = await ruvector.drift({ force: true, fetchLatest: async () => null });
  const saved = loadKitConfig().versionCheck.ruvector;
  assert.equal(saved.latest, '1.5.0');
  assert.ok(saved.last > STALE);
  assert.equal(saved.observedAt, STALE);
  assert.deepEqual([d.installed, d.latest, d.latestSource, d.outdated], ['1.2.0', '1.5.0', 'cache-fallback', true]);
});

test('an expired ruvector cache whose lookup fails is not retried within the TTL; force retries it', async () => {
  seed();
  let calls = 0;
  const fetchLatest = async () => { calls += 1; return null; };
  await ruvector.drift({ fetchLatest });
  const d = await ruvector.drift({ fetchLatest });
  assert.equal(calls, 1);
  assert.deepEqual([d.latestSource, d.latest], ['cache', '1.5.0']);
  await ruvector.drift({ force: true, fetchLatest });
  assert.equal(calls, 2);
  assert.equal(loadKitConfig().versionCheck.ruvector.observedAt, STALE);
});

test('a failed lookup with record:false writes nothing, for the Brain and ruvector', async () => {
  seed();
  const before = kitJsonText();
  const b = await brain.drift({ force: true, record: false, fetchImpl: failingFetch });
  const r = await ruvector.drift({ force: true, record: false, fetchLatest: async () => null });
  assert.equal(kitJsonText(), before);
  assert.deepEqual([b.latest, b.latestSource, r.latest, r.latestSource], ['4.3.28', 'cache-fallback', '1.5.0', 'cache-fallback']);
});

test('a first failed lookup with nothing recorded writes only last', async () => {
  seed();
  dropRecords();
  await brain.drift({ fetchImpl: failingFetch });
  await ruvector.drift({ fetchLatest: async () => null });
  const saved = loadKitConfig().versionCheck;
  assert.deepEqual(Object.keys(saved.ruvnetBrain), ['last']);
  assert.deepEqual(Object.keys(saved.ruvector), ['last']);
});

// ── driftReport and selfDrift follow the same rule on a total failure ────────

test('an expired version cache whose every lookup fails keeps seen, restamps last, and waits one TTL window', async () => {
  seed();
  let calls = 0;
  const fetchLatest = async () => { calls += 1; return null; };
  const first = await driftReport({ fetchLatest });
  assert.equal(calls, 2, 'ruflo and agentic-qe were looked up');
  assert.deepEqual(first.map((r) => [r.pkg, r.latest, r.latestSource]),
    [['ruflo', '9.9.9', 'cache-fallback'], ['agentic-qe', '9.9.9', 'cache-fallback']]);
  const saved = loadKitConfig().versionCheck;
  assert.deepEqual(saved.seen, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }, 'the recorded versions stay');
  assert.ok(saved.last > STALE, 'last is restamped, so the next lookup waits one TTL window');
  assert.deepEqual(saved.observedAt, { ruflo: STALE, 'agentic-qe': STALE }, 'when the recorded versions were actually seen');
  const second = await driftReport({ fetchLatest });
  assert.equal(calls, 2, 'a plain call within the TTL makes no lookup');
  assert.deepEqual(second.map((r) => [r.latestSource, r.latestObservedAt]), [['cache', STALE], ['cache', STALE]],
    'the label still names when the versions were observed, not the failed attempt');
  await driftReport({ force: true, fetchLatest });
  assert.equal(calls, 4, 'force retries');
  assert.deepEqual(loadKitConfig().versionCheck.observedAt, { ruflo: STALE, 'agentic-qe': STALE });
});

test('an expired self cache whose every lookup fails keeps the recorded best, restamps last, and waits one TTL window', async () => {
  seed();
  let calls = 0;
  const fetchLatest = async () => { calls += 1; return null; };
  const first = await selfDrift({ pkgRoot: PKG_ROOT, fetchLatest });
  assert.equal(calls, 1, 'a stable install looks up latest only');
  assert.equal(first.latest, '4.0.0');
  const saved = loadKitConfig().versionCheck.self;
  assert.deepEqual(saved.best, { version: '4.0.0', tag: 'latest' });
  assert.ok(saved.last > STALE);
  assert.equal(saved.observedAt, STALE, 'when the recorded best was actually seen');
  assert.equal((await selfDrift({ pkgRoot: PKG_ROOT, fetchLatest })).latest, '4.0.0');
  assert.equal(calls, 1, 'a plain call within the TTL makes no lookup');
  await selfDrift({ pkgRoot: PKG_ROOT, force: true, fetchLatest });
  assert.equal(calls, 2, 'force retries');
  assert.equal(loadKitConfig().versionCheck.self.observedAt, STALE);
});

test('a successful self lookup records when it was observed', async () => {
  seed();
  await selfDrift({ pkgRoot: PKG_ROOT, force: true, fetchLatest: async () => '4.1.0' });
  const saved = loadKitConfig().versionCheck.self;
  assert.deepEqual(saved.best, { version: '4.1.0', tag: 'latest' });
  assert.equal(saved.observedAt, saved.last);
});

test('a total failure with record:false writes nothing, for driftReport and selfDrift', async () => {
  seed();
  const before = kitJsonText();
  const drift = await driftReport({ force: true, record: false, fetchLatest: async () => null });
  const self = await selfDrift({ pkgRoot: PKG_ROOT, force: true, record: false, fetchLatest: async () => null });
  assert.equal(kitJsonText(), before);
  assert.deepEqual(drift.map((r) => r.latestSource), ['cache-fallback', 'cache-fallback']);
  assert.equal(self.latest, '4.0.0');
});

test('driftReport and selfDrift with cacheOnly read the recorded versions with no lookup and no write', async () => {
  seed();
  const before = kitJsonText();
  const noLookup = async () => { throw new Error('cacheOnly must not look up'); };
  const drift = await driftReport({ cacheOnly: true, fetchLatest: noLookup });
  const self = await selfDrift({ pkgRoot: PKG_ROOT, cacheOnly: true, fetchLatest: noLookup });
  assert.equal(kitJsonText(), before);
  assert.deepEqual(drift.map((r) => [r.pkg, r.latest, r.latestSource]),
    [['ruflo', '9.9.9', 'cache-fallback'], ['agentic-qe', '9.9.9', 'cache-fallback']]);
  assert.equal(self.latest, '4.0.0');
});

test("after a restamp, a dry run's offline line still gives the age of the recorded versions", async () => {
  seed();
  await driftReport({ fetchLatest: async () => null });
  await selfDrift({ pkgRoot: PKG_ROOT, fetchLatest: async () => null });
  const { lookUpPlanVersions } = await import('../../src/commands/sync/plan-versions.mjs');
  const { out } = await captureLog(() => lookUpPlanVersions({
    flags: { 'dry-run': true }, pkgRoot: PKG_ROOT, fetchLatest: async () => null,
    releaseDatesRunner: async () => ({ code: 1, stdout: '', stderr: 'offline (test)' }),
  }));
  assert.match(out, /versions not checked online \(offline or timed out\); this plan uses the versions ak recorded 2d ago/, out);
});

test('ruvector drift with cacheOnly reads the recorded latest with no lookup and no write', async () => {
  seed();
  const before = kitJsonText();
  const d = await ruvector.drift({ cacheOnly: true, fetchLatest: async () => { throw new Error('cacheOnly must not look up'); } });
  assert.deepEqual([d.latest, d.latestSource], ['1.5.0', 'cache-fallback']);
  assert.equal(kitJsonText(), before);
  seed(Date.now());
  assert.equal((await ruvector.drift({ cacheOnly: true })).latestSource, 'cache', 'a fresh record is plain cache');
});
