// ADR-0010: the Limits panel's /api/limits route must ask
// Codex for its quota ONLY when Codex is known to be present — never as a
// side effect of merely opening the dashboard. `readLimits` (quota.mjs) now
// gates the app-server spawn on `recordedHostPresence('codex')`
// (providers.mjs), which reads the LAST `host-setup` evidence `detectHosts`
// already records for every host — managed or not — on each `/api/status`
// poll. It performs no probe of its own: absent, stale (> 6h) or
// PATH-invalidated evidence reads as 'unconfirmed', not 'not-found', and
// either non-'found' outcome must produce zero spawns.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome } from './helpers/home-sandbox.mjs';

// paths.mjs snapshots os.homedir() at module scope, so the redirect must
// happen before any kit module is ever imported (home-sandbox.mjs contract).
const home = sandboxHome('ak-quota-presence');

const { HOSTS, hostSetupInputsKey } = await import('../../src/lib/providers.mjs');
const { writeEvidence, evidenceFile } = await import('../../src/lib/evidence.mjs');
const { readLimits, CODEX_TTL_MS } = await import('../../src/lib/quota.mjs');

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const codexHost = HOSTS.find((h) => h.id === 'codex');
const NOW = Date.UTC(2026, 8, 28);
const cacheFile = path.join(home, 'codex-cache.json');
const claudeFile = path.join(home, 'claude-limits.json');
const claudeSettingsFile = path.join(home, 'claude-settings.json');

beforeEach(() => {
  fs.rmSync(evidenceFile('host-setup', 'codex'), { force: true });
  fs.rmSync(cacheFile, { force: true });
});

/** Seed the same `host-setup` evidence `detectHosts` would have written. */
function seedCodexPresence(present, { now = NOW, pathValue } = {}) {
  const env = { PATH: pathValue ?? process.env.PATH ?? '' };
  writeEvidence('host-setup', 'codex', {
    source: 'status',
    inputsKey: hostSetupInputsKey(codexHost, env),
    inputs: { PATH: env.PATH, bin: codexHost.bin },
    result: { present },
  }, { now });
}

const CACHE_FIXTURE = (fetchedAt) => ({
  provider: 'codex', fetchedAt, planType: 'plus',
  lanes: [{ id: 'codex', name: 'codex', windows: [{ id: 'codex:10080', label: 'weekly', usedPercent: 12, windowMinutes: 10080, resetsAt: 123 }] }],
  resetCredits: null,
});
const writeCache = (fetchedAt) => fs.writeFileSync(cacheFile, JSON.stringify(CACHE_FIXTURE(fetchedAt)));

/** A spawnImpl that records every call and always fails (spawn-failed) —
 *  enough to prove whether app-server was invoked at all, never a real one. */
function spawnSpy() {
  const calls = [];
  const impl = (...args) => { calls.push(args); throw new Error('spawn must never reach a real process in this test'); };
  return { calls, impl };
}

const callLimits = (extra = {}) => readLimits({
  now: NOW, claudeFile, claudeSettingsFile, claudeManagedSettingsFile: null,
  codexCacheFile: cacheFile, ...extra,
});

test('found Codex, stale cache: one app-server call', async () => {
  seedCodexPresence(true);
  writeCache(NOW - CODEX_TTL_MS - 1);
  const spy = spawnSpy();
  const r = await callLimits({ spawnImpl: spy.impl });
  assert.equal(spy.calls.length, 1, 'presence found + stale cache must ask codex exactly once');
  assert.equal(spy.calls[0][0], 'codex');
  assert.deepEqual(spy.calls[0][1], ['-s', 'read-only', '-a', 'never', 'app-server']);
  assert.deepEqual(r.codexUnavailable, { reason: 'spawn-failed' });
});

test('not found: no spawn, host-not-found, cached figure still served', async () => {
  seedCodexPresence(false);
  writeCache(NOW - 1000);
  const cacheRaw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const spy = spawnSpy();
  const r = await callLimits({ spawnImpl: spy.impl });
  assert.equal(spy.calls.length, 0, 'presence not-found must never spawn');
  assert.deepEqual(r.codexUnavailable, { reason: 'host-not-found' });
  assert.deepEqual(r.codex, cacheRaw, 'the last cached figure is still served, unchanged');
});

test('no evidence: no spawn, host-unconfirmed', async () => {
  const spy = spawnSpy();
  const r = await callLimits({ spawnImpl: spy.impl });
  assert.equal(spy.calls.length, 0, 'no host-setup evidence at all must never spawn');
  assert.deepEqual(r.codexUnavailable, { reason: 'host-unconfirmed' });
});

test('evidence older than 6 h: no spawn, host-unconfirmed', async () => {
  seedCodexPresence(true, { now: NOW });
  const spy = spawnSpy();
  const r = await callLimits({ spawnImpl: spy.impl, now: NOW + 6 * 3600_000 + 1 });
  assert.equal(spy.calls.length, 0, 'evidence older than the 6h window must not authorize a spawn');
  assert.deepEqual(r.codexUnavailable, { reason: 'host-unconfirmed' });
});

test('evidence recorded under another PATH: no spawn, host-unconfirmed', async () => {
  seedCodexPresence(true);
  const prevPath = process.env.PATH;
  process.env.PATH = path.join(home, 'a-completely-different-path-dir');
  const spy = spawnSpy();
  try {
    const r = await callLimits({ spawnImpl: spy.impl });
    assert.equal(spy.calls.length, 0, 'a PATH change invalidates the cached inputsKey and must not authorize a spawn');
    assert.deepEqual(r.codexUnavailable, { reason: 'host-unconfirmed' });
  } finally {
    process.env.PATH = prevPath;
  }
});

test('found but unmanaged (kit.json hosts.codex false): still asked', async () => {
  seedCodexPresence(true);
  const spy = spawnSpy();
  // ADR-0010: presence, not kit.json management state, decides. enabledHosts
  // only drives the F-10 "others" labeling — readLimits reads no kit.json.
  const r = await callLimits({ spawnImpl: spy.impl, enabledHosts: { codex: false } });
  assert.equal(spy.calls.length, 1, 'an unmanaged-but-present codex is still asked for its quota');
  assert.deepEqual(r.codexUnavailable, { reason: 'spawn-failed' });
});

test('found, fresh cache: no spawn (existing TTL)', async () => {
  seedCodexPresence(true);
  writeCache(NOW - 1);
  const spy = spawnSpy();
  const r = await callLimits({ spawnImpl: spy.impl });
  assert.equal(spy.calls.length, 0, 'a fresh cache must still short-circuit the spawn, unchanged by this task');
  assert.equal(r.codexUnavailable, null);
  assert.equal(r.codex.fetchedAt, NOW - 1);
});
