// The version lookups behind `ak status`, `ak status --refresh` and `ak sync`
// (ADR-0063, "The `record` parameter"):
// - `record: false` looks the version up and reports it without saving kit.json
//   (`ak sync --dry-run`'s preview).
// - A failed lookup never erases a good one: when the Brain's GitHub release
//   or ruvector's npm lookup answers nothing, the recorded latest (and the
//   Brain's asset fact) stays in kit.json, `last` is not restamped so the next
//   call retries, and the drift reports the recorded value as a cache fallback.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, assertSandboxed, rmrf, writeKitConfig, offlineKitConfig, fakeGlobalRoot } from './helpers/home-sandbox.mjs';

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
  assert.equal(saved.ruvector.latest, '1.6.0');
  assert.ok(saved.ruvector.last > STALE);
});

// ── a failed lookup never erases a good one ──────────────────────────────────

for (const [name, fetchImpl] of [['a network failure', failingFetch], ['a refused request', rateLimited]]) {
  test(`a forced Brain lookup that fails (${name}) keeps the recorded release and does not restamp last`, async () => {
    seed();
    const before = kitJsonText();
    const d = await brain.drift({ force: true, fetchImpl });
    assert.equal(kitJsonText(), before, "kit.json's latest, asset fact and last are unchanged");
    assert.deepEqual([d.latest, d.releaseAssetAvailable, d.latestSource, d.latestObservedAt, d.outdated],
      ['4.3.28', true, 'cache-fallback', STALE, true]);
  });
}

test('an expired Brain cache whose lookup fails is retried on the next call', async () => {
  seed();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('offline (test)'); };
  await brain.drift({ fetchImpl });
  const d = await brain.drift({ fetchImpl });
  assert.equal(calls, 2, 'last was not restamped, so the cache stays expired');
  assert.equal(d.latest, '4.3.28');
  assert.equal(loadKitConfig().versionCheck.ruvnetBrain.last, STALE);
});

test('a forced ruvector lookup that fails keeps the recorded latest and does not restamp last', async () => {
  seed();
  const before = kitJsonText();
  const d = await ruvector.drift({ force: true, fetchLatest: async () => null });
  assert.equal(kitJsonText(), before);
  assert.deepEqual([d.installed, d.latest, d.latestSource, d.outdated], ['1.2.0', '1.5.0', 'cache-fallback', true]);
});

test('an expired ruvector cache whose lookup fails is retried on the next call', async () => {
  seed();
  let calls = 0;
  const fetchLatest = async () => { calls += 1; return null; };
  await ruvector.drift({ fetchLatest });
  await ruvector.drift({ fetchLatest });
  assert.equal(calls, 2);
  assert.equal(loadKitConfig().versionCheck.ruvector.last, STALE);
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
