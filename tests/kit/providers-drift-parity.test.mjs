// #129-shaped failure class, killed at the root: `ak status` must never
// re-derive its own opinion of "is the provider config drifted" — it must
// read the SAME answer the writer (applyHosts/applyAqeRouter) would compute.
// Before this refactor, the status section hand-mirrored a chain-order
// comparison (providers-status.mjs's old `routerDrift`) separately from the
// writer's own reconciler fold; the two could disagree. Now both paths call
// providers.mjs's aqeRouterDrift/providerEnvDrift, which run the writer's
// OWN dry-run fold. This test proves the two sides agree by importing both
// and comparing them directly, for a fixture with INDUCED drift — so a
// future edit that reintroduces a second, independently-derived comparison
// fails here immediately rather than shipping a silent divergence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-provider-drift-parity');
const paths = await import('../../src/lib/paths.mjs');
const status = await import('../../src/commands/status.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const {
  applyAqeRouter, aqeRouterDrift, settingsTarget, managedEnv, aqeRouterFile,
} = await import('../../src/lib/providers.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));

const CHAIN_CFG = () => offlineKitConfig({
  integrations: { hosts: { claude: true, codex: true } },
  routing: { version: 1, primaryHost: 'claude', routes: {} },
  providers: { aqeProvider: null, aqeFallback: [{ provider: 'claude-code', models: ['claude-opus-5'] }] },
});

function seedHome(cfg) {
  rmrf(paths.claudeDir(), paths.codexDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, cfg);
}

/** Park the exact managed env at the scope status will read, so the drift
 *  under test is isolated to the router-file axis (env drift is a separate,
 *  already-shared axis — providerEnvDrift). */
function neutralizeEnvDrift(cwd, cfg) {
  const { file } = settingsTarget(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: managedEnv(cfg) }, null, 2));
}

const collect = (cwd) => status.collect({ pkgRoot: PKG_ROOT, cwd });
const providerDriftRow = (rows) => rows
  .filter((r) => r.subsystem === 'providers')
  .find((r) => /^wired:|^provider config drifted/.test(r.message));

test('#129 parity: an induced chain-order edit is reported as drift, identically, on both paths', async () => {
  const project = sandboxProject('ak-drift-parity-induced');
  seedHome(CHAIN_CFG());
  const cfg = loadKitConfig();
  applyAqeRouter(cfg, project); // converge once, exactly what `ak sync` runs
  neutralizeEnvDrift(project, cfg);

  // Induce drift by hand-editing the persisted chain, bypassing the writer —
  // the exact shape of a config someone hand-edited between syncs.
  const file = aqeRouterFile(project);
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const edited = { ...before, fallbackChain: { ...before.fallbackChain, entries: [{ ...before.fallbackChain.entries[0], provider: 'openai' }] } };
  fs.writeFileSync(file, JSON.stringify(edited));

  // The writer's own dry-run verdict — a read-only call, applyAqeRouter is not
  // invoked again here, so it cannot itself repair the induced edit.
  const writer = aqeRouterDrift(loadKitConfig(), project);
  assert.equal(writer.applicable, true);
  assert.equal(writer.drift, true, 'precondition: the induced edit must actually be drift');

  // The status section's reported verdict, read from the live row.
  const row = providerDriftRow(await collect(project));
  assert.ok(row, 'expected the providers drift row to be present');
  const statusDrift = row.level === 'warn' && /drifted/.test(row.message);

  assert.equal(statusDrift, writer.drift,
    `status(${row.level}: ${row.message}) disagrees with the writer's own dry-run (drift=${writer.drift})`);

  // The read-only comparators (aqeRouterDrift + status.collect) must never
  // themselves repair or otherwise touch the induced edit.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), edited);
});

test('#129 parity: a freshly converged chain is reported as clean, identically, on both paths', async () => {
  const project = sandboxProject('ak-drift-parity-clean');
  seedHome(CHAIN_CFG());
  const cfg = loadKitConfig();
  applyAqeRouter(cfg, project);
  neutralizeEnvDrift(project, cfg);

  const writer = aqeRouterDrift(loadKitConfig(), project);
  assert.equal(writer.drift, false, 'precondition: a freshly synced chain must not read as drift');

  const row = providerDriftRow(await collect(project));
  assert.ok(row);
  const statusDrift = row.level === 'warn' && /drifted/.test(row.message);
  assert.equal(statusDrift, writer.drift);
  assert.equal(row.level, 'ok');
});

test.after(() => rmrf(HOME));
