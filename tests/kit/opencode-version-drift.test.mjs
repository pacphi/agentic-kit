// Managed-version contract for `opencode-ai` (the third host's npm package).
// driftReport keeps a frontier-host CLI current only when it is NPM-managed:
// an npm global package.json exists. External installs (mise/native/brew) have
// none → filtered out, so ak never claims to own an update it cannot apply —
// and the dashboard's update banner never fabricates one either.
// Hermetic: sandboxed HOME, faked npm global root, fresh versionCheck cache
// (no `npm view` ever spawns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sandboxHome, assertSandboxed, rmrf, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-oc-drift');
const paths = await import('../../src/lib/paths.mjs');
const { driftReport } = await import('../../src/lib/versions.mjs');
assertSandboxed(paths, HOME);

function seed(seen, pkgs) {
  rmrf(paths.configDir());
  writeKitConfig(HOME, offlineKitConfig({
    versionCheck: { ttlHours: 24, last: Date.now(), seen: { ruflo: '9.9.9', 'agentic-qe': '9.9.9', ...seen } },
  }));
  paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9', ...pkgs }));
}

const rowFor = (report, pkg) => report.find((r) => r.pkg === pkg);

test('npm-managed opencode-ai, current: reported installed, not outdated', async () => {
  seed({ 'opencode-ai': '1.2.3' }, { 'opencode-ai': '1.2.3' });
  const row = rowFor(await driftReport(), 'opencode-ai');
  assert.ok(row, 'an npm-managed opencode-ai is tracked');
  assert.equal(row.installed, '1.2.3');
  assert.equal(row.latest, '1.2.3');
  assert.equal(row.outdated, false, 'current install is not drift');
});

test('npm-managed opencode-ai, outdated: reported as drift (the update banner input)', async () => {
  seed({ 'opencode-ai': '1.3.0' }, { 'opencode-ai': '1.2.3' });
  const row = rowFor(await driftReport(), 'opencode-ai');
  assert.ok(row);
  assert.equal(row.installed, '1.2.3');
  assert.equal(row.latest, '1.3.0');
  assert.equal(row.outdated, true, 'a newer npm release is update drift ak owns');
});

test('external (non-npm) opencode install: no row at all — ak never claims to own its update', async () => {
  // opencode on PATH but no npm global package.json → not in the fake root.
  seed({}, {});
  const row = rowFor(await driftReport(), 'opencode-ai');
  assert.equal(row, undefined, 'external installs are not fabricated into npm-managed drift');
  // Sanity: the always-managed packages still report.
  assert.ok(rowFor(await driftReport(), 'ruflo'), 'the managed set itself is unaffected');
});

test.after(() => rmrf(HOME));
