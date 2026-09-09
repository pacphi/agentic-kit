import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { run } from '../../src/commands/maintain.mjs';
import { isProhibitedLabel } from '../../src/lib/maintenance/management/model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin', 'agentic-kit.mjs');

async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const code = await fn();
    return { code, text: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

// ── Fixtures shared by the dispatch and sweep tests below ──────────────────
// A single stub facade/management object exercises every ADR-0048 verb this
// CLI dispatches to. Shapes mirror the documented facade contract
// (ORCHESTRATION.md "I — facade") and the sentinel fixtures' vocabulary
// (tests/fixtures/maintenance/management-fixtures.mjs) without depending on
// the facade module itself, which is built in parallel by another agent.

const FIXTURE_PLACEMENT_ID = 'plc_fixturePlacement00000000';
const FIXTURE_GUIDANCE_ID = 'gid_fixtureGuidance000000000';
const FIXTURE_RECEIPT_ID = 'mnt-receipt-fixture';
const REVEAL_PATH_MARKER = '/Users/fixture-owner/reveal-only-lightpanda';

const readModel = {
  schemaVersion: 1,
  mode: 'read-only',
  capabilities: { plan: true, apply: false, undo: false },
  asOf: '2026-09-03T12:00:00.000Z',
  freshness: { status: 'fresh', completeness: 'complete', gaps: [] },
  sourceFingerprint: 'source-a',
  summary: { updatesReady: 0, safeCleanup: 1, needsReview: 0, unsupportedOrBlocked: 0, recentChanges: 0 },
  findings: [{ id: 'finding-a', state: 'orphaned-cache', bucket: 'safeCleanup',
    resource: { id: 'cache:a', kind: 'regenerable-cache', name: 'Cache A' } }],
  receipts: [],
};

const executablePlan = {
  schemaVersion: 1, mode: 'executable', planId: 'maintenance-plan-a', planDigest: 'digest-a',
  sourceFingerprint: 'source-a', safetyClass: 'approval-required', expiresAt: '2026-09-05T13:00:00.000Z',
  actions: [{ id: 'action-a' }],
};

const inventoryPage = {
  schema: 'maintenance-management-query/v2',
  inventoryId: 'inv_fixtureInventory00000000',
  total: 1,
  groups: [{
    resourceId: 'res_fixtureLightpanda00000',
    displayName: 'Lightpanda MCP',
    kind: 'mcp-registration',
    placementCount: 1,
    consumerCount: 1,
    placements: [{
      placementId: FIXTURE_PLACEMENT_ID,
      displayName: 'Lightpanda MCP',
      scope: { value: 'user', label: 'User', icon: null },
      breadcrumb: ['Claude', 'MCP servers'],
      versions: {},
      carrier: null,
      consumerHosts: ['claude'],
      guidanceLane: { value: 'steps', label: 'Steps available' },
      rowAction: { verb: null, label: 'Open details' },
    }],
  }],
  facetCounts: {},
  sortGroups: [{ bucket: 'steps', label: 'Steps available', count: 1 }],
  partialSources: [],
  appliedFacets: {},
};

const inspector = {
  whatIsThis: {
    displayName: 'Lightpanda MCP', kind: 'mcp-registration', kindLabel: 'MCP registration',
    placementId: FIXTURE_PLACEMENT_ID, environmentId: 'env_fixtureMac00000000000000',
    conditions: ['missing-verified-dependency'], conditionLabels: ['Missing verified dependency'],
  },
  whereIsIt: { scope: 'user', breadcrumb: ['Claude', 'MCP servers'], carrier: null },
  whereDidItComeFrom: undefined,
  whatVersionIsHere: {},
  whoUsesIt: { consumers: [{ consumerKind: 'host', consumerLabel: 'Claude', enabled: true }], reverseDependencies: [] },
  whatChangedOrConflicts: [],
  whatCanIAccomplish: [{ lane: 'steps', outcome: 'Reinstall the missing lightpanda executable.' }],
  whatProvesThis: { evidenceScorecard: {}, technicalDetails: [] },
  whatHappenedBefore: { receipts: [], dispositions: [], coverage: [] },
};

// Mirrors the real facade's revealLocator({placementId}) -> {placementId, ...locator}
// (src/lib/maintenance/management/service-inventory.mjs): a path, an optional
// selector/file, and no breadcrumb.
const revealed = {
  placementId: FIXTURE_PLACEMENT_ID, path: REVEAL_PATH_MARKER, selector: 'mcpServers.lightpanda',
};

const guidanceEntry = {
  guidanceId: FIXTURE_GUIDANCE_ID, placementId: FIXTURE_PLACEMENT_ID, lane: 'steps',
  outcome: 'Reinstall the missing lightpanda executable.',
  impact: { summary: 'Restores the missing binary; nothing else changes.' },
};
const guidanceResult = {
  counts: { apply: 0, steps: 1, decision: 0, update: 0, recovery: 0, total: 1 },
  lanes: { apply: [], steps: [guidanceEntry], decision: [], update: [], recovery: [] },
  entries: [guidanceEntry],
};

const procedureResult = {
  outcome: 'Reinstalls the Lightpanda executable.',
  source: { authority: 'agentic-kit-builtin', publisher: 'agentic-kit', recipeVersion: '1' },
  compatibility: { shells: ['bash', 'zsh'] },
  privilege: 'none',
  network: 'required',
  effect: 'Reinstalls the Lightpanda executable.',
  preserved: [],
  command: { shell: 'zsh', shellLabel: 'zsh', text: "'brew' 'reinstall' 'lightpanda'" },
  verification: { shell: 'zsh', shellLabel: 'zsh', text: "'lightpanda' '--version'" },
  checklist: [{ stepId: 'review', label: 'Review the zsh command before running it.' }],
};

const discoveryResult = {
  automaticSources: [{ id: 'claude-user', enabled: true }],
  exactProjects: [{ root: '/Users/fixture-owner/one-off-project' }],
  collectionRoots: [{ root: '/Users/fixture-owner/projects' }],
  exclusions: [{ path: '/Users/fixture-owner/projects/scratch', recursive: true }],
  // One complete source and one never-run source (SOURCE_COVERAGE_STATES'
  // 'not-scanned', added alongside SOURCE_COVERAGE_LABELS) — human output
  // must render the label, never the raw token, and hint at starting it.
  coverage: [
    { sourceId: 'src_claudeUser00000000000000', label: 'Claude user configuration', state: 'complete' },
    { sourceId: 'src_neverRun0000000000000000', label: 'Ollama', state: 'not-scanned', visited: 0, completedPartitions: 0 },
  ],
  progress: 'Scanned 128 entries. 1 of 2 sources are complete.',
  history: [],
};

const activityResult = {
  recovery: [{ receiptId: FIXTURE_RECEIPT_ID, statusLabel: 'Interrupted', primaryActionLabel: 'Audit interruption' }],
  inProgress: [],
  receipts: [{ receiptId: FIXTURE_RECEIPT_ID, statusLabel: 'Interrupted' }],
  dispositions: [],
  recipes: [],
  scans: [],
};

const receiptDetail = {
  receiptId: FIXTURE_RECEIPT_ID, result: 'Interrupted', provider: { id: 'claude-plugin', version: '1' },
  operation: 'update', restart: 'not-required', rollback: 'reversible', preserved: [],
};

const auditResults = [
  {
    receiptId: FIXTURE_RECEIPT_ID, result: 'matches-recorded-before-state', conclusive: true,
    enables: 'record-no-change', checks: [], failedComparisons: [], nextSteps: [],
  },
  {
    receiptId: 'mnt-receipt-inconclusive', result: 'differs-from-both-recorded-states', conclusive: false,
    enables: null, checks: [], failedComparisons: ['preimage-comparison'], nextSteps: ['No corrective action is offered.'],
  },
];

// Mirrors the real facade's recipes() -> {recipes: [...], pending: [...]}
// (service-actions.mjs), not a bare array.
const recipesResult = {
  recipes: [{ recipeId: 'rcp_fixtureRecipe000000000', recipeVersion: '1', state: 'active' }],
  pending: [],
};
const preferencesResult = { lastView: 'all', scope: 'across' };
// Mirrors the real facade's scanProgress() -> {coverage, narrative, forbiddenClaims}
// (service-discovery.mjs); startScan/resumeScan return this same envelope.
const scanProgressResult = {
  coverage: [{ label: 'Claude user configuration', state: 'complete' }],
  narrative: 'Scanned 128 entries. 1 of 1 sources are complete.',
  forbiddenClaims: [],
};
const sourcePreview = { previewId: 'prv_fixturePreview000000000', root: '/Users/fixture-owner/projects', projectsFound: [] };
// removeSource({confirmed:false}) -> {confirmed:false, preview:{before,after}} (a
// discovery-config summary); stopScan({confirmed:false}) -> {confirmed:false,
// preview:{sourceId,label,visited,completedPartitions}} (real shapes, both nested
// under `preview`, per service-discovery.mjs and discovery/orchestrator.mjs).
const affectedPreviewRemove = { confirmed: false, preview: { before: {}, after: {} } };
const affectedPreviewStop = {
  confirmed: false,
  preview: { sourceId: 'src_a', label: 'Claude user configuration', visited: 128, completedPartitions: 2 },
};

function buildManagement(overrides = {}) {
  const calls = [];
  const record = (method) => (...args) => { calls.push({ method, args }); return overrides[method]?.(...args) ?? DEFAULTS[method]; };
  const DEFAULTS = {
    refreshInventory: { inventoryId: inventoryPage.inventoryId, capturedAt: '2026-09-05T12:00:00.000Z' },
    inventory: inventoryPage,
    placement: inspector,
    revealLocator: revealed,
    guidance: guidanceResult,
    procedure: procedureResult,
    discovery: discoveryResult,
    previewSource: sourcePreview,
    saveSource: { confirmed: true, saved: true, kind: 'collection-root', root: '/Users/fixture-owner/projects' },
    removeSource: affectedPreviewRemove,
    setAutomaticSource: { ok: true, status: 'updated' },
    addExclusion: { ok: true, status: 'excluded' },
    removeExclusion: { ok: true, status: 'unexcluded' },
    rebuildAfterMeasurement: {
      inventory: { inventoryId: inventoryPage.inventoryId, capturedAt: '2026-09-05T12:00:00.000Z' },
      scans: scanProgressResult,
    },
    startScan: scanProgressResult,
    // pauseScan/resumeScan are symmetric on the real facade: both accept
    // {sourceId} or {sourceIds} and both return the full scanProgress()
    // envelope, not a single coverage record.
    pauseScan: scanProgressResult,
    resumeScan: scanProgressResult,
    awaitScans: scanProgressResult,
    stopScan: affectedPreviewStop,
    scanProgress: scanProgressResult,
    activity: activityResult,
    receipt: receiptDetail,
    exportReceipt: receiptDetail,
    auditInterruption: auditResults,
    reconcile: { ok: true, status: 'reconciled', receiptId: FIXTURE_RECEIPT_ID },
    recordDisposition: { ok: true, status: 'recorded' },
    planAction: executablePlan,
    recipes: recipesResult,
    refreshRecipes: { ok: true, status: 'refreshed' },
    acceptRecipe: { ok: true, status: 'accepted' },
    withdrawRecipe: { ok: true, status: 'withdrawn' },
    preferences: preferencesResult,
    savePreferences: { ok: true, status: 'saved' },
  };
  const management = {};
  for (const method of Object.keys(DEFAULTS)) management[method] = record(method);
  management.calls = calls;
  return management;
}

function buildService(overrides = {}) {
  const calls = [];
  return {
    calls,
    async scan(options) { calls.push({ method: 'scan', args: [options] }); return overrides.scan ?? readModel; },
    async plan(options) { calls.push({ method: 'plan', args: [options] }); return overrides.plan ?? executablePlan; },
    async apply(options) {
      calls.push({ method: 'apply', args: [options] });
      return overrides.apply ?? { ok: true, status: 'committed', receiptId: FIXTURE_RECEIPT_ID };
    },
    async undo(options) {
      calls.push({ method: 'undo', args: [options] });
      return overrides.undo ?? { ok: true, status: 'rolled-back', receiptId: FIXTURE_RECEIPT_ID };
    },
  };
}

// ── Help surface ─────────────────────────────────────────────────────────────

test('maintain is porcelain and its help advertises exact guarded actions', () => {
  const help = spawnSync(process.execPath, [BIN, 'maintain', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /ak maintain scan/);
  assert.match(help.stdout, /apply.*--plan.*--digest.*--actions.*--yes/i);
  assert.match(help.stdout, /ak maintain recover --receipt/i);
  assert.match(help.stdout, /recover is a read-only alias for audit/i);
  assert.match(help.stdout, /exactly one exact action id/i);
  const rootHelp = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(rootHelp.stdout, /ak maintain/);
});

// ── Legacy v1 verbs: scan / plan / apply / undo stay byte-for-byte (MNT-ACT-001) ─

test('scan delegates deep explicitly and emits the read DTO as JSON', async () => {
  const service = buildService();
  const result = await captureLogs(() => run({
    flags: { json: true, deep: true }, positionals: ['scan'], deps: { service },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(service.calls, [{ method: 'scan', args: [{ deep: true }] }]);
  assert.equal(JSON.parse(result.text).mode, 'read-only');
});

test('scan --refresh-inventory (non-deep) calls management.refreshInventory after the provider scan', async () => {
  const service = buildService();
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { json: true, 'refresh-inventory': true },
    positionals: ['scan'], deps: { service, management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(service.calls, [{ method: 'scan', args: [{ deep: false }] }]);
  assert.deepEqual(management.calls, [{ method: 'refreshInventory', args: [{ deep: false }] }]);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.schema, 'ak-maintain/v2');
  assert.equal(parsed.result.scan.mode, 'read-only');
  assert.equal(parsed.result.inventory.inventoryId, inventoryPage.inventoryId);
});

test('scan --deep --refresh-inventory calls management.rebuildAfterMeasurement, not refreshInventory', async () => {
  const service = buildService();
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { json: true, deep: true, 'refresh-inventory': true },
    positionals: ['scan'], deps: { service, management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(service.calls, [{ method: 'scan', args: [{ deep: true }] }]);
  // A machine measurement (--deep) drives every discovery source to a
  // terminal state and rebuilds in one call; the CLI never calls
  // refreshInventory directly in this path.
  assert.deepEqual(management.calls, [{ method: 'rebuildAfterMeasurement', args: [] }]);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.schema, 'ak-maintain/v2');
  assert.equal(parsed.result.scan.mode, 'read-only');
  assert.equal(parsed.result.inventory.inventoryId, inventoryPage.inventoryId);
});

test('plan passes exact finding selection and emits an immutable-plan envelope', async () => {
  const service = buildService({ plan: {
    schemaVersion: 1, mode: 'read-only', planId: 'plan-a', planDigest: 'digest-a',
    sourceFingerprint: 'source-a', safetyClass: 'safe-automatic', actions: [],
  } });
  const result = await captureLogs(() => run({
    flags: { json: true, findings: 'b,a', project: '/repo' },
    positionals: ['plan'], deps: { service },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(service.calls, [{ method: 'plan', args: [{ deep: false, findingIds: ['a', 'b'], project: '/repo' }] }]);
  assert.equal(JSON.parse(result.text).planId, 'plan-a');
});

test('executable plan persistence is explicit', async () => {
  const service = buildService();
  const result = await captureLogs(() => run({
    flags: { json: true, executable: true, findings: 'a' }, positionals: ['plan'], deps: { service },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(service.calls, [{
    method: 'plan', args: [{ deep: false, findingIds: ['a'], project: null, executable: true, persist: true }],
  }]);
});

test('plan --findings a,b --executable refuses before any service call (MNT-ACT-001)', async () => {
  const service = buildService();
  const result = await captureLogs(() => run({
    flags: { executable: true, findings: 'a,b' }, positionals: ['plan'], deps: { service },
  }));
  assert.equal(result.code, 2);
  assert.match(result.text, /exactly one action/i);
  assert.deepEqual(service.calls, []);
});

test('plan --placement --executable dispatches management.planAction as one action', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { json: true, placement: FIXTURE_PLACEMENT_ID, guidance: FIXTURE_GUIDANCE_ID, executable: true },
    positionals: ['plan'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{
    method: 'planAction', args: [{ placementId: FIXTURE_PLACEMENT_ID, guidanceId: FIXTURE_GUIDANCE_ID }],
  }]);
  assert.equal(JSON.parse(result.text).planId, 'maintenance-plan-a');
});

test('plan --placement without --executable is a usage error', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { placement: FIXTURE_PLACEMENT_ID }, positionals: ['plan'], deps: { management },
  }));
  assert.equal(result.code, 2);
  assert.match(result.text, /--executable/);
  assert.deepEqual(management.calls, []);
});

test('apply requires --plan, --digest, --actions, and --yes, and forwards exactly one action id', async () => {
  const service = buildService();
  const missing = await captureLogs(() => run({ flags: {}, positionals: ['apply'], deps: { service } }));
  assert.equal(missing.code, 2);
  assert.match(missing.text, /--plan.*--digest.*--actions.*--yes/i);
  const result = await captureLogs(() => run({
    flags: { json: true, plan: 'maintenance-plan-a', digest: 'digest-a', actions: 'action-a', yes: true },
    positionals: ['apply'], deps: { service },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(service.calls, [{
    method: 'apply',
    args: [{ planId: 'maintenance-plan-a', expectedPlanDigest: 'digest-a', actionIds: ['action-a'], confirmed: true }],
  }]);
  assert.equal(JSON.parse(result.text).receiptId, FIXTURE_RECEIPT_ID);
});

test('apply --actions a,b refuses before any service call (MNT-ACT-001)', async () => {
  const service = buildService();
  const result = await captureLogs(() => run({
    flags: { plan: 'maintenance-plan-a', digest: 'digest-a', actions: 'a,b', yes: true },
    positionals: ['apply'], deps: { service },
  }));
  assert.equal(result.code, 2);
  assert.match(result.text, /exactly one exact action id/i);
  assert.deepEqual(service.calls, []);
});

test('undo requires a receipt and explicit confirmation', async () => {
  const service = buildService();
  const missing = await captureLogs(() => run({ flags: { receipt: 'mnt-a' }, positionals: ['undo'], deps: { service } }));
  assert.equal(missing.code, 2);
  assert.match(missing.text, /--receipt.*--yes/i);
  const result = await captureLogs(() => run({
    flags: { json: true, receipt: 'mnt-a', yes: true }, positionals: ['undo'], deps: { service },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(service.calls, [{ method: 'undo', args: [{ receiptId: 'mnt-a', confirmed: true }] }]);
});

// ── recover: read-only compatibility alias for audit (MNT-RCV-001, MNT-RCV-004) ─

test('recover requires --receipt, calls the read-only audit, and never mutates', async () => {
  const management = buildManagement();
  const missing = await captureLogs(() => run({ flags: {}, positionals: ['recover'], deps: { management } }));
  assert.equal(missing.code, 2);
  assert.match(missing.text, /--receipt/);
  const result = await captureLogs(() => run({
    flags: { json: true, receipt: FIXTURE_RECEIPT_ID }, positionals: ['recover'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{ method: 'auditInterruption', args: [{ receiptIds: [FIXTURE_RECEIPT_ID] }] }]);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.schema, 'ak-maintain/v2');
  assert.equal(parsed.verb, 'recover');
  assert.equal(parsed.result.receiptId, FIXTURE_RECEIPT_ID);
});

test('recover human output explains that recording now requires reconcile', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { receipt: FIXTURE_RECEIPT_ID }, positionals: ['recover'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.match(result.text, /read-only compatibility alias for audit/i);
  assert.match(result.text, /ak maintain reconcile --receipt/i);
});

// ── audit: batched, read-only, never mutates (MNT-ACT-002, MNT-RCV-001/005) ──

test('audit requires --receipts and batches the read-only audit', async () => {
  const management = buildManagement();
  const missing = await captureLogs(() => run({ flags: {}, positionals: ['audit'], deps: { management } }));
  assert.equal(missing.code, 2);
  assert.match(missing.text, /--receipts/);
  const result = await captureLogs(() => run({
    flags: { json: true, receipts: `${FIXTURE_RECEIPT_ID},mnt-receipt-inconclusive` },
    positionals: ['audit'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{
    method: 'auditInterruption', args: [{ receiptIds: [FIXTURE_RECEIPT_ID, 'mnt-receipt-inconclusive'] }],
  }]);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.schema, 'ak-maintain/v2');
  assert.equal(parsed.result.length, 2);
});

test('audit renders which single Record outcome it enables, or No corrective action (MNT-RCV-007/008)', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { receipts: `${FIXTURE_RECEIPT_ID},mnt-receipt-inconclusive` }, positionals: ['audit'], deps: { management },
  }));
  assert.match(result.text, /Record no change/);
  assert.match(result.text, /No corrective action is offered\./);
});

// ── reconcile: one confirmed receipt write (MNT-RCV-006) ────────────────────

test('reconcile validates the outcome enum and requires --yes', async () => {
  const management = buildManagement();
  const missingYes = await captureLogs(() => run({
    flags: { receipt: FIXTURE_RECEIPT_ID, outcome: 'record-no-change' }, positionals: ['reconcile'], deps: { management },
  }));
  assert.equal(missingYes.code, 2);
  assert.deepEqual(management.calls, []);
  const badOutcome = await captureLogs(() => run({
    flags: { receipt: FIXTURE_RECEIPT_ID, outcome: 'record-everything', yes: true },
    positionals: ['reconcile'], deps: { management },
  }));
  assert.equal(badOutcome.code, 2);
  assert.match(badOutcome.text, /--outcome must be one of/);
  assert.deepEqual(management.calls, []);
  const result = await captureLogs(() => run({
    flags: { json: true, receipt: FIXTURE_RECEIPT_ID, outcome: 'record-no-change', yes: true },
    positionals: ['reconcile'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{
    method: 'reconcile', args: [{ receiptId: FIXTURE_RECEIPT_ID, outcome: 'record-no-change', confirmed: true }],
  }]);
});

// ── disposition ──────────────────────────────────────────────────────────────

test('disposition validates --kind and --until and requires --yes', async () => {
  const management = buildManagement();
  const badKind = await captureLogs(() => run({
    flags: { guidance: FIXTURE_GUIDANCE_ID, kind: 'ignored-forever', yes: true },
    positionals: ['disposition'], deps: { management },
  }));
  assert.equal(badKind.code, 2);
  assert.match(badKind.text, /--kind must be one of/);
  const badUntil = await captureLogs(() => run({
    flags: { guidance: FIXTURE_GUIDANCE_ID, kind: 'snoozed', until: 'not-a-date', yes: true },
    positionals: ['disposition'], deps: { management },
  }));
  assert.equal(badUntil.code, 2);
  assert.match(badUntil.text, /--until must be an ISO timestamp/);
  assert.deepEqual(management.calls, []);
  const result = await captureLogs(() => run({
    flags: { json: true, guidance: FIXTURE_GUIDANCE_ID, kind: 'acknowledged', yes: true },
    positionals: ['disposition'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{
    method: 'recordDisposition', args: [{ guidanceId: FIXTURE_GUIDANCE_ID, kind: 'acknowledged', confirmed: true }],
  }]);
});

// ── inventory ────────────────────────────────────────────────────────────────

test('inventory dispatches scope/view/facet/search/sort/cursor/limit exactly', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: {
      json: true, scope: 'user', view: 'steps', facet: ['kind=mcp-registration', 'kind=skill'],
      search: 'lightpanda', sort: 'guidance-first', cursor: 'abc', limit: '10',
    },
    positionals: ['inventory'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{
    method: 'inventory',
    args: [{
      scope: 'user', view: 'steps', facets: { kind: ['mcp-registration', 'skill'] },
      search: 'lightpanda', sort: 'guidance-first', cursor: 'abc', limit: 10,
    }],
  }]);
  // inventory carries its own schema field, so --json emits it unwrapped.
  assert.equal(JSON.parse(result.text).schema, 'maintenance-management-query/v2');
});

test('inventory validates facet name=value shape and rejects an unrecognized facet', async () => {
  const management = buildManagement();
  const badShape = await captureLogs(() => run({
    flags: { facet: ['kind'] }, positionals: ['inventory'], deps: { management },
  }));
  assert.equal(badShape.code, 2);
  const badName = await captureLogs(() => run({
    flags: { facet: ['notAFacet=value'] }, positionals: ['inventory'], deps: { management },
  }));
  assert.equal(badName.code, 2);
  assert.match(badName.text, /not a recognized facet/);
  assert.deepEqual(management.calls, []);
});

// ── show ─────────────────────────────────────────────────────────────────────

test('show dispatches management.placement, and --reveal dispatches management.revealLocator', async () => {
  const management = buildManagement();
  const missing = await captureLogs(() => run({ flags: {}, positionals: ['show'], deps: { management } }));
  assert.equal(missing.code, 2);
  const inspected = await captureLogs(() => run({
    flags: { json: true, placement: FIXTURE_PLACEMENT_ID }, positionals: ['show'], deps: { management },
  }));
  assert.equal(inspected.code, 0);
  assert.deepEqual(management.calls, [{ method: 'placement', args: [{ placementId: FIXTURE_PLACEMENT_ID }] }]);
  assert.doesNotMatch(inspected.text, new RegExp(REVEAL_PATH_MARKER.replace(/\//g, '\\/')));
  const revealedResult = await captureLogs(() => run({
    flags: { placement: FIXTURE_PLACEMENT_ID, reveal: true }, positionals: ['show'], deps: { management },
  }));
  assert.equal(revealedResult.code, 0);
  assert.match(revealedResult.text, new RegExp(REVEAL_PATH_MARKER.replace(/\//g, '\\/')));
});

// ── guidance / procedure ─────────────────────────────────────────────────────

test('guidance validates --lane and dispatches management.guidance', async () => {
  const management = buildManagement();
  const badLane = await captureLogs(() => run({ flags: { lane: 'urgent' }, positionals: ['guidance'], deps: { management } }));
  assert.equal(badLane.code, 2);
  const result = await captureLogs(() => run({
    flags: { json: true, lane: 'steps' }, positionals: ['guidance'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{ method: 'guidance', args: [{ lane: 'steps' }] }]);
});

test('procedure requires --guidance, validates --shell, and dispatches management.procedure', async () => {
  const management = buildManagement();
  const missing = await captureLogs(() => run({ flags: {}, positionals: ['procedure'], deps: { management } }));
  assert.equal(missing.code, 2);
  const badShell = await captureLogs(() => run({
    flags: { guidance: FIXTURE_GUIDANCE_ID, shell: 'fish' }, positionals: ['procedure'], deps: { management },
  }));
  assert.equal(badShell.code, 2);
  const result = await captureLogs(() => run({
    flags: { json: true, guidance: FIXTURE_GUIDANCE_ID, shell: 'zsh' }, positionals: ['procedure'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{ method: 'procedure', args: [{ guidanceId: FIXTURE_GUIDANCE_ID, shell: 'zsh' }] }]);
});

// ── discovery ────────────────────────────────────────────────────────────────

test('discovery dispatches management.discovery and may render configured roots', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({ flags: {}, positionals: ['discovery'], deps: { management } }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{ method: 'discovery', args: [] }]);
  assert.match(result.text, /\/Users\/fixture-owner\/projects/);
});

test('a not-scanned source renders its SOURCE_COVERAGE_LABELS label, never the raw token, with a start hint', async () => {
  const management = buildManagement();
  const discovery = await captureLogs(() => run({ flags: {}, positionals: ['discovery'], deps: { management } }));
  assert.match(discovery.text, /Ollama: Not scanned yet/);
  assert.match(discovery.text, /Run: ak maintain scans start --source src_neverRun0000000000000000/);
  assert.doesNotMatch(discovery.text, /Ollama: not-scanned/);

  const progress = await captureLogs(() => run({
    flags: {}, positionals: ['scans'],
    deps: { management: buildManagement({ scanProgress: () => ({ ...scanProgressResult, coverage: discoveryResult.coverage }) }) },
  }));
  assert.match(progress.text, /Ollama: Not scanned yet/);
  assert.match(progress.text, /Run: ak maintain scans start --source src_neverRun0000000000000000/);
  assert.doesNotMatch(progress.text, /Ollama: not-scanned/);
});

// ── sources ──────────────────────────────────────────────────────────────────

test('sources add without --yes previews and does not save', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { kind: 'collection-root', root: '/Users/fixture-owner/projects' },
    positionals: ['sources', 'add'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{
    method: 'previewSource', args: [{ kind: 'collection-root', root: '/Users/fixture-owner/projects' }],
  }]);
  assert.match(result.text, /Nothing was changed/);
});

test('sources add --yes previews then saves', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { kind: 'collection-root', root: '/Users/fixture-owner/projects', yes: true },
    positionals: ['sources', 'add'], deps: { management },
  }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [
    { method: 'previewSource', args: [{ kind: 'collection-root', root: '/Users/fixture-owner/projects' }] },
    { method: 'saveSource', args: [{ previewId: sourcePreview.previewId, confirmed: true }] },
  ]);
});

test('sources add rejects an unrecognized --kind', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { kind: 'automatic', root: '/x' }, positionals: ['sources', 'add'], deps: { management },
  }));
  assert.equal(result.code, 2);
  assert.deepEqual(management.calls, []);
});

test('sources remove without --yes shows the affected preview; enable/disable/exclude/unexclude dispatch exactly', async () => {
  const management = buildManagement();
  const preview = await captureLogs(() => run({
    flags: { source: 'src_fixture0000000000000000' }, positionals: ['sources', 'remove'], deps: { management },
  }));
  assert.equal(preview.code, 0);
  assert.deepEqual(management.calls, [{ method: 'removeSource', args: [{ sourceId: 'src_fixture0000000000000000', confirmed: false }] }]);

  const management2 = buildManagement();
  await run({ flags: { source: 'src_a' }, positionals: ['sources', 'enable'], deps: { management: management2 } });
  await run({ flags: { source: 'src_a' }, positionals: ['sources', 'disable'], deps: { management: management2 } });
  await run({ flags: { path: '/Users/fixture-owner/scratch', recursive: true }, positionals: ['sources', 'exclude'], deps: { management: management2 } });
  await run({ flags: { exclusion: 'exc_a' }, positionals: ['sources', 'unexclude'], deps: { management: management2 } });
  assert.deepEqual(management2.calls, [
    { method: 'setAutomaticSource', args: [{ sourceId: 'src_a', enabled: true }] },
    { method: 'setAutomaticSource', args: [{ sourceId: 'src_a', enabled: false }] },
    { method: 'addExclusion', args: [{ path: '/Users/fixture-owner/scratch', recursive: true }] },
    { method: 'removeExclusion', args: [{ exclusionId: 'exc_a' }] },
  ]);
});

// ── scans ────────────────────────────────────────────────────────────────────

test('scans alone reports progress; pause/resume dispatch exactly; stop previews affected resources', async () => {
  const management = buildManagement();
  const progress = await captureLogs(() => run({ flags: {}, positionals: ['scans'], deps: { management } }));
  assert.equal(progress.code, 0);
  assert.deepEqual(management.calls, [{ method: 'scanProgress', args: [] }]);

  // pauseScan/resumeScan are symmetric on the real facade: both take a plain
  // {sourceId} and both return the full scanProgress() envelope.
  const management2 = buildManagement();
  await run({ flags: { source: 'src_a' }, positionals: ['scans', 'pause'], deps: { management: management2 } });
  await run({ flags: { source: 'src_a' }, positionals: ['scans', 'resume'], deps: { management: management2 } });
  assert.deepEqual(management2.calls, [
    { method: 'pauseScan', args: [{ sourceId: 'src_a' }] },
    { method: 'resumeScan', args: [{ sourceId: 'src_a' }] },
  ]);

  const management3 = buildManagement();
  const stopped = await captureLogs(() => run({
    flags: { source: 'src_a' }, positionals: ['scans', 'stop'], deps: { management: management3 },
  }));
  assert.equal(stopped.code, 0);
  assert.deepEqual(management3.calls, [{ method: 'stopScan', args: [{ sourceId: 'src_a', confirmed: false }] }]);
  assert.match(stopped.text, /Claude user configuration: 128 entries visited/);
});

test('scans start awaits management.awaitScans after startScan to report the final state', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { source: 'src_a,src_b', deep: true }, positionals: ['scans', 'start'], deps: { management },
  }));
  assert.equal(result.code, 0);
  // The CLI's own parsed --source list is what it awaits, not a field read
  // back off startScan's result (startScan returns no requestedSourceIds).
  assert.deepEqual(management.calls, [
    { method: 'startScan', args: [{ sourceIds: ['src_a', 'src_b'], deep: true }] },
    { method: 'awaitScans', args: [{ sourceIds: ['src_a', 'src_b'] }] },
  ]);
});

test('scans start with no --source awaits every in-flight scan', async () => {
  const management = buildManagement();
  await run({ flags: {}, positionals: ['scans', 'start'], deps: { management } });
  assert.deepEqual(management.calls, [
    { method: 'startScan', args: [{}] },
    { method: 'awaitScans', args: [{}] },
  ]);
});

test('scans start on a non-scannable source renders the SOURCE_NOT_SCANNABLE refusal plainly and exits 2', async () => {
  const management = buildManagement({
    startScan: () => {
      throw Object.assign(
        new Error('This source is covered by the provider check and machine measurement, not by a discovery scan.'),
        { code: 'SOURCE_NOT_SCANNABLE', sourceIds: ['src_ollama'] },
      );
    },
  });
  const result = await captureLogs(() => run({
    flags: { source: 'src_ollama' }, positionals: ['scans', 'start'], deps: { management },
  }));
  assert.equal(result.code, 2);
  assert.match(result.text, /This source is covered by the provider check and machine measurement, not by a discovery scan\./);
  assert.doesNotMatch(result.text, /SOURCE_NOT_SCANNABLE/);
  // awaitScans must never run after a refused startScan.
  assert.deepEqual(management.calls, [{ method: 'startScan', args: [{ sourceIds: ['src_ollama'] }] }]);
});

// ── activity / receipt ───────────────────────────────────────────────────────

test('activity dispatches management.activity', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({ flags: { json: true }, positionals: ['activity'], deps: { management } }));
  assert.equal(result.code, 0);
  assert.deepEqual(management.calls, [{ method: 'activity', args: [] }]);
});

test('receipt requires --receipt; --export forwards only includeLocalPaths (MNT-PRV-003)', async () => {
  const management = buildManagement();
  const missing = await captureLogs(() => run({ flags: {}, positionals: ['receipt'], deps: { management } }));
  assert.equal(missing.code, 2);
  await run({ flags: { receipt: FIXTURE_RECEIPT_ID }, positionals: ['receipt'], deps: { management } });
  await run({
    flags: { receipt: FIXTURE_RECEIPT_ID, export: true, 'include-local-paths': true, 'acknowledge-warning': true },
    positionals: ['receipt'], deps: { management },
  });
  // The facade's exportReceipt({ receiptId, includeLocalPaths }) has no
  // acknowledgedWarning parameter (service-activity.mjs) — the CLI's
  // --acknowledge-warning is an extra confirmation gate enforced here, never
  // forwarded to the facade call.
  assert.deepEqual(management.calls, [
    { method: 'receipt', args: [{ receiptId: FIXTURE_RECEIPT_ID }] },
    { method: 'exportReceipt', args: [{ receiptId: FIXTURE_RECEIPT_ID, includeLocalPaths: true }] },
  ]);
});

test('receipt --export --include-local-paths without --acknowledge-warning is a usage error', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { receipt: FIXTURE_RECEIPT_ID, export: true, 'include-local-paths': true },
    positionals: ['receipt'], deps: { management },
  }));
  assert.equal(result.code, 2);
  assert.match(result.text, /--acknowledge-warning/);
  assert.deepEqual(management.calls, []);
});

// ── recipes / preferences ────────────────────────────────────────────────────

test('recipes list|refresh|accept|withdraw dispatch exactly and validate required flags', async () => {
  const management = buildManagement();
  const badAccept = await captureLogs(() => run({ flags: {}, positionals: ['recipes', 'accept'], deps: { management } }));
  assert.equal(badAccept.code, 2);
  const badWithdraw = await captureLogs(() => run({ flags: {}, positionals: ['recipes', 'withdraw'], deps: { management } }));
  assert.equal(badWithdraw.code, 2);
  assert.deepEqual(management.calls, []);
  await run({ flags: {}, positionals: ['recipes'], deps: { management } });
  await run({ flags: { yes: true }, positionals: ['recipes', 'refresh'], deps: { management } });
  await run({ flags: { recipe: 'rcp_a', version: '2', yes: true }, positionals: ['recipes', 'accept'], deps: { management } });
  await run({ flags: { recipe: 'rcp_a', version: '1', yes: true }, positionals: ['recipes', 'withdraw'], deps: { management } });
  // withdraw's --version is optional: the facade defaults it to the active,
  // else most recently staged, version (service-actions.mjs) when omitted.
  await run({ flags: { recipe: 'rcp_b', yes: true }, positionals: ['recipes', 'withdraw'], deps: { management } });
  assert.deepEqual(management.calls, [
    { method: 'recipes', args: [] },
    { method: 'refreshRecipes', args: [{ confirmed: true }] },
    { method: 'acceptRecipe', args: [{ recipeId: 'rcp_a', recipeVersion: '2', confirmed: true }] },
    { method: 'withdrawRecipe', args: [{ recipeId: 'rcp_a', recipeVersion: '1', confirmed: true }] },
    { method: 'withdrawRecipe', args: [{ recipeId: 'rcp_b', confirmed: true }] },
  ]);
});

test('preferences reads without --set and saves parsed key=value pairs with --set', async () => {
  const management = buildManagement();
  await run({ flags: {}, positionals: ['preferences'], deps: { management } });
  await run({ flags: { set: ['lastView=all', 'scope=user'] }, positionals: ['preferences'], deps: { management } });
  assert.deepEqual(management.calls, [
    { method: 'preferences', args: [] },
    { method: 'savePreferences', args: [{ lastView: 'all', scope: 'user' }] },
  ]);
});

// ── Sweeps: no prohibited label, no path leak (MNT-EVD-006/008, MNT-PRV-004/005) ─

const SWEEP_CASES = [
  ['scan', ['scan'], {}, { service: () => buildService() }],
  ['inventory', ['inventory'], {}, { management: () => buildManagement() }],
  ['show', ['show'], { placement: FIXTURE_PLACEMENT_ID }, { management: () => buildManagement() }],
  ['guidance', ['guidance'], {}, { management: () => buildManagement() }],
  ['procedure', ['procedure'], { guidance: FIXTURE_GUIDANCE_ID }, { management: () => buildManagement() }],
  ['discovery', ['discovery'], {}, { management: () => buildManagement() }],
  ['sources add preview', ['sources', 'add'], { kind: 'collection-root', root: '/Users/fixture-owner/projects' }, { management: () => buildManagement() }],
  ['sources remove preview', ['sources', 'remove'], { source: 'src_a' }, { management: () => buildManagement() }],
  ['sources enable', ['sources', 'enable'], { source: 'src_a' }, { management: () => buildManagement() }],
  ['sources exclude', ['sources', 'exclude'], { path: '/Users/fixture-owner/scratch' }, { management: () => buildManagement() }],
  ['sources unexclude', ['sources', 'unexclude'], { exclusion: 'exc_a' }, { management: () => buildManagement() }],
  ['scans progress', ['scans'], {}, { management: () => buildManagement() }],
  ['scans start', ['scans', 'start'], {}, { management: () => buildManagement() }],
  ['scans stop preview', ['scans', 'stop'], { source: 'src_a' }, { management: () => buildManagement() }],
  ['activity', ['activity'], {}, { management: () => buildManagement() }],
  ['receipt', ['receipt'], { receipt: FIXTURE_RECEIPT_ID }, { management: () => buildManagement() }],
  ['audit', ['audit'], { receipts: `${FIXTURE_RECEIPT_ID},mnt-receipt-inconclusive` }, { management: () => buildManagement() }],
  ['reconcile', ['reconcile'], { receipt: FIXTURE_RECEIPT_ID, outcome: 'record-no-change', yes: true }, { management: () => buildManagement() }],
  ['disposition', ['disposition'], { guidance: FIXTURE_GUIDANCE_ID, kind: 'acknowledged', yes: true }, { management: () => buildManagement() }],
  ['plan (findings)', ['plan'], { findings: 'finding-a' }, { service: () => buildService() }],
  ['plan (placement)', ['plan'], { placement: FIXTURE_PLACEMENT_ID, executable: true }, { management: () => buildManagement() }],
  ['apply', ['apply'], { plan: 'maintenance-plan-a', digest: 'digest-a', actions: 'action-a', yes: true }, { service: () => buildService() }],
  ['undo', ['undo'], { receipt: FIXTURE_RECEIPT_ID, yes: true }, { service: () => buildService() }],
  ['recover', ['recover'], { receipt: FIXTURE_RECEIPT_ID }, { management: () => buildManagement() }],
  ['recipes list', ['recipes'], {}, { management: () => buildManagement() }],
  ['recipes refresh', ['recipes', 'refresh'], { yes: true }, { management: () => buildManagement() }],
  ['recipes accept', ['recipes', 'accept'], { recipe: 'rcp_a', version: '1', yes: true }, { management: () => buildManagement() }],
  ['preferences read', ['preferences'], {}, { management: () => buildManagement() }],
  ['preferences set', ['preferences'], { set: ['lastView=all'] }, { management: () => buildManagement() }],
];

for (const [name, positionals, extraFlags, depsFactory] of SWEEP_CASES) {
  test(`human output for "${name}" carries no prohibited label and no revealed path (MNT-EVD-006/008, MNT-PRV-004)`, async () => {
    const deps = {};
    for (const [key, factory] of Object.entries(depsFactory)) deps[key] = factory();
    const result = await captureLogs(() => run({ flags: extraFlags, positionals, deps }));
    const lines = result.text.split('\n').filter(Boolean);
    for (const line of lines) {
      assert.equal(isProhibitedLabel(line), false, `"${name}" printed a prohibited label: ${line}`);
    }
    assert.ok(!result.text.includes(REVEAL_PATH_MARKER), `"${name}" leaked the owner-private reveal path`);
  });
}

test('show --reveal is the exception that prints the exact owner-only path (MNT-PRV-005)', async () => {
  const management = buildManagement();
  const result = await captureLogs(() => run({
    flags: { placement: FIXTURE_PLACEMENT_ID, reveal: true }, positionals: ['show'], deps: { management },
  }));
  assert.ok(result.text.includes(REVEAL_PATH_MARKER));
});
