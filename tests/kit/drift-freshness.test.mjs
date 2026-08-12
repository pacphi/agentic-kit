// #134 — sync must not let the version-drift TTL cache hide an available
// upgrade, and a failed forced fetch must never clobber good cached data.
// #135's solver contract lives in heal-natives.test.mjs; this file owns the
// drift-report resilience contract and the sync plan-freshness contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, captureLog, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-drift-fresh');
const paths = await import('../../src/lib/paths.mjs');
const { driftReport } = await import('../../src/lib/versions.mjs');
const sync = await import('../../src/commands/sync.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = sandboxProject('ak-drift-fresh');
const FLAGS = (over = {}) => ({ 'dry-run': false, 'no-upgrade': false, json: false, ...over });

/** kit.json with an explicit versionCheck state; global root has ruflo+aqe fixtures. */
function seedHome({ last, seen, ruflo = '9.9.9' }) {
  rmrf(paths.claudeDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  const cfg = offlineKitConfig();
  cfg.versionCheck = { ttlHours: 24, last, seen, self: cfg.versionCheck.self };
  writeKitConfig(HOME, cfg);
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo, 'agentic-qe': '9.9.9' }));
}

const inSandboxProject = async (fn) => {
  const cwd = process.cwd();
  process.chdir(PROJECT);
  try { return await fn(); } finally { process.chdir(cwd); }
};

test('a failed forced fetch falls back to the cached seen values instead of nulling them', async () => {
  seedHome({ last: 1, seen: { ruflo: '9.9.10', 'agentic-qe': '9.9.9' } }); // stale cache, good data
  const report = await driftReport({ force: true, fetchLatest: async () => null }); // npm down

  const ruflo = report.find((r) => r.pkg === 'ruflo');
  assert.equal(ruflo.latest, '9.9.10', 'cached seen survives a failed fetch');
  assert.equal(ruflo.outdated, true, '9.9.10 > installed 9.9.9 still detected');
});

test('a fully-failed forced fetch neither clobbers seen nor stamps last (TTL retries promptly)', async () => {
  seedHome({ last: 1, seen: { ruflo: '9.9.10', 'agentic-qe': '9.9.9' } });
  await driftReport({ force: true, fetchLatest: async () => null });

  const after = loadKitConfig().versionCheck;
  assert.equal(after.seen.ruflo, '9.9.10', 'seen preserved on total failure');
  assert.equal(after.last, 1, 'last not stamped — the next call must retry, not trust a failed probe');
});

test('a successful forced fetch updates seen, stamps last, and reports drift', async () => {
  seedHome({ last: Date.now(), seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9' } }); // FRESH but wrong
  const report = await driftReport({ force: true, fetchLatest: async (pkg) => (pkg === 'ruflo' ? '9.9.11' : '9.9.9') });

  assert.equal(report.find((r) => r.pkg === 'ruflo').outdated, true);
  const after = loadKitConfig().versionCheck;
  assert.equal(after.seen.ruflo, '9.9.11');
  assert.ok(after.last > 1, 'last stamped on success');
});

test('a STALE cache with newer seen data reaches the sync plan even when npm is unreachable', async () => {
  // The collect() path: last=0 forces a refetch; offline that refetch fails.
  // Resilient fallback must keep 9.9.10 visible so the plan includes the upgrade.
  seedHome({ last: 0, seen: { ruflo: '9.9.10', 'agentic-qe': '9.9.9' } });
  const { result, out } = await inSandboxProject(() =>
    captureLog(() => sync.run({ flags: FLAGS({ 'dry-run': true }), pkgRoot: PKG_ROOT })));

  assert.equal(result, 0);
  assert.match(out, /\[versions\].*ruflo 9\.9\.9 installed, 9\.9\.10 available/,
    'the plan must surface the upgrade the cache already knows about');
});

test('sync (non-dry) force-refreshes drift BEFORE building the plan, so a fresh-but-wrong cache cannot hide an upgrade', async () => {
  seedHome({ last: Date.now(), seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9' } }); // fresh cache: "all current"
  const { out } = await inSandboxProject(() =>
    captureLog(() => sync.run({
      flags: FLAGS(), pkgRoot: PKG_ROOT,
      fetchLatest: async (pkg) => (pkg === 'ruflo' ? '9.9.12' : '9.9.9'), // npm knows better
    })));

  assert.match(out, /\[versions\].*ruflo 9\.9\.9 installed, 9\.9\.12 available/,
    'plan must be built from a forced refresh, not the stale-fresh cache');
});
