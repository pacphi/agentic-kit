// ADR-0048 management facade end-to-end tests (agent I). Exercises
// `createManagementService`'s composition of P's projection, Q's query/
// guidance/activity/discovery-adjacent stores, D's discovery slice, and T's
// transaction engine, over a fake collector and a hermetic, injectable
// filesystem/config/subprocess/model-store surface. Never touches the real
// home directory, network, or a real subprocess.
//
// Two evidence strategies are used depending on what each test needs:
//  - most tests drive the REAL `refreshInventory` pipeline over a minimal
//    hand-built footprint (catalog-only; no dependency probes — see the
//    swarm report: P's dependency-probes.mjs does not exist yet, so this
//    facade cannot itself produce a `missing-verified-dependency` condition
//    today);
//  - tests that need an already-admitted GuidanceEntry (dispositions,
//    procedure rendering) seed the swarm's own sentinel `baseInventory()`
//    fixture directly into the last-good snapshot store, so they exercise
//    THIS facade's reads/writes/correlation against a fixture every other
//    agent's tests already agree on, without re-deriving Q's admission
//    heuristics here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { instrumentWalkTree } from '../../src/lib/footprint/walk.mjs';
import { isOpaqueId, isProhibitedLabel, LIMITING_REASONS, opaqueId } from '../../src/lib/maintenance/management/model.mjs';
import { createManagementService } from '../../src/lib/maintenance/management/service.mjs';
import { createInventorySnapshotStore } from '../../src/lib/maintenance/management/service-store.mjs';
import { createMaintenanceService } from '../../src/lib/maintenance/service.mjs';
import { writeMaintenanceReceipt } from '../../src/lib/maintenance/transaction-store.mjs';
import { INTERRUPTED_RECEIPT, baseInventory } from '../fixtures/maintenance/management-fixtures.mjs';

const INSTALLATION_KEY = 'fixture-installation-key-0123456789abcdef';
const NOW_MS = Date.parse('2026-09-05T12:00:00.000Z');
const LIGHTPANDA_ITEM_PATH = '/private/claude/lightpanda-config';
const EMPTY_MODEL_STORE = Object.freeze({ snapshots: [] });

function fixtureRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-mnt-management-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A minimal one-placement footprint: an mcpServer catalog item with no
 * lifecycle signal, so the legacy scanner emits no finding for it and the
 * new projection admits it `healthy` with no guidance. Used for the facade
 * composition/persistence/privacy tests that do not need guidance. */
function lightpandaFootprint(sourceStampValue = 'fp-1') {
  return {
    catalog: {
      sourceStamps: [{ id: 'claude-user', value: sourceStampValue }],
      items: [{
        canonicalId: 'mcpServer::lightpanda', kind: 'mcpServer', name: 'lightpanda', capabilityName: 'lightpanda',
        pluginRef: null,
        presence: [{
          host: 'claude', scope: 'user', project: null, itemPath: LIGHTPANDA_ITEM_PATH,
          artifactId: 'catalog-artifact-lightpanda', digest: null,
          consumer: { mechanism: 'claude-json-mcp', enabled: true, configScope: 'user' },
        }],
      }],
    },
    storage: { reclaimables: [] },
  };
}

/** The same registration, but carrying a legacy `maintenance` lifecycle
 * signal (`update-available`) so `scanMaintenanceFindings` (the engine
 * `planAction` still resolves findings through) actually emits a finding
 * for it — used only by the `planAction` correlation test. */
function updatableLightpandaFootprint() {
  const footprint = lightpandaFootprint('fp-plan');
  footprint.catalog.items[0].maintenance = { state: 'update-available', recommendedVersion: '2.0' };
  return footprint;
}

// D's `resolveAutomaticSourceRoots` and this facade's `dependency-probes.mjs`
// wiring both read real host config paths off `ctx.paths` unless overridden
// — without this, a refresh reads the ACTUAL developer machine's
// ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.claude.json, etc., and the
// fixture's placement count becomes whatever happens to exist there.
function hermeticPaths(root) {
  // Real, empty, hermetic directories rather than nonexistent ones: a
  // nonexistent root makes `planPartitions` return zero partitions, and the
  // orchestrator's drive loop (`while (record.pendingPartitions.length)`)
  // then never runs its body at all — so `finalizeIfComplete` never fires
  // and the record is stuck reporting `scanning` forever (a real gap in the
  // zero-partition case, worth flagging upstream). A real empty directory
  // always yields at least the root-files partition, so it still finalizes
  // normally; `readInstructionFileEvidence` still reports `present:false`
  // for the (absent) CLAUDE.md/AGENTS.md file inside it either way.
  const emptyDir = (name) => {
    const dir = path.join(root, 'hermetic', name);
    fs.mkdirSync(dir, { recursive: true });
    return () => dir;
  };
  const missingFile = (name) => () => path.join(root, 'hermetic', 'does-not-exist', name);
  return Object.freeze({
    claudeDir: emptyDir('claude-dir'),
    codexDir: emptyDir('codex-dir'),
    opencodeDir: emptyDir('opencode-dir'),
    claudeUserMcpPath: missingFile('claude.json'),
    codexConfigPath: missingFile('config.toml'),
    opencodeConfigPath: missingFile('opencode.json'),
  });
}

const HERMETIC_PROVIDER_OPTIONS = Object.freeze({
  claudePlugin: { run: async () => ({ ok: false, reason: 'not-installed' }) },
  codexPlugin: { run: async () => ({ ok: false, reason: 'not-installed' }) },
  codexMcp: { run: async () => ({ ok: false, reason: 'not-installed' }) },
  rufloMcpOrphan: {
    uid: 501, list: () => [], classify: () => [], reap: async () => ({ reaped: [] }),
  },
  // provider-registry.mjs registers ollama-model by DEFAULT (opt-out only),
  // and its own default fetchImpl is the real global fetch against
  // 127.0.0.1:11434 — a real loopback service on some machines. Every
  // harness in this file routes through this one constant, so disabling it
  // here is the single fix point.
  ollamaModel: { enabled: false },
});

/** Builds a full harness: a temp controlRoot, an in-memory kit.json, a fake
 * collector whose footprint/throw behavior a test can mutate, and a
 * management service wired entirely off injected, hermetic dependencies
 * (including an EMPTY model-inventory store, so a real machine's cached
 * model snapshots never leak into the projected inventory). */
function buildHarness(t, {
  footprint = lightpandaFootprint(), discovery = {}, paths = null, env = {}, collectorRead = null, walk = undefined,
} = {}) {
  const controlRoot = fixtureRoot(t);
  let currentFootprint = footprint;
  let currentNow = NOW_MS;
  let config = {
    maintenance: {
      discovery: {
        automaticSources: {}, exactProjects: [], collectionRoots: [], exclusions: [], ...discovery,
      },
    },
  };
  let readCalls = 0;
  let refreshDeepCalls = 0;
  let readShouldThrow = false;
  let readError = null;

  const collector = {
    async read() {
      readCalls += 1;
      if (readShouldThrow) throw readError ?? new Error('simulated collector failure');
      if (collectorRead) return collectorRead();
      return currentFootprint;
    },
    async refreshDeep() {
      refreshDeepCalls += 1;
      return { ok: true, persisted: { ok: true } };
    },
    isScanning: () => false,
  };

  const now = () => currentNow;
  const maintenance = createMaintenanceService({
    collector, controlRoot, fsImpl: fs, now, providerOptions: HERMETIC_PROVIDER_OPTIONS,
  });

  const service = createManagementService({
    maintenance,
    collector,
    modelStore: EMPTY_MODEL_STORE,
    loadConfig: () => structuredClone(config),
    saveConfig: (next) => { config = structuredClone(next); },
    controlRoot,
    fsImpl: fs,
    now,
    installationKey: INSTALLATION_KEY,
    platform: 'darwin',
    env,
    paths: paths ?? hermeticPaths(controlRoot),
    ...(walk ? { walk } : {}),
    collectIntegrationFacts: async () => ({ hosts: {}, providers: {}, bindings: [] }),
    providerOptions: HERMETIC_PROVIDER_OPTIONS,
  });

  return {
    service,
    controlRoot,
    transactionsRoot: path.join(controlRoot, 'transactions'),
    setFootprint(next) { currentFootprint = next; },
    setNow(ms) { currentNow = ms; },
    setReadShouldThrow(value, error = null) { readShouldThrow = value; readError = error; },
    readCalls: () => readCalls,
    refreshDeepCalls: () => refreshDeepCalls,
  };
}

/** Seeds the last-good snapshot store directly with an already-built,
 * already-guidance-admitted inventory (the swarm's sentinel fixture), for
 * tests that exercise the facade's OWN reads/writes over guidance entries
 * without re-deriving Q's admission heuristics. */
function seedLastGoodInventory(controlRoot, inventory) {
  const managementRoot = path.join(controlRoot, 'management');
  createInventorySnapshotStore(managementRoot, { fsImpl: fs }).write(inventory);
}

function writeReceipt(transactionsRoot, receipt = INTERRUPTED_RECEIPT) {
  fs.mkdirSync(transactionsRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(transactionsRoot, 0o700);
  const dir = path.join(transactionsRoot, receipt.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  writeMaintenanceReceipt(path.join(dir, 'receipt.json'), receipt, { fsImpl: fs });
}

// ── INV-001 / PERF-001: refresh, then read without a collector call ────────

test('INV-001: refreshInventory builds a valid inventory and persists it as last-good', async (t) => {
  const h = buildHarness(t);
  const { inventoryId, capturedAt } = await h.service.refreshInventory();
  assert.ok(isOpaqueId(inventoryId, 'inv'));
  assert.ok(Number.isFinite(Date.parse(capturedAt)));

  const report = await h.service.report();
  assert.equal(report.scanRequired, false);
  assert.equal(report.inventoryId, inventoryId);
  assert.equal(report.placementCount, 1);
});

test('PERF-001: report/inventory/placement/guidance never run the collector', async (t) => {
  const h = buildHarness(t);
  await h.service.refreshInventory();
  const before = h.readCalls();

  const page = h.service.inventory({});
  const [group] = page.groups;
  const [row] = group.placements;
  h.service.placement({ placementId: row.placementId });
  h.service.guidance({});
  await h.service.report();

  assert.equal(h.readCalls(), before, 'reads must never trigger the collector');
});

// ── PERF-003: cursor bound to a stale inventory generation is refused ──────

test('PERF-003: a cursor from a prior inventory generation is refused', async (t) => {
  const h = buildHarness(t, { footprint: { catalog: { sourceStamps: [{ id: 'x', value: 'fp-a' }], items: [lightpandaFootprint().catalog.items[0], { ...lightpandaFootprint().catalog.items[0], canonicalId: 'mcpServer::second', name: 'second' }] } } });
  await h.service.refreshInventory();
  const firstPage = h.service.inventory({ limit: 1 });
  assert.ok(firstPage.nextCursor, 'the fixture must have more than one placement to page through');

  h.setFootprint({ catalog: { sourceStamps: [{ id: 'x', value: 'fp-b' }], items: [lightpandaFootprint().catalog.items[0]] } });
  await h.service.refreshInventory();

  assert.throws(
    () => h.service.inventory({ limit: 1, cursor: firstPage.nextCursor }),
    (error) => error.code === 'inventory-generation-mismatch',
  );
});

// ── PERF-007: a failed refresh never replaces the last-good snapshot ───────

test('PERF-007: last-good inventory is preserved when a refresh throws', async (t) => {
  const h = buildHarness(t);
  const first = await h.service.refreshInventory();

  h.setReadShouldThrow(true);
  await assert.rejects(() => h.service.refreshInventory());

  const report = await h.service.report();
  assert.equal(report.inventoryId, first.inventoryId, 'the prior last-good inventory must remain authoritative');
});

// ── PERF-008: concurrent refreshes coalesce into one flight ────────────────

test('PERF-008: concurrent refreshInventory calls share one flight', async (t) => {
  const h = buildHarness(t);
  const [a, b] = await Promise.all([h.service.refreshInventory(), h.service.refreshInventory()]);
  assert.equal(a.inventoryId, b.inventoryId);
  // One flight reads the collector twice: once directly for the footprint
  // the projection needs, once inside `maintenance.providerEvidence()` for
  // its own registry/detections (the real collector's cheap tier memoizes
  // this within its TTL — see footprint/index.mjs — so this is not a double
  // real measurement in production, just two calls on this bare fake).
  assert.equal(h.readCalls(), 2, 'two concurrent refreshes must still resolve as exactly one flight');
});

// ── D6: a large last-good snapshot round-trips gzip-compressed on disk ─────
// A real-machine inventory (8,304 placements) measured 17.1 MB uncompressed
// — past the original 16 MiB ceiling. The store now compresses on disk with
// a 64 MiB uncompressed / 16 MiB compressed ceiling; a synthetic payload
// well past 64 MiB must be refused WITHOUT disturbing the prior write.

function inventoryOfApproxSize(bytes) {
  return { schemaVersion: 2, schema: 'x', payload: 'x'.repeat(bytes) };
}

test('D6: a 20 MiB snapshot round-trips, and a 70 MiB one is refused without replacing last-good', async (t) => {
  const controlRoot = fixtureRoot(t);
  const managementRoot = path.join(controlRoot, 'management');
  const store = createInventorySnapshotStore(managementRoot, { fsImpl: fs });

  const twentyMiB = inventoryOfApproxSize(20 * 1024 * 1024);
  const sizes = store.write(twentyMiB);
  assert.ok(sizes.uncompressedBytes > 20 * 1024 * 1024);
  assert.ok(sizes.compressedBytes < 16 * 1024 * 1024, 'a highly repetitive 20 MiB payload must compress well under the ceiling');
  assert.deepEqual(store.read(), twentyMiB);

  const seventyMiB = inventoryOfApproxSize(70 * 1024 * 1024);
  assert.throws(() => store.write(seventyMiB), /exceeds .* uncompressed bytes/);
  assert.deepEqual(store.read(), twentyMiB, 'a refused write must never replace the last-good snapshot');
});

test('D6: read() falls back to a legacy uncompressed inventory-latest.json for an upgrading installation', async (t) => {
  const controlRoot = fixtureRoot(t);
  const managementRoot = path.join(controlRoot, 'management');
  fs.mkdirSync(managementRoot, { recursive: true });
  const legacyStore = createInventorySnapshotStore(managementRoot, { fsImpl: fs });
  // Simulate the pre-D6 shape directly: write the legacy uncompressed file
  // by hand rather than depending on old code no longer in the tree.
  const { createHash } = await import('node:crypto');
  const { canonicalJson } = await import('../../src/lib/maintenance/management/model.mjs');
  const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const snapshot = { schemaVersion: 2, schema: 'legacy', placements: [] };
  const base = { schemaVersion: 'maintenance-management-inventory-snapshot/v1', snapshot };
  const envelope = { ...base, integrity: { algorithm: 'sha256', digest: sha256(base) } };
  fs.writeFileSync(path.join(managementRoot, 'inventory-latest.json'), `${JSON.stringify(envelope)}\n`);

  assert.deepEqual(legacyStore.read(), snapshot);
});

// ── D6b: lastRefresh is a real wire signal for a failed chained refresh ────

test('D6b: lastRefresh reflects ok/failed on every refresh outcome and never masks a preserved last-good inventory', async (t) => {
  const h = buildHarness(t);
  let report = await h.service.report();
  assert.equal(report.lastRefresh, null, 'no refresh has ever run yet');

  const first = await h.service.refreshInventory();
  report = await h.service.report();
  assert.equal(report.lastRefresh.status, 'ok');
  assert.equal(typeof report.lastRefresh.at, 'string');

  h.setReadShouldThrow(true);
  await assert.rejects(() => h.service.refreshInventory());
  report = await h.service.report();
  assert.equal(report.lastRefresh.status, 'failed');
  assert.equal(report.inventoryId, first.inventoryId, 'the last-good inventory must remain untouched by a failed refresh');
  if (report.lastRefresh.message) {
    assert.ok(report.lastRefresh.message.length <= 200);
    assert.equal(isProhibitedLabel(report.lastRefresh.message), false);
  }

  // The page and guidance envelopes carry the same signal.
  const page = h.service.inventory({});
  assert.equal(page.lastRefresh.status, 'failed');
  const guidance = h.service.guidance({});
  assert.equal(guidance.lastRefresh.status, 'failed');

  h.setReadShouldThrow(false);
  await h.service.refreshInventory();
  report = await h.service.report();
  assert.equal(report.lastRefresh.status, 'ok');
});

test('D6b: a failure message naming a local path or exceeding 200 chars is sanitized before being recorded', async (t) => {
  const h = buildHarness(t);
  await h.service.refreshInventory(); // establish a last-good baseline first

  h.setReadShouldThrow(true, new Error('collector read failed: /Users/someone/.claude/private-config.json could not be parsed'));
  await assert.rejects(() => h.service.refreshInventory());
  const afterPathError = await h.service.report();
  assert.equal(afterPathError.lastRefresh.status, 'failed');
  assert.doesNotMatch(afterPathError.lastRefresh.message ?? '', /\/Users\//);

  h.setReadShouldThrow(true, new Error('x'.repeat(500)));
  await assert.rejects(() => h.service.refreshInventory());
  const afterLongError = await h.service.report();
  assert.ok((afterLongError.lastRefresh.message ?? '').length <= 200);

  h.setReadShouldThrow(true, new Error('the provider registry is unknown and unsupported here'));
  await assert.rejects(() => h.service.refreshInventory());
  const afterProhibitedWord = await h.service.report();
  assert.equal(isProhibitedLabel(afterProhibitedWord.lastRefresh.message ?? ''), false);
});

// ── PRV-004/005/006: path-free public surface, owner-only reveal ──────────

test('PRV-004: the public inventory page and placement inspector never carry a raw path', async (t) => {
  const h = buildHarness(t);
  await h.service.refreshInventory();
  const page = h.service.inventory({});
  const [group] = page.groups;
  const [row] = group.placements;
  const inspector = h.service.placement({ placementId: row.placementId });

  const wire = JSON.stringify({ page, inspector });
  assert.doesNotMatch(wire, /\/private\//);
});

test('PRV-005: revealLocator is the sole path disclosure and survives a fresh service instance', async (t) => {
  const h = buildHarness(t);
  await h.service.refreshInventory();
  const page = h.service.inventory({});
  const [group] = page.groups;
  const [row] = group.placements;

  const revealed = h.service.revealLocator({ placementId: row.placementId });
  assert.equal(revealed.placementId, row.placementId);
  assert.equal(revealed.exactPath, LIGHTPANDA_ITEM_PATH);
  assert.equal(revealed.path, LIGHTPANDA_ITEM_PATH, 'path is kept as an alias of exactPath');
  assert.ok(Array.isArray(revealed.breadcrumb) && revealed.breadcrumb.length > 0);

  // A second facade instance over the SAME controlRoot has no in-memory
  // locators; it must recover the reveal from the owner-private store.
  const fakeCollector = {
    read: async () => lightpandaFootprint(),
    refreshDeep: async () => ({ ok: true, persisted: { ok: true } }),
    isScanning: () => false,
  };
  const second = createManagementService({
    maintenance: createMaintenanceService({
      collector: fakeCollector, controlRoot: h.controlRoot, fsImpl: fs, now: () => NOW_MS, providerOptions: HERMETIC_PROVIDER_OPTIONS,
    }),
    collector: fakeCollector,
    modelStore: EMPTY_MODEL_STORE,
    loadConfig: () => ({ maintenance: { discovery: { automaticSources: {}, exactProjects: [], collectionRoots: [], exclusions: [] } } }),
    saveConfig: () => {},
    controlRoot: h.controlRoot,
    fsImpl: fs,
    now: () => NOW_MS,
    installationKey: INSTALLATION_KEY,
    platform: 'darwin',
    env: {},
    paths: hermeticPaths(h.controlRoot),
    collectIntegrationFacts: async () => ({ hosts: {}, providers: {}, bindings: [] }),
    providerOptions: HERMETIC_PROVIDER_OPTIONS,
  });
  const revealedAgain = second.revealLocator({ placementId: row.placementId });
  assert.equal(revealedAgain.path, LIGHTPANDA_ITEM_PATH);
});

test('PRV-006: a valid URL view state overrides the remembered preference', async (t) => {
  const h = buildHarness(t);
  h.service.savePreferences({ lastView: { scope: 'user', view: 'all', sort: 'name' } });
  const resolved = h.service.preferences({ url: { scope: 'across', view: 'can-apply' } });
  assert.equal(resolved.lastView.scope, 'across');
  assert.equal(resolved.lastView.view, 'can-apply');

  const remembered = h.service.preferences({});
  assert.equal(remembered.lastView.scope, 'user');
});

// ── J1 (live pipeline): dependency probes drive missing-verified-dependency ─
// Unlike the dispositions/guidance tests above (which seed the sentinel
// fixture because they need admitted guidance without depending on Q's own
// admission heuristics), this drives the REAL refreshInventory pipeline: a
// claude.json MCP registration whose command is absent from an injected PATH
// must surface as `missing-verified-dependency` with steps/decision guidance,
// entirely through collectDependencyProbes -> buildManagementInventory ->
// admitGuidance, now that dependency-probes.mjs exists.

function lightpandaMcpServerFootprint(sourceStampValue = 'fp-j1-live') {
  return {
    catalog: {
      sourceStamps: [{ id: 'claude-user', value: sourceStampValue }],
      items: [{
        canonicalId: 'mcpServer::lightpanda', kind: 'mcpServer', name: 'lightpanda', capabilityName: 'lightpanda',
        pluginRef: null,
        presence: [{
          host: 'claude', scope: 'user', project: null, itemPath: null,
          artifactId: 'catalog-artifact-lightpanda', digest: null,
          consumer: { mechanism: 'claude-json-mcp', enabled: true, configScope: 'user' },
        }],
      }],
    },
    storage: { reclaimables: [] },
  };
}

/** Builds a facade whose sole placement is a lightpanda MCP registration
 * with a `claude.json` command absent from an injected (empty) PATH — the
 * live pipeline's route to admitted `steps`/`decision` guidance, shared by
 * the J1 and facet-parity tests below. */
function buildLightpandaDependencyHarness(t) {
  const controlRoot = fixtureRoot(t);
  const claudeJsonPath = path.join(controlRoot, 'claude.json');
  fs.writeFileSync(claudeJsonPath, JSON.stringify({
    mcpServers: { lightpanda: { command: '/opt/homebrew/bin/lightpanda' } },
  }));
  const emptyPathDir = fixtureRoot(t); // deliberately empty: "lightpanda" resolves absent

  const collector = {
    read: async () => lightpandaMcpServerFootprint(),
    refreshDeep: async () => ({ ok: true, persisted: { ok: true } }),
    isScanning: () => false,
  };
  const service = createManagementService({
    maintenance: createMaintenanceService({
      collector, controlRoot, fsImpl: fs, now: () => NOW_MS, providerOptions: HERMETIC_PROVIDER_OPTIONS,
    }),
    collector,
    modelStore: EMPTY_MODEL_STORE,
    loadConfig: () => ({ maintenance: { discovery: { automaticSources: {}, exactProjects: [], collectionRoots: [], exclusions: [] } } }),
    saveConfig: () => {},
    controlRoot,
    fsImpl: fs,
    now: () => NOW_MS,
    installationKey: INSTALLATION_KEY,
    platform: 'darwin',
    env: { PATH: emptyPathDir },
    paths: { ...hermeticPaths(controlRoot), claudeUserMcpPath: () => claudeJsonPath },
    collectIntegrationFacts: async () => ({ hosts: {}, providers: {}, bindings: [] }),
    providerOptions: HERMETIC_PROVIDER_OPTIONS,
  });
  return { service, controlRoot };
}

test('J1 (live pipeline): a catalog MCP registration whose command is absent from PATH admits missing-verified-dependency with steps/decision guidance', async (t) => {
  const { service } = buildLightpandaDependencyHarness(t);

  await service.refreshInventory();
  const page = service.inventory({});
  const [group] = page.groups;
  const [row] = group.placements;
  const inspector = service.placement({ placementId: row.placementId });
  assert.ok(
    inspector.whatIsThis.conditions.includes('missing-verified-dependency'),
    'no sourceCoverage was supplied in this harness, so source-scan-incomplete may also legitimately be present',
  );

  const stepsGuidance = service.guidance({ lane: 'steps' });
  assert.ok(stepsGuidance.entries.length > 0, 'a built-in recipe must admit steps guidance for the missing lightpanda dependency');
  const decisionGuidance = service.guidance({ lane: 'decision' });
  assert.ok(decisionGuidance.entries.length > 0, 'the missing-dependency condition must also admit a decision-lane entry');
});

// ── guidance() facet parity with inventory()'s query engine ────────────────

test("guidance(): facets narrow by the same rules as inventory() (not only 'kind')", async (t) => {
  const { service } = buildLightpandaDependencyHarness(t);
  await service.refreshInventory();
  const page = service.inventory({});
  const [group] = page.groups;
  const [row] = group.placements;
  const allGuidance = service.guidance({});
  assert.ok(allGuidance.entries.length > 0, 'the fixture must admit at least one guidance entry to make facet narrowing observable');

  const matchingKind = service.guidance({ facets: { kind: [group.kind] } });
  assert.deepEqual(
    matchingKind.entries.map((entry) => entry.guidanceId).sort(),
    allGuidance.entries.map((entry) => entry.guidanceId).sort(),
    'a facet matching the only placement\'s own kind must keep every guidance entry',
  );

  const nonMatchingScope = service.guidance({
    facets: { scope: ['system', 'machine', 'project'].filter((value) => value !== row.scope.value) },
  });
  assert.deepEqual(nonMatchingScope.entries, [], 'a scope facet that structurally excludes the placement must admit no guidance');
});

// ── D4: guidance().counts.total ────────────────────────────────────────────

test('D4: guidance().counts.total equals the number of admitted entries', async (t) => {
  const { service } = buildLightpandaDependencyHarness(t);
  await service.refreshInventory();
  const guidance = service.guidance({});
  assert.ok(guidance.entries.length > 0, 'the fixture must admit at least one guidance entry');
  assert.equal(guidance.counts.total, guidance.entries.length);

  const stepsOnly = service.guidance({ lane: 'steps' });
  assert.equal(stepsOnly.counts.total, stepsOnly.entries.length);
});

// ── providerEvidence() fallback for a legacy/stub maintenance object ───────

test('refreshInventory falls back to building its own provider registry when maintenance.providerEvidence is absent', async (t) => {
  const controlRoot = fixtureRoot(t);
  const collector = {
    read: async () => lightpandaFootprint(),
    refreshDeep: async () => ({ ok: true, persisted: { ok: true } }),
    isScanning: () => false,
  };
  // A legacy/stub maintenance service exposing only the pre-providerEvidence
  // surface (mutationBlocks is still required by gatherAndProject).
  const legacyMaintenance = {
    mutationBlocks: () => [],
  };
  const service = createManagementService({
    maintenance: legacyMaintenance,
    collector,
    modelStore: EMPTY_MODEL_STORE,
    loadConfig: () => ({ maintenance: { discovery: { automaticSources: {}, exactProjects: [], collectionRoots: [], exclusions: [] } } }),
    saveConfig: () => {},
    controlRoot,
    fsImpl: fs,
    now: () => NOW_MS,
    installationKey: INSTALLATION_KEY,
    platform: 'darwin',
    env: {},
    paths: hermeticPaths(controlRoot),
    collectIntegrationFacts: async () => ({ hosts: {}, providers: {}, bindings: [] }),
    providerOptions: HERMETIC_PROVIDER_OPTIONS,
  });

  const { inventoryId } = await service.refreshInventory();
  assert.ok(isOpaqueId(inventoryId, 'inv'));
  const report = await service.report();
  assert.equal(report.scanRequired, false);
});

// ── DSC-013: discovery preview -> save -> scan -> progress -> stop ─────────

test('DSC-013: previewSource -> saveSource -> startScan -> scanProgress -> stopScan lifecycle', async (t) => {
  const h = buildHarness(t);
  const root = fixtureRoot(t);
  fs.mkdirSync(path.join(root, 'project-a', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project-a', 'file.txt'), 'x');

  const preview = h.service.previewSource({ kind: 'collection-root', root });
  assert.ok(preview.previewId);
  assert.equal(preview.root, root);

  const notConfirmed = h.service.saveSource({ previewId: preview.previewId, confirmed: false });
  assert.equal(notConfirmed.confirmed, false);

  const saved = h.service.saveSource({ previewId: preview.previewId, confirmed: true });
  assert.equal(saved.confirmed, true);
  assert.equal(saved.root, root);

  const discovery = h.service.discovery();
  assert.equal(discovery.collectionRoots.length, 1);
  assert.equal(discovery.collectionRoots[0].root, root);

  const sourceId = discovery.collectionRoots[0].sourceId;
  const afterStart = await h.service.startScan({ sourceIds: [sourceId] });
  const sourceCoverage = afterStart.coverage.find((entry) => entry.sourceId === sourceId);
  assert.ok(sourceCoverage, 'the started source must appear in progress');

  const progress = h.service.scanProgress();
  assert.ok(progress.coverage.some((entry) => entry.sourceId === sourceId));
  assert.equal(typeof progress.narrative, 'string');
  assert.ok(Array.isArray(progress.progress), 'scanProgress() carries the bounded per-source orchestrator progress array');

  const stopped = h.service.stopScan({ sourceId, confirmed: true });
  assert.equal(stopped.confirmed, true);
  const afterStop = h.service.discovery();
  assert.equal(afterStop.collectionRoots.length, 0, 'a confirmed stop unenrolls the source');
});

test('scan lifecycle: pauseScan and resumeScan accept a bare sourceId (symmetric with startScan) and return the full scanProgress shape', async (t) => {
  const root = fixtureRoot(t);
  // Two partitions (the root's own files, plus the child directory) so
  // `maxSlices:1` leaves the source pausable rather than completing the
  // whole scan in one call. Configured DIRECTLY in kit.json rather than via
  // saveSource: saveSource now auto-starts a new root with the unbounded
  // (Infinity) default (D9), which would race this test's own
  // `maxSlices:1`-bounded call and complete the tiny tree before this test
  // ever gets a pausable window.
  fs.writeFileSync(path.join(root, 'root-file.txt'), 'x');
  fs.mkdirSync(path.join(root, 'project-a', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project-a', 'file.txt'), 'x');
  const sourceId = opaqueId('src', { kind: 'collection-root', root }, INSTALLATION_KEY);
  const h = buildHarness(t, {
    discovery: { collectionRoots: [{ root, sourceId, maxDepth: null, includeNetwork: false }] },
  });

  const afterStart = await h.service.startScan({ sourceId, maxSlices: 1 });
  assert.ok(afterStart.coverage.some((entry) => entry.sourceId === sourceId));

  const afterPause = h.service.pauseScan({ sourceId });
  for (const field of ['coverage', 'progress', 'narrative', 'forbiddenClaims']) {
    assert.ok(field in afterPause, `pauseScan result must carry the scanProgress() field ${field}`);
  }
  assert.ok(afterPause.coverage.some((entry) => entry.sourceId === sourceId && entry.state === 'paused'));

  const afterResume = await h.service.resumeScan({ sourceId });
  for (const field of ['coverage', 'progress', 'narrative', 'forbiddenClaims']) {
    assert.ok(field in afterResume, `resumeScan result must carry the scanProgress() field ${field}`);
  }
});

test('DSC: setAutomaticSource, addExclusion, and removeExclusion round-trip through kit.json', async (t) => {
  const h = buildHarness(t);
  await h.service.setAutomaticSource({ sourceId: 'ollama', enabled: false });
  let discovery = h.service.discovery();
  assert.equal(discovery.automaticSources.find((s) => s.id === 'ollama').enabled, false);

  const root = fixtureRoot(t);
  await h.service.addExclusion({ path: root, recursive: true });
  discovery = h.service.discovery();
  assert.equal(discovery.exclusions.length, 1);
  const [exclusionId] = discovery.exclusions.map((entry) => entry.exclusionId);
  assert.ok(exclusionId);

  await h.service.removeExclusion({ exclusionId });
  discovery = h.service.discovery();
  assert.equal(discovery.exclusions.length, 0);
});

test('discovery() marks each automatic source and coverage row with filesystem, even a disabled one, but never on the inventory sourceCoverage', async (t) => {
  const h = buildHarness(t, {
    discovery: { automaticSources: { providers: false } },
  });

  const filesystemSourceIds = new Set(['claude-user', 'codex-user', 'opencode-user', 'hermes-user', 'projects']);
  const nonFilesystemSourceIds = new Set(['runtimes', 'package-managers', 'ollama', 'providers']);

  const d = h.service.discovery();
  assert.equal(d.automaticSources.length, filesystemSourceIds.size + nonFilesystemSourceIds.size);
  for (const source of d.automaticSources) {
    const expected = filesystemSourceIds.has(source.id) ? true : nonFilesystemSourceIds.has(source.id) ? false : null;
    assert.ok(expected !== null, `unexpected automatic source id ${source.id}`);
    assert.equal(source.filesystem, expected, `automatic source ${source.id} filesystem flag`);
  }
  // `providers` is disabled in this harness's config; it must still report
  // its true (non-filesystem) nature rather than defaulting because it is
  // absent from the currently-enabled source list.
  assert.equal(d.automaticSources.find((source) => source.id === 'providers').enabled, false);
  assert.equal(d.automaticSources.find((source) => source.id === 'providers').filesystem, false);

  assert.ok(d.coverage.length > 0);
  for (const row of d.coverage) {
    assert.ok(typeof row.filesystem === 'boolean', `coverage row ${row.label} must carry a boolean filesystem flag`);
  }
  const runtimesRow = d.coverage.find((row) => row.label === 'Runtimes');
  assert.equal(runtimesRow.filesystem, false);
  const claudeUserRow = d.coverage.find((row) => row.label === 'Claude user configuration');
  assert.equal(claudeUserRow.filesystem, true);

  // The Discovery-panel-only flag must never leak onto the inventory's own
  // sourceCoverage, which is built from a separate, already-filtered path
  // (service-inventory.mjs's `projectionSourceCoverage`, straight off
  // `orchestrator.coverage()`, never off this file's `mergedCoverage`).
  await h.service.refreshInventory();
  const rawInventory = createInventorySnapshotStore(path.join(h.controlRoot, 'management'), { fsImpl: fs }).read();
  assert.ok(rawInventory.sourceCoverage.length > 0);
  for (const entry of rawInventory.sourceCoverage) {
    assert.ok(!('filesystem' in entry), 'the inventory sourceCoverage row must not carry the Discovery-only filesystem flag');
  }
});

// ── D9: background drive-to-completion, auto-start, rebuild, failure surfacing ──
// Reviewing a teammate's implementation landed while this agent was rate-
// limited (service-discovery.mjs's `driveSources`/`assertScannable`/
// `rebuildAfterMeasurement`/`awaitScans`, plus D's orchestrator drive-loop
// changes) — these tests exercise that surface rather than re-deriving it.

test('SOURCE_NOT_SCANNABLE: an explicit non-filesystem automatic source id is refused by startScan', async (t) => {
  const h = buildHarness(t);
  await assert.rejects(
    () => h.service.startScan({ sourceId: 'ollama' }),
    (error) => error.code === 'SOURCE_NOT_SCANNABLE' && error.sourceIds.includes('ollama'),
  );
  await assert.rejects(
    () => h.service.startScan({ sourceId: 'runtimes' }),
    (error) => error.code === 'SOURCE_NOT_SCANNABLE',
  );
});

test('saveSource auto-starts the new root without a separate startScan call', async (t) => {
  const h = buildHarness(t);
  const root = fixtureRoot(t);
  fs.mkdirSync(path.join(root, 'project-a', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project-a', 'file.txt'), 'x');
  const preview = h.service.previewSource({ kind: 'collection-root', root });

  const saved = h.service.saveSource({ previewId: preview.previewId, confirmed: true });
  assert.ok(saved.sourceId, 'saveSource must hand back the sourceId it just enrolled');

  // saveSource itself is synchronous and only KICKS OFF the background
  // drive; give the event loop a couple of turns to let it run.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const progress = h.service.scanProgress();
  const row = progress.coverage.find((entry) => entry.sourceId === saved.sourceId);
  assert.ok(row, 'the newly saved source must already appear in coverage');
  assert.ok(['scanning', 'complete'].includes(row.state), `expected scanning or complete without an explicit startScan, got ${row.state}`);
});

test('rebuildAfterMeasurement drives every filesystem source to a terminal state and returns the fresh inventory', async (t) => {
  const h = buildHarness(t);
  const root = fixtureRoot(t);
  fs.mkdirSync(path.join(root, 'project-a', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project-a', 'file.txt'), 'x');
  const preview = h.service.previewSource({ kind: 'collection-root', root });
  const saved = h.service.saveSource({ previewId: preview.previewId, confirmed: true });

  const result = await h.service.rebuildAfterMeasurement();
  assert.ok(isOpaqueId(result.inventory.inventoryId, 'inv'));
  assert.ok(result.scans.coverage.length > 0);

  const ourRow = result.scans.coverage.find((entry) => entry.sourceId === saved.sourceId);
  assert.ok(ourRow, 'the source this test added must be present in the returned scan state');
  assert.equal(ourRow.state, 'complete');

  const midScanStates = new Set(['scanning', 'checkpointed', 'queued']);
  for (const entry of result.scans.coverage) {
    assert.ok(!midScanStates.has(entry.state), `source ${entry.sourceId} must be terminal after rebuildAfterMeasurement, was ${entry.state}`);
  }
});

test('a failing background drive surfaces failed/io-failure on the coverage row rather than a silently stalled scan', async (t) => {
  const root = fixtureRoot(t);
  fs.mkdirSync(path.join(root, 'project-a'), { recursive: true });
  // Configure the collection root directly in kit.json (bypassing
  // previewSource/saveSource, which also walk) so the injected `walk`
  // failure only ever fires for the actual scan drive, not the setup.
  // A `walk` that isn't `walkTree` (or an `instrumentWalkTree` adapter, see
  // the two tests below) fails the orchestrator's own traversal-contract
  // check before any real fs work happens — a generic, uncoded failure that
  // must still surface as `io-failure`, never crash the drive or stall it.
  const sourceId = opaqueId('src', { kind: 'collection-root', root }, INSTALLATION_KEY);
  const h = buildHarness(t, {
    discovery: { collectionRoots: [{ root, sourceId, maxDepth: null, includeNetwork: false }] },
    walk: () => { throw new Error('simulated walk failure'); },
  });

  await h.service.startScan({ sourceId });
  await h.service.awaitScans({ sourceId });
  const progress = h.service.scanProgress();
  const row = progress.coverage.find((entry) => entry.sourceId === sourceId);
  assert.ok(row, 'the source must still be reported, never silently dropped');
  assert.equal(row.state, 'failed');
  assert.equal(row.limitingReason, 'io-failure');
});

test('a failing drive with EACCES/EPERM maps to the closed limitingReason permission-denied, never the raw fs code', async (t) => {
  const root = fixtureRoot(t);
  fs.mkdirSync(path.join(root, 'project-a'), { recursive: true });
  const sourceId = opaqueId('src', { kind: 'collection-root', root }, INSTALLATION_KEY);
  const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  // `walk` must carry the real traversal contract for the injected failure
  // to reach the drive loop as itself rather than as a generic
  // contract-violation error (see the test above): wrap the real `walkTree`
  // with `instrumentWalkTree` and throw from `before`, so the orchestrator
  // accepts `walk` as legitimate and then hits our coded failure before any
  // physical fs traversal.
  const throwingWalk = instrumentWalkTree({ before: () => { throw eacces; } });
  const h = buildHarness(t, {
    discovery: { collectionRoots: [{ root, sourceId, maxDepth: null, includeNetwork: false }] },
    walk: throwingWalk,
  });

  await h.service.startScan({ sourceId });
  await h.service.awaitScans({ sourceId });
  const row = h.service.scanProgress().coverage.find((entry) => entry.sourceId === sourceId);
  assert.equal(row.state, 'failed');
  assert.equal(row.limitingReason, 'permission-denied');
  assert.ok(LIMITING_REASONS.includes(row.limitingReason), 'must be a member of the closed LIMITING_REASONS vocabulary');
});

test('a failing drive with an uncoded or unrecognized error still maps to the closed vocabulary (io-failure), never a raw error code', async (t) => {
  const root = fixtureRoot(t);
  fs.mkdirSync(path.join(root, 'project-a'), { recursive: true });
  const sourceId = opaqueId('src', { kind: 'collection-root', root }, INSTALLATION_KEY);
  const enoent = Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
  const throwingWalk = instrumentWalkTree({ before: () => { throw enoent; } });
  const h = buildHarness(t, {
    discovery: { collectionRoots: [{ root, sourceId, maxDepth: null, includeNetwork: false }] },
    walk: throwingWalk,
  });

  await h.service.startScan({ sourceId });
  await h.service.awaitScans({ sourceId });
  const row = h.service.scanProgress().coverage.find((entry) => entry.sourceId === sourceId);
  assert.equal(row.state, 'failed');
  assert.equal(row.limitingReason, 'io-failure');
  assert.ok(LIMITING_REASONS.includes(row.limitingReason), 'must be a member of the closed LIMITING_REASONS vocabulary');
});

test('pauseScan recognizes the orchestrator SOURCE_NOT_PAUSABLE code as a no-op, not just the legacy message text', async (t) => {
  const h = buildHarness(t);
  const root = fixtureRoot(t);
  fs.mkdirSync(path.join(root, 'a', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'file.txt'), 'x');
  const preview = h.service.previewSource({ kind: 'collection-root', root });
  h.service.saveSource({ previewId: preview.previewId, confirmed: true });
  const [{ sourceId }] = h.service.discovery().collectionRoots;

  await h.service.awaitScans({ sourceId });
  const complete = h.service.scanProgress().coverage.find((entry) => entry.sourceId === sourceId);
  assert.equal(complete.state, 'complete');

  // Pausing an already-complete source hits the orchestrator's own
  // SOURCE_NOT_PAUSABLE code path; this must resolve as a no-op rather than
  // throwing, and without relying on the legacy message-text match.
  const afterPause = h.service.pauseScan({ sourceId });
  assert.equal(afterPause.coverage.find((entry) => entry.sourceId === sourceId).state, 'complete');
});

test('awaitScans resolves immediately when no scan is in flight', async (t) => {
  const h = buildHarness(t);
  const result = await h.service.awaitScans({});
  assert.ok(Array.isArray(result.coverage));
  assert.ok(Array.isArray(result.progress));
});

// ── D6c: lastRefresh reports 'running' to a concurrent reader mid-refresh ──

test("D6c: a concurrent report() during a refresh sees lastRefresh.status 'running'", async (t) => {
  const h = buildHarness(t);
  const refreshPromise = h.service.refreshInventory();
  const duringReport = await h.service.report();
  assert.equal(duringReport.lastRefresh.status, 'running');
  assert.equal(typeof duringReport.lastRefresh.at, 'string');

  await refreshPromise;
  const afterReport = await h.service.report();
  assert.equal(afterReport.lastRefresh.status, 'ok');
});

// ── D3: a never-run source reports not-scanned, never scanning ────────────

test('D3: a fresh installation reports every configured source as not-scanned, never scanning', async (t) => {
  const h = buildHarness(t);
  const progress = h.service.scanProgress();
  assert.ok(progress.coverage.length > 0, 'the default automatic sources must be listed even before any scan runs');
  for (const entry of progress.coverage) {
    assert.equal(entry.state, 'not-scanned', `source ${entry.sourceId} must not be reported as scanning before it has run`);
    assert.equal(entry.visited, 0);
    assert.equal(entry.completedPartitions, 0);
    assert.equal(entry.pendingPartitions, 0);
    assert.equal(entry.limitingReason, null);
  }
  assert.equal(typeof progress.narrative, 'string');
  assert.equal(isProhibitedLabel(progress.narrative), false, 'the narrative must carry no prohibited label');
});

test("the inventory's sourceCoverage excludes non-filesystem automatic sources; partialSources names only the filesystem ones", async (t) => {
  const h = buildHarness(t);
  await h.service.refreshInventory();

  // scanProgress()/discovery() (the Discovery panel) still list all 8 —
  // runtimes/package-managers/ollama/providers are legitimately "covered by
  // the provider check" there.
  const progress = h.service.scanProgress();
  assert.equal(progress.coverage.length, 8);

  // The inventory's own partialSources (fed by SourceCoverage rows actually
  // handed to buildManagementInventory) must drop the four non-filesystem
  // ones entirely, leaving only the four filesystem automatic sources
  // (claude-user/codex-user/opencode-user/hermes-user; this harness
  // configures no exact projects/collection roots).
  const page = h.service.inventory({});
  assert.equal(page.partialSources.total, 4, 'only the 4 filesystem automatic sources should remain not-scanned in the inventory');
  assert.equal(page.partialSources.entries.length, 4);
  const nonFilesystemLabels = new Set(['Runtimes', 'Package managers', 'Ollama', 'Providers']);
  for (const entry of page.partialSources.entries) {
    assert.ok(!nonFilesystemLabels.has(entry.label), `${entry.label} must not appear in the inventory's partialSources`);
  }
});

// ── ACT-001: activity aggregates receipts, dispositions, and scan history ──

test('ACT-001: activity() aggregates an unfinished receipt into recovery', async (t) => {
  const h = buildHarness(t);
  writeReceipt(h.transactionsRoot);
  const activity = h.service.activity();
  assert.equal(activity.recovery.length, 1);
  assert.equal(activity.recovery[0].receiptId, INTERRUPTED_RECEIPT.id);
  assert.equal(activity.receipts.length, 1);
});

// ── RCV-005/006: auditInterruption is read-only; reconcile is gated ────────

test('RCV-005: auditInterruption reads an unfinished receipt without mutating it', async (t) => {
  const h = buildHarness(t);
  writeReceipt(h.transactionsRoot);
  const [audit] = await h.service.auditInterruption({ receiptIds: [INTERRUPTED_RECEIPT.id] });
  assert.equal(audit.receiptId, INTERRUPTED_RECEIPT.id);
  assert.equal(audit.integrity, 'valid');
  assert.ok(Array.isArray(audit.checks));

  const activityAfter = h.service.activity();
  assert.equal(activityAfter.recovery.length, 1, 'the audit must not resolve the receipt');
});

test('RCV-006: reconcile refuses without explicit confirmation', async (t) => {
  const h = buildHarness(t);
  writeReceipt(h.transactionsRoot);
  await assert.rejects(() => h.service.reconcile({ receiptId: INTERRUPTED_RECEIPT.id, outcome: 'record-no-change' }));
});

// ── planAction: correlates a placement to exactly one finding ─────────────

test('planAction: resolves a placement to its exact finding and delegates to the transaction engine', async (t) => {
  const h = buildHarness(t, { footprint: updatableLightpandaFootprint() });
  await h.service.refreshInventory();
  const page = h.service.inventory({});
  const [group] = page.groups;
  const [row] = group.placements;

  // The synthetic `update-available` lifecycle exists only so the legacy
  // scanner emits a finding to correlate against; no registered provider
  // backs a generic catalog update, so the transaction engine correctly
  // refuses to plan it (T's own domain — see maintenance-one-action.test.mjs
  // for provider-backed executable plans). Reaching THAT refusal, rather
  // than `PLACEMENT_FINDING_UNRESOLVED`, proves the facade's correlation
  // step succeeded and delegated to `maintenance.planAction`.
  await assert.rejects(
    () => h.service.planAction({ placementId: row.placementId }),
    (error) => error.code !== 'PLACEMENT_FINDING_UNRESOLVED' && /not executable/.test(error.message),
  );
});

test('planAction: refuses an unresolved placement (unknown placementId)', async (t) => {
  const h = buildHarness(t);
  await h.service.refreshInventory();
  await assert.rejects(
    () => h.service.planAction({ placementId: 'plc_00000000000000000000000000' }),
    (error) => error.code === 'PLACEMENT_FINDING_UNRESOLVED',
  );
});

// ── Dispositions: recorded, then invalidated on inventory drift ───────────
// Seeds the sentinel J1/J9 inventory directly (see file header) so this
// exercises the FACADE's own recordDisposition/invalidation composition
// against an already-admitted guidance entry.

test('dispositions: recordDisposition requires confirmed:true', async (t) => {
  const h = buildHarness(t);
  seedLastGoodInventory(h.controlRoot, baseInventory());
  const guidance = h.service.guidance({ lane: 'steps' });
  assert.ok(guidance.entries.length > 0, 'the sentinel fixture carries a steps-lane entry');
  const [entry] = guidance.entries;
  assert.throws(() => h.service.recordDisposition({ guidanceId: entry.guidanceId, kind: 'acknowledged' }));
});

test('dispositions: recorded then invalidated when the source fingerprint drifts', async (t) => {
  const h = buildHarness(t);
  seedLastGoodInventory(h.controlRoot, baseInventory());
  const guidance = h.service.guidance({ lane: 'steps' });
  const [entry] = guidance.entries;

  const record = await h.service.recordDisposition({
    guidanceId: entry.guidanceId, kind: 'snoozed', until: '2099-01-01T00:00:00.000Z', confirmed: true,
  });
  assert.equal(record.record.kind, 'snoozed');

  let dispositions = h.service.dispositions();
  assert.equal(dispositions.length, 1);
  assert.equal(dispositions[0].invalidatedAt, null);

  // Re-seed the SAME sentinel inventory but with a drifted sourceFingerprint
  // (a real evidence change) and re-run just the invalidation step the
  // facade runs on every refresh, over the disposition store directly —
  // proving the facade captured a real, comparable `invalidationInputs`
  // snapshot at record time (see service-activity.mjs#invalidationInputsFor).
  const drifted = { ...baseInventory(), sourceFingerprint: 'fp-drifted' };
  seedLastGoodInventory(h.controlRoot, drifted);
  const guidanceAfterDrift = h.service.guidance({ lane: 'steps' });
  assert.ok(guidanceAfterDrift.entries.length > 0);

  // Directly drive the SAME invalidation the facade runs during
  // `refreshInventory` (guidance()/inventory() are pure reads and never
  // invalidate on their own — see MNT-PERF-001).
  const { createDispositionStore } = await import('../../src/lib/maintenance/management/dispositions.mjs');
  const store = createDispositionStore({ root: path.join(h.controlRoot, 'management'), fsImpl: fs });
  store.invalidateDispositions({ inventory: drifted, now: new Date(NOW_MS) });

  dispositions = h.service.dispositions();
  assert.equal(dispositions.length, 1);
  assert.notEqual(dispositions[0].invalidatedAt, null, 'the disposition must invalidate on source fingerprint drift');
});

// ── Recipes ─────────────────────────────────────────────────────────────────

test('recipes(): returns the built-in catalogue with no pending entries until a refresh stages one', async (t) => {
  const h = buildHarness(t);
  const { recipes, pending } = h.service.recipes();
  assert.ok(recipes.length > 0, 'the built-in signed catalogue ships without any refresh');
  assert.ok(recipes.every((recipe) => recipe.state === 'active'));
  assert.deepEqual(pending, []);
});

test('withdrawRecipe: refuses a recipeId that has never been staged or accepted, even without a version', async (t) => {
  const h = buildHarness(t);
  assert.throws(() => h.service.withdrawRecipe({ recipeId: 'never-existed', confirmed: true }));
});

// ── scanRequired envelopes when nothing has been saved yet ────────────────

test('scanRequired: report/inventory/placement/guidance return a scanRequired envelope before any refresh', async (t) => {
  const h = buildHarness(t);
  const report = await h.service.report();
  assert.equal(report.scanRequired, true);

  const page = h.service.inventory({});
  assert.equal(page.scanRequired, true);
  assert.deepEqual(page.groups, []);

  const inspector = h.service.placement({ placementId: 'plc_anything00000000000000000' });
  assert.equal(inspector.scanRequired, true);

  const guidance = h.service.guidance({});
  assert.equal(guidance.scanRequired, true);
  assert.deepEqual(guidance.entries, []);
});

// ── Preferences ─────────────────────────────────────────────────────────────

test('preferences: setPreferredShell persists per environment', async (t) => {
  const h = buildHarness(t);
  await h.service.refreshInventory();
  const page = h.service.inventory({});
  const [group] = page.groups;
  const [row] = group.placements;
  const inspector = h.service.placement({ placementId: row.placementId });
  const environmentId = inspector.whatIsThis.environmentId;
  await h.service.setPreferredShell({ environmentId, shell: 'zsh' });
  const stored = h.service.preferences({});
  assert.equal(stored.preferredShellByEnvironment[environmentId], 'zsh');
});

// ── Public return values are deep-frozen (except revealLocator/discovery) ──

test('every public inventory/activity return value is deep-frozen', async (t) => {
  const h = buildHarness(t);
  await h.service.refreshInventory();
  const page = h.service.inventory({});
  assert.ok(Object.isFrozen(page));
  assert.ok(Object.isFrozen(page.groups));
  const activity = h.service.activity();
  assert.ok(Object.isFrozen(activity));
});


test('MNT-DSC-011/012 (D9): startScan drives a multi-partition source to complete without any external resume', async (t) => {
  const h = buildHarness(t);
  const root = fixtureRoot(t);
  for (const name of ['a', 'b', 'c', 'd']) {
    fs.mkdirSync(path.join(root, name, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'file.txt'), 'x');
  }
  const preview = h.service.previewSource({ kind: 'collection-root', root });
  h.service.saveSource({ previewId: preview.previewId, confirmed: true });
  const [{ sourceId }] = h.service.discovery().collectionRoots;

  const first = await h.service.startScan({ sourceId });
  assert.ok(first.coverage.some((entry) => entry.sourceId === sourceId));
  const settled = await h.service.awaitScans({ sourceId });
  const row = settled.coverage.find((entry) => entry.sourceId === sourceId);
  assert.equal(row.state, 'complete', `a stable finite source must reach complete on its own, got ${row.state}`);
  assert.equal(row.pendingPartitions, 0);
  assert.ok(row.visited > 0);
  assert.equal(h.service.pauseScan({ sourceId }).coverage.find((entry) => entry.sourceId === sourceId).state, 'complete',
    'pausing a finished source is a no-op, not an error');
  assert.equal(h.service.stopScan({ sourceId, confirmed: true }).confirmed, true, 'stopping a finished source is legal');
});

test('D9: a second startScan for a source already in flight does not start a second drive', async (t) => {
  const h = buildHarness(t);
  const root = fixtureRoot(t);
  fs.mkdirSync(path.join(root, 'a', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'file.txt'), 'x');
  const preview = h.service.previewSource({ kind: 'collection-root', root });
  h.service.saveSource({ previewId: preview.previewId, confirmed: true });
  const [{ sourceId }] = h.service.discovery().collectionRoots;
  await Promise.all([h.service.startScan({ sourceId }), h.service.startScan({ sourceId })]);
  const settled = await h.service.awaitScans({ sourceId });
  const row = settled.coverage.find((entry) => entry.sourceId === sourceId);
  assert.equal(row.state, 'complete');
  assert.equal(settled.progress.filter((entry) => entry.sourceId === sourceId).length, 1, 'one record per source');
});

test('D6b: lastRefresh reads running while a refresh is in flight and ok once it settles', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = buildHarness(t, { collectorRead: async () => { await gate; return lightpandaFootprint(); } });
  const flight = h.service.refreshInventory({});
  await new Promise((resolve) => setImmediate(resolve));
  const during = await h.service.report();
  assert.equal(during.lastRefresh?.status, 'running');
  assert.equal(h.service.inventory({}).lastRefresh?.status, 'running');
  release();
  await flight;
  const after = await h.service.report();
  assert.equal(after.lastRefresh?.status, 'ok');
  assert.equal(after.scanRequired, false);
});
