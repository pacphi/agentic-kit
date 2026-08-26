// #129 — the status↔sync contract for the AQE router. `ak status` must judge
// `.agentic-qe/llm-config.json` by the SAME projection and the SAME project
// scope gate `ak sync` writes with (applyAqeRouter): a freshly synced state is
// never drift, and a location sync refuses to manage is never drift either.
// Anything else is a permanent warning whose own `fix` command cannot clear it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sandboxHome, assertSandboxed, rmrf,
  sandboxProject, writeKitConfig, offlineKitConfig, fakeGlobalRoot,
} from './helpers/home-sandbox.mjs';

const HOME = sandboxHome('ak-status-drift');
const paths = await import('../../src/lib/paths.mjs');
const status = await import('../../src/commands/status.mjs');
const { loadKitConfig } = await import('../../src/lib/config.mjs');
const { applyAqeRouter, aqeRouterFile, managedEnv, settingsTarget } = await import('../../src/lib/providers.mjs');
const { seedActivityRoutes } = await import('../../src/lib/routing.mjs');
assertSandboxed(paths, HOME);

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// aqe ≥ 3.13.1 so the agentOverrides projection is live (not version-gated out).
paths._setGlobalRootForTest(fakeGlobalRoot(HOME, { ruflo: '9.9.9', 'agentic-qe': '9.9.9' }));

const dualHostCfg = ({ routes = {}, aqeFallback = [] } = {}) => offlineKitConfig({
  integrations: { hosts: { claude: true, codex: true } },
  routing: { version: 1, primaryHost: 'claude', routes },
  providers: { aqeProvider: null, aqeFallback },
});

function seedHome(cfg) {
  rmrf(paths.claudeDir(), paths.codexDir(), paths.configDir());
  fs.mkdirSync(paths.claudeDir(), { recursive: true });
  fs.writeFileSync(paths.claudeMdPath(), '# machine notes\n');
  writeKitConfig(HOME, cfg);
}

/** Park the exact managed env at the scope status will read, so the providers
 *  row isolates the router-file check (env drift is a separate axis). */
function neutralizeEnvDrift(cwd) {
  const { file } = settingsTarget(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: managedEnv(loadKitConfig()) }, null, 2));
}

const collect = (cwd) => status.collect({ pkgRoot: PKG_ROOT, cwd });
const rowsFor = (rows, subsystem) => rows.filter((r) => r.subsystem === subsystem);
const routingRow = (rows) => rowsFor(rows, 'routing').find((r) => r.message.includes('agent overrides'));

test('a freshly synced PARTIAL policy reports no routing drift (writer projection is the contract)', async () => {
  const project = sandboxProject('ak-drift-partial');
  seedHome(dualHostCfg({ routes: {
    review: { host: 'claude', model: 'claude-sonnet-5', provenance: 'user' },
  } }));
  applyAqeRouter(loadKitConfig(), project); // exactly what `ak sync` runs

  const row = routingRow(await collect(project));
  assert.ok(row, 'routing row present');
  assert.equal(row.level, 'ok', `freshly synced project must not drift: ${row.message}`);
});

test('a user pin on a RETIRED model reports no routing drift after sync honors the pin', async () => {
  const project = sandboxProject('ak-drift-retired');
  seedHome(dualHostCfg({ routes: {
    'security-scan': { host: 'codex', model: 'gpt-5.4', provenance: 'user' },
  } }));
  applyAqeRouter(loadKitConfig(), project);

  const row = routingRow(await collect(project));
  assert.equal(row.level, 'ok', `sync keeps the pin; status must not demand the substitute: ${row.message}`);
});

test('foreign agentOverrides entries and key order are the writer\'s merge domain, not drift', async () => {
  const project = sandboxProject('ak-drift-foreign');
  seedHome(dualHostCfg({ routes: seedActivityRoutes() }));
  // Pre-existing file: a managed key first (so merge order differs from a fresh
  // projection) plus a hand-added foreign agent applyAqeRouter must preserve.
  fs.mkdirSync(path.dirname(aqeRouterFile(project)), { recursive: true });
  fs.writeFileSync(aqeRouterFile(project), JSON.stringify({
    _managedBy: 'agentic-kit',
    agentOverrides: {
      'qe-code-reviewer': { provider: 'claude-code', model: 'claude-sonnet-5' },
      'qe-custom-agent': { provider: 'ollama' },
    },
  }));
  applyAqeRouter(loadKitConfig(), project);

  const row = routingRow(await collect(project));
  assert.equal(row.level, 'ok', `preserved foreign entry / merge order is not drift: ${row.message}`);
});

test('outside a git project, status never reports router drift sync refuses to manage', async () => {
  const nowhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-drift-noproj-')));
  seedHome(dualHostCfg({
    routes: seedActivityRoutes(),
    aqeFallback: [{ provider: 'claude-code', models: ['claude-opus-4-8'] }],
  }));
  neutralizeEnvDrift(nowhere);
  const res = applyAqeRouter(loadKitConfig(), nowhere);
  assert.match(res.detail, /not a project/, 'precondition: sync declines to manage here');

  const rows = await collect(nowhere);
  const drifted = rowsFor(rows, 'providers').filter((r) => r.level === 'warn' && /drifted/.test(r.message));
  assert.deepEqual(drifted.map((r) => r.message), [],
    'providers row must not claim drift the sync it recommends cannot repair');
  const row = routingRow(rows);
  assert.ok(row, 'routing row still present (the policy exists)');
  assert.equal(row.level, 'info', `unmanaged location is info, not an unfixable warn: ${row.message}`);
  assert.match(row.message, /not in a project/);
});

test('from a SUBDIRECTORY of a project, the chain check reads the repo root, not cwd', async () => {
  const project = sandboxProject('ak-drift-subdir');
  const subdir = path.join(project, 'src', 'deep');
  fs.mkdirSync(subdir, { recursive: true });
  seedHome(dualHostCfg({
    routes: seedActivityRoutes(),
    aqeFallback: [{ provider: 'claude-code', models: ['claude-opus-4-8'] }],
  }));
  neutralizeEnvDrift(subdir);
  applyAqeRouter(loadKitConfig(), project); // sync anchors at the repo root

  const rows = await collect(subdir);
  const drifted = rowsFor(rows, 'providers').filter((r) => r.level === 'warn' && /drifted/.test(r.message));
  assert.deepEqual(drifted.map((r) => r.message), [], 'root-anchored file must satisfy a subdir status');
  assert.equal(routingRow(rows).level, 'ok');
});

test('REAL drift is still caught: a hand-edited managed override warns with a sync fix', async () => {
  const project = sandboxProject('ak-drift-real');
  seedHome(dualHostCfg({ routes: seedActivityRoutes() }));
  applyAqeRouter(loadKitConfig(), project);
  const disk = JSON.parse(fs.readFileSync(aqeRouterFile(project), 'utf8'));
  disk.agentOverrides['qe-code-reviewer'] = { provider: 'claude-code', model: 'claude-opus-4-8' };
  fs.writeFileSync(aqeRouterFile(project), JSON.stringify(disk));

  const row = routingRow(await collect(project));
  assert.equal(row.level, 'warn', 'a genuinely diverged managed entry is drift');
  assert.match(row.message, /out of sync/);
  assert.equal(row.fix, 'sync re-applies agentOverrides');
});

test('REAL drift is still caught: a configured policy with no file yet warns', async () => {
  const project = sandboxProject('ak-drift-nofile');
  seedHome(dualHostCfg({ routes: seedActivityRoutes() }));
  // no applyAqeRouter — the file a first sync would create is absent

  const row = routingRow(await collect(project));
  assert.equal(row.level, 'warn', 'missing file in a managed project is drift a sync will fix');
  assert.equal(row.fix, 'sync re-applies agentOverrides');
});

test('unavailable external intent names a manual remedy instead of an impossible sync loop', async () => {
  const project = sandboxProject('ak-drift-revoked-external');
  seedHome(offlineKitConfig({
    // Deliberately mismatched/stale entry name: the external host id in
    // integration intent remains the actionable cleanup identity.
    hostAdapters: [{ name: 'adapter-package-name', source: 'mem://hermes', contract: 1 }],
    integrations: {
      version: 2, hosts: { claude: true, codex: false, opencode: false, hermes: true },
      bindings: [], ownership: {},
    },
    routing: { version: 1, primaryHost: 'claude', routes: {
      testing: { host: 'hermes', model: 'default', provenance: 'user' },
    } },
    providers: {
      aqeProvider: 'hermes',
      aqeFallback: [{ provider: 'hermes', models: ['default'], source: 'user' }],
      models: [], maxBudgetUsd: null,
    },
  }));
  neutralizeEnvDrift(project);

  const providerRows = rowsFor(await collect(project), 'providers');
  const unavailable = providerRows.find((entry) => /external AQE intent is unavailable \(hermes\)/.test(entry.message));
  assert.ok(unavailable, providerRows.map((entry) => entry.message).join('\n'));
  assert.equal(unavailable.level, 'warn');
  assert.equal(unavailable.fix, null, 'sync cannot restore an absent grant, so this is not a sync plan item');
  assert.match(unavailable.message, /revoke-grant hermes aqeProvider/);
  assert.equal(providerRows.some((entry) => entry.fix === 'sync re-applies provider env + aqe router'), false,
    'a clean disk plus unavailable intent must not prescribe the non-converging sync loop');
});
