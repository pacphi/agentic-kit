// Task 6 (Branch 6a refactor/evidence-store): `ak status --refresh` had no
// effect on version-drift rows because four sections silently dropped the
// `refresh` key their shared collect() ctx already carries. The four
// libraries (versions.mjs/ruvector.mjs/ruvnet-brain.mjs's driftReport/
// selfDrift/ruvectorDrift/ruvnetBrainDrift) already have a correct TTL cache
// with a `force` parameter (see tests/kit/drift-freshness.test.mjs and
// tests/kit/sync-self-freshness.test.mjs for that library-level coverage);
// this file proves only the section-level wiring: refresh -> force.
//
// versions.mjs already accepted an injectable `drift` for testing (kept for
// that reason), so its section is proved by inspecting the call args.
// ruvector.mjs/self.mjs reach the network through `latestVersion` (spawns
// `npm view`); ruvnet-brain.mjs reaches it through the global `fetch`
// (mirrors the mocking approach already used in
// tests/kit/brain-held-refresh-sync.test.mjs). Both give a hermetic,
// deterministic signal — a call was attempted or it wasn't — without ever
// reaching a real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, rmrf, sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-drift-refresh');
const paths = await import('../../src/lib/paths.mjs');
const versionsSection = await import('../../src/commands/status/sections/versions.mjs');
const ruvectorSection = await import('../../src/commands/status/sections/ruvector.mjs');
const selfSection = await import('../../src/commands/status/sections/self.mjs');
const ruvnetBrainSection = await import('../../src/commands/status/sections/ruvnet-brain.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-drift-refresh');
const NO_BIN = path.join(HOME, 'no-such-bin'); // sandboxHome()'s own unreachable PATH

test.after(() => rmrf(HOME, PROJECT));

const HOUR = 3600_000;

/** A fake `npm` on PATH that logs its argv and answers a fixed, valid semver —
 *  so a forced `npm view` spawn is observable without any real network/npm. */
function fakeNpmBin() {
  const bin = fs.mkdtempSync(path.join(HOME, 'fakebin-npm-'));
  const log = path.join(bin, 'npm.log');
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "$*" >> "' + log + '"\necho "9.9.9"\n', { mode: 0o755 });
  }
  return { bin, log };
}

const npmCallCount = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0);

/** Run `fn` with a fake npm on PATH, restoring sandboxHome()'s own broken PATH after. */
async function withFakeNpm(fn) {
  const { bin, log } = fakeNpmBin();
  process.env.PATH = bin;
  try { await fn(log); } finally { process.env.PATH = NO_BIN; }
}

/** Run `fn` with globalThis.fetch mocked to a call counter that fails (so
 *  ruvnet-brain's latestRelease() falls back harmlessly), restoring fetch after. */
async function withMockedFetch(fn) {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('offline (test)'); };
  try { await fn(() => calls); } finally { globalThis.fetch = saved; }
}

// ── versions.mjs: refresh -> driftReport({ force }) via its injectable `drift` ──

test('versions section: refresh omitted calls the drift fetcher with force:false', async () => {
  const calls = [];
  const drift = async (opts) => { calls.push(opts); return []; };
  await versionsSection.default.collect({ drift, loadConfig: () => ({}), now: () => Date.now() });
  assert.deepEqual(calls, [{ force: false }]);
});

test('versions section: refresh:true calls the drift fetcher with force:true', async () => {
  const calls = [];
  const drift = async (opts) => { calls.push(opts); return []; };
  await versionsSection.default.collect({ drift, loadConfig: () => ({}), now: () => Date.now(), refresh: true });
  assert.deepEqual(calls, [{ force: true }]);
});
// "stale cache, refresh:false -> still calls" is already proved for driftReport
// itself in tests/kit/drift-freshness.test.mjs ("a STALE cache with newer seen
// data reaches the sync plan even when npm is unreachable"); not duplicated here.

// ── ruvector.mjs: refresh -> ruvectorDrift({ force }) ───────────────────────

/** kit.json + a registered, npm-installed ruvector, cache last stamped `ageMs` ago. */
function seedRuvectorHome({ ageMs = 0 } = {}) {
  const cfg = offlineKitConfig({
    versionCheck: {
      ttlHours: 24,
      last: Date.now(),
      seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9' },
      self: { last: Date.now(), best: { version: '0.0.1', tag: 'latest' } },
      ruvector: { last: Date.now() - ageMs, latest: '1.0.0' },
    },
  });
  writeKitConfig(HOME, cfg);
  fs.mkdirSync(path.dirname(paths.claudeUserMcpPath()), { recursive: true });
  fs.writeFileSync(paths.claudeUserMcpPath(),
    JSON.stringify({ mcpServers: { ruvector: { command: 'npx', args: ['-y', 'ruvector', 'mcp', 'start'] } } }));
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9', ruvector: '1.0.0' }));
  return loadKitConfig();
}

test('ruvector section: fresh cache, refresh omitted/false never spawns npm', {
  skip: process.platform === 'win32' ? 'POSIX shell fake npm' : false,
}, async () => {
  await withFakeNpm(async (log) => {
    const cfg = seedRuvectorHome({ ageMs: 0 });
    await ruvectorSection.default.collect({ cfg });
    assert.equal(npmCallCount(log), 0, 'fresh cache with no refresh must not spawn npm');
  });
  paths._setGlobalRootForTest(null);
});

test('ruvector section: fresh cache, refresh:true forces a live check (spawns npm)', {
  skip: process.platform === 'win32' ? 'POSIX shell fake npm' : false,
}, async () => {
  await withFakeNpm(async (log) => {
    const cfg = seedRuvectorHome({ ageMs: 0 });
    await ruvectorSection.default.collect({ cfg, refresh: true });
    assert.ok(npmCallCount(log) >= 1, 'refresh:true must force a live npm check even with a fresh cache');
  });
  paths._setGlobalRootForTest(null);
});

test('ruvector section: stale cache, refresh omitted still spawns npm (pre-existing TTL behavior)', {
  skip: process.platform === 'win32' ? 'POSIX shell fake npm' : false,
}, async () => {
  await withFakeNpm(async (log) => {
    const cfg = seedRuvectorHome({ ageMs: 25 * HOUR });
    await ruvectorSection.default.collect({ cfg });
    assert.ok(npmCallCount(log) >= 1, 'an expired cache must still re-check without needing --refresh');
  });
  paths._setGlobalRootForTest(null);
});

// ── self.mjs: refresh -> selfDrift({ force }) ───────────────────────────────

function seedSelfHome({ ageMs = 0 } = {}) {
  const cfg = offlineKitConfig({
    versionCheck: {
      ttlHours: 24,
      last: Date.now(),
      seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9' },
      self: { last: Date.now() - ageMs, best: { version: '0.0.1', tag: 'latest' }, lastTags: ['latest', 'next'] },
    },
  });
  writeKitConfig(HOME, cfg);
}

test('self section: fresh cache, refresh omitted/false never spawns npm', {
  skip: process.platform === 'win32' ? 'POSIX shell fake npm' : false,
}, async () => {
  await withFakeNpm(async (log) => {
    seedSelfHome({ ageMs: 0 });
    await selfSection.default.collect({ pkgRoot: PKG_ROOT });
    assert.equal(npmCallCount(log), 0, 'fresh self cache with no refresh must not spawn npm');
  });
});

test('self section: fresh cache, refresh:true forces a live check (spawns npm)', {
  skip: process.platform === 'win32' ? 'POSIX shell fake npm' : false,
}, async () => {
  await withFakeNpm(async (log) => {
    seedSelfHome({ ageMs: 0 });
    await selfSection.default.collect({ pkgRoot: PKG_ROOT, refresh: true });
    assert.ok(npmCallCount(log) >= 1, 'refresh:true must force a live self-version check even with a fresh cache');
  });
});

test('self section: stale cache, refresh omitted still spawns npm (pre-existing TTL behavior)', {
  skip: process.platform === 'win32' ? 'POSIX shell fake npm' : false,
}, async () => {
  await withFakeNpm(async (log) => {
    seedSelfHome({ ageMs: 25 * HOUR });
    await selfSection.default.collect({ pkgRoot: PKG_ROOT });
    assert.ok(npmCallCount(log) >= 1, 'an expired self cache must still re-check without needing --refresh');
  });
});

// ── ruvnet-brain.mjs: refresh -> ruvnetBrainDrift({ force }) ────────────────

function seedBrainHome({ ageMs = 0 } = {}) {
  const cfg = offlineKitConfig({
    ruvnetBrain: true,
    versionCheck: {
      ttlHours: 24,
      last: Date.now(),
      seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9' },
      self: { last: Date.now(), best: { version: '0.0.1', tag: 'latest' } },
      ruvnetBrain: { last: Date.now() - ageMs, latest: '3.3.1', releaseAssetAvailable: true },
    },
  });
  writeKitConfig(HOME, cfg);
  return loadKitConfig();
}

test('ruvnet-brain section: fresh cache, refresh omitted/false never calls fetch', async () => {
  await withMockedFetch(async (getCalls) => {
    const cfg = seedBrainHome({ ageMs: 0 });
    await ruvnetBrainSection.default.collect({ cfg });
    assert.equal(getCalls(), 0, 'fresh cache with no refresh must not reach the network');
  });
});

test('ruvnet-brain section: fresh cache, refresh:true forces a live check (calls fetch)', async () => {
  await withMockedFetch(async (getCalls) => {
    const cfg = seedBrainHome({ ageMs: 0 });
    await ruvnetBrainSection.default.collect({ cfg, refresh: true });
    assert.ok(getCalls() >= 1, 'refresh:true must force a live release check even with a fresh cache');
  });
});

test('ruvnet-brain section: stale cache, refresh omitted still calls fetch (pre-existing TTL behavior)', async () => {
  await withMockedFetch(async (getCalls) => {
    const cfg = seedBrainHome({ ageMs: 25 * HOUR });
    await ruvnetBrainSection.default.collect({ cfg });
    assert.ok(getCalls() >= 1, 'an expired Brain release cache must still re-check without needing --refresh');
  });
});
