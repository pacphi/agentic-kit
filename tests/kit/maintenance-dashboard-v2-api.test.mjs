// ADR-0048 dashboard v2 API — unit tests against a recording stub facade.
// Requirement IDs in test names: MNT-ACT-001/002/003, MNT-RCV-001..012,
// MNT-PRV-003..006, MNT-PERF-003/004, MNT-EVD-006/008, MNT-DSC-018.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createMaintenanceDashboardApi, publicActivity, publicAuditResults, publicDiscovery, publicGuidance, publicInspector,
  publicInventoryPage, publicMaintenanceModel, publicProcedure, publicReceiptExport, publicScanProgress,
} from '../../src/lib/dashboard/maintenance-api.mjs';
import { createMaintenanceCapabilityStore } from '../../src/lib/dashboard/maintenance-security.mjs';
import { buildActivity, exportReceipt, receiptDetail } from '../../src/lib/maintenance/management/activity.mjs';
import { inspectorFor } from '../../src/lib/maintenance/management/guidance.mjs';
import {
  AUDIT_RESULT_LABELS, GUIDANCE_LANES, isProhibitedLabel,
} from '../../src/lib/maintenance/management/model.mjs';
import { renderProcedure } from '../../src/lib/maintenance/management/procedures.mjs';
import { runInventoryQuery } from '../../src/lib/maintenance/management/query.mjs';
import { BUILTIN_RECIPES } from '../../src/lib/maintenance/management/recipes.mjs';
import {
  FIXTURE_NOW, INTERRUPTED_RECEIPT, SENTINEL_FIXTURES, baseInventory, id,
} from '../fixtures/maintenance/management-fixtures.mjs';

const V2 = '/api/maintenance/v2';
const LOCAL_PATH = /(?:^|[\s"'([{=:])(?:file:\/\/\/?|~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?!\/))/u;
const PRIVATE_PATH = '/Users/alice/.claude.json';
const RECEIPT = INTERRUPTED_RECEIPT.id;
const SESSION = 'session-token-a';
const NOW = Date.parse(FIXTURE_NOW);

const inventory = baseInventory();
const PLACEMENT = inventory.placements[0].placementId;
const GUIDANCE = inventory.guidanceEntries[0].guidanceId;
const APPLY_GUIDANCE = inventory.guidanceEntries[2].guidanceId;
const APPLY_PLACEMENT = inventory.guidanceEntries[2].placementId;
const ENV = inventory.environments[0].environmentId;
const SOURCE = inventory.sourceCoverage[0].sourceId;

function auditFixture(receiptId, { conclusive = true, enables = 'record-no-change', result = 'no-action-started' } = {}) {
  const core = {
    receiptId, result, conclusive, enables, lastDurablePhase: 'prepared',
    provider: { id: 'owned-npx-cache', version: '1' },
    checks: [{ name: 'receipt-integrity', status: 'passed' }, { name: 'last-durable-phase', status: 'passed' }],
    failedComparisons: [], nextSteps: [],
    disclosure: {
      checks: ['receipt-integrity', 'last-durable-phase'], executableProbePolicy: 'read-only-provider-inspector-only',
      networkPolicy: 'no-network-unless-the-recorded-provider-inspector-requires-it', checkedAt: FIXTURE_NOW,
    },
  };
  return { ...core, integrity: 'valid', receiptFile: `${PRIVATE_PATH}/receipt`, exportable: core };
}

function planFixture({ placementId, guidanceId }, actionCount = 1) {
  return {
    schemaVersion: 1, mode: 'control-plane', planId: 'plan-v2', planDigest: 'digest-v2', sourceFingerprint: 'fp-base',
    safetyClass: 'approval-required', generatedAt: FIXTURE_NOW, expiresAt: new Date(NOW + 60_000).toISOString(),
    findingIds: ['finding-plugin'], guidanceId,
    actions: Array.from({ length: actionCount }, (_, index) => ({
      id: `action-${index}`, providerId: 'claude-plugin', providerVersion: '1', operation: 'disable',
      classification: 'approval-required', rollback: 'reversible', restart: 'not-required', executable: true,
      sourceFingerprint: 'fp-base', placementId,
      resourceIdentity: { kind: 'plugin', name: 'frontend-design', privatePath: PRIVATE_PATH },
      impact: { preserved: ['Plugin data'] },
    })),
  };
}

const withPrivatePreserved = {
  ...INTERRUPTED_RECEIPT, actions: [{ ...INTERRUPTED_RECEIPT.actions[0], preserved: [`Kept ${PRIVATE_PATH}`] }],
};

function stubManagement(overrides = {}) {
  const calls = [];
  const record = (name, result) => (...args) => {
    calls.push({ name, args: args[0] });
    return typeof result === 'function' ? result(args[0]) : result;
  };
  const facade = {
    inventory: record('inventory', (args) => runInventoryQuery(inventory, args)),
    placement: record('placement', ({ placementId }) => inspectorFor(inventory, placementId)),
    revealLocator: record('revealLocator', {
      breadcrumb: ['Claude', 'User configuration', 'MCP servers'], exactPath: PRIVATE_PATH, selector: 'mcpServers.lightpanda',
    }),
    guidance: record('guidance', {
      lanes: Object.fromEntries(GUIDANCE_LANES.map((lane) => [lane, inventory.guidanceEntries.filter((entry) => entry.lane === lane)])),
      counts: { apply: 1, steps: 1, decision: 1, update: 0, recovery: 0, total: 3 }, entries: inventory.guidanceEntries,
    }),
    procedure: record('procedure', renderProcedure(BUILTIN_RECIPES[0], { shell: 'zsh' })),
    checklist: record('checklist', { done: { review: true }, updatedAt: FIXTURE_NOW }),
    discovery: record('discovery', {
      automaticSources: [{
        id: 'claude-user', label: 'Claude user configuration', enabled: true, defaultEnabled: true,
        inspects: 'Claude Code user-level configuration', environmentKinds: ['macos'], root: '/Users/alice/.claude', present: true,
      }],
      exactProjects: [{ sourceId: SOURCE, kind: 'exact-project', root: '/Users/alice/Development/kit' }],
      collectionRoots: [],
      exclusions: [{ exclusionId: id('exc', { path: '/Users/alice/tmp' }), path: '/Users/alice/tmp', recursive: true }],
      coverage: inventory.sourceCoverage,
      // Mirrors the landed facade: discovery().progress IS the narrative sentence.
      progress: 'Scanned 128 entries. 3 of 3 sources are complete.',
      history: [{
        scanId: id('scn', { n: 1 }), sourceId: SOURCE, environmentId: ENV, state: 'published', startedAt: FIXTURE_NOW,
        completedAt: FIXTURE_NOW, visited: 128, limitingReason: null, ceiling: null,
      }],
    }),
    previewSource: record('previewSource', ({ kind, root }) => ({
      previewId: id('prv', { kind, root }), kind, root, boundary: null,
      projectsFound: [{ projectId: id('prj', { root }), breadcrumb: ['kit'] }],
      exclusions: { automatic: ['node_modules'], exact: [], recursive: [] }, depth: 8, symlinksSkipped: 0, boundaries: [],
      estimate: { entries: 10, bytes: 2048, timeRange: null }, estimateReason: null, permissions: { denied: 0 },
      ceilings: { maxDepth: 8, maxEntries: 20000 }, valid: true, reason: null,
    })),
    saveSource: record('saveSource', { saved: true, sourceId: SOURCE, kind: 'exact-project', root: '/Users/alice/Development/kit' }),
    removeSource: record('removeSource', ({ confirmed }) => (confirmed ? { confirmed: true, removed: true } : {
      confirmed: false,
      preview: {
        sourceId: SOURCE, label: 'Project', visited: 12, completedPartitions: 1,
        affectedPlacements: [{ placementId: PLACEMENT, displayName: 'Lightpanda', kind: 'mcp-registration' }], affectedCount: 1,
      },
    })),
    setAutomaticSource: record('setAutomaticSource', ({ sourceId, enabled }) => ({ sourceId, enabled })),
    addExclusion: record('addExclusion', ({ path, recursive }) => ({
      exclusionId: id('exc', { path }), path, recursive, affectedProjects: [], valid: true, reason: null, saved: true,
    })),
    removeExclusion: record('removeExclusion', ({ exclusionId }) => ({ exclusionId, removed: true })),
    startScan: record('startScan', () => new Promise(() => {})),
    pauseScan: record('pauseScan', { state: 'paused' }),
    resumeScan: record('resumeScan', () => new Promise(() => {})),
    stopScan: record('stopScan', ({ confirmed }) => (confirmed ? { confirmed: true, removed: true } : {
      confirmed: false, preview: { sourceId: SOURCE, label: 'Claude user configuration', visited: 128, completedPartitions: 4 },
    })),
    scanProgress: record('scanProgress', [{
      sourceId: SOURCE, environmentId: ENV, state: 'scanning', visited: 40, label: 'Claude user configuration', limitingReason: null, ceiling: null,
    }]),
    activity: record('activity', buildActivity({ receipts: [INTERRUPTED_RECEIPT] })),
    receipt: record('receipt', receiptDetail(withPrivatePreserved)),
    exportReceipt: record('exportReceipt', (args) => exportReceipt(withPrivatePreserved, args)),
    recordDisposition: record('recordDisposition', ({ guidanceId, kind, until }) => ({
      dispositionId: id('dsp', { guidanceId }), guidanceId, dispositionIdentity: `${PLACEMENT}:missing-verified-dependency:lightpanda`,
      kind, until: until ?? null, recordedAt: FIXTURE_NOW, invalidatedAt: null, invalidationReason: null,
    })),
    dispositions: record('dispositions', []),
    auditInterruption: record('auditInterruption', ({ receiptIds }) => receiptIds.map((receiptId) => auditFixture(receiptId))),
    reconcile: record('reconcile', ({ receiptId }) => ({
      ok: true, status: 'recovered-no-change', receipt: { id: receiptId, status: 'recovered-no-change', receiptFile: PRIVATE_PATH },
    })),
    planAction: record('planAction', (args) => planFixture(args)),
    apply: record('apply', ({ plan }) => ({
      ok: true, status: 'committed', receipt: { id: 'mnt-applied', status: 'committed', actions: plan.actions, receiptFile: PRIVATE_PATH },
    })),
    prepareUndo: record('prepareUndo', ({ receiptId }) => ({ receiptId, undoable: true, actionCount: 1, summary: 'Restore the recorded preimage.' })),
    undo: record('undo', ({ receiptId }) => ({ ok: true, status: 'rolled-back', receipt: { id: receiptId, status: 'rolled-back' } })),
    refreshRecipes: record('refreshRecipes', {
      diff: [{
        recipeId: 'r1', from: null,
        to: { recipeVersion: '2', privilegeRequirement: 'none', networkRequirement: 'required', operation: 'reinstall-dependency' },
        addsPrivilege: false, addsNetwork: true, addsOperation: true,
      }],
      pending: [{ ...BUILTIN_RECIPES[0], state: 'pending-acceptance' }],
    }),
    acceptRecipe: record('acceptRecipe', { ...BUILTIN_RECIPES[0], state: 'active' }),
    withdrawRecipe: record('withdrawRecipe', { ...BUILTIN_RECIPES[0], state: 'withdrawn' }),
    preferences: record('preferences', {
      lastView: { scope: 'across', view: 'all', sort: 'guidance-first', facets: {}, search: '' },
      preferredShellByEnvironment: { [ENV]: 'zsh' }, retention: { maxSummaries: null, maxAgeDays: null },
    }),
    savePreferences: record('savePreferences', (body) => ({
      lastView: { scope: 'user', view: 'all', sort: 'name', facets: {}, search: '' }, preferredShellByEnvironment: {},
      retention: { maxSummaries: null, maxAgeDays: null }, ...body,
    })),
    ...overrides,
  };
  return { facade, calls };
}

const v1Service = () => ({
  async report() { return {}; }, async scan() { return {}; }, async plan() { throw new Error('v1 not used'); },
});

function fakeRes() {
  const out = { status: null, headers: null, body: null };
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers; return this; },
    end(payload) { out.body = payload ? JSON.parse(payload) : null; },
  };
}

function jsonReq(body, headers = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return Object.assign(Readable.from([Buffer.from(raw)]), { headers: { 'content-type': 'application/json', ...headers } });
}

function harness({ management, now = () => NOW, scanAckMs = 20, capabilities, sessionToken = SESSION } = {}) {
  const stub = management === undefined ? stubManagement() : { facade: management, calls: [] };
  const api = createMaintenanceDashboardApi({
    service: v1Service(), management: stub.facade, sessionToken, now, capabilities, scanAckMs,
  });
  return {
    api, calls: stub.calls, facade: stub.facade,
    async get(route) { const res = fakeRes(); await api.readV2({ url: route }, res, route); return res.out; },
    async post(route, body, headers) { const res = fakeRes(); await api.mutate(`${V2}${route}`, jsonReq(body, headers), res); return res.out; },
  };
}

function eachString(value, visit, keyPath = []) {
  if (typeof value === 'string') visit(value, keyPath);
  else if (Array.isArray(value)) value.forEach((entry, index) => eachString(entry, visit, [...keyPath, index]));
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) eachString(entry, visit, [...keyPath, key]);
}

const LABEL_KEY = /label$|^(?:displayName|outcome|title|actionLabel|summary|detail)$/iu;

function assertPublicPayload(payload, { allowOwnerPaths = false } = {}) {
  eachString(payload, (value, keyPath) => {
    const key = keyPath.findLast((segment) => typeof segment === 'string') ?? '';
    if (!allowOwnerPaths) assert.doesNotMatch(value, LOCAL_PATH, `${keyPath.join('.')} carries a local path`);
    if (LABEL_KEY.test(key)) assert.equal(isProhibitedLabel(value), false, `${keyPath.join('.')} uses a prohibited label: ${value}`);
  });
  assert.doesNotMatch(JSON.stringify(payload), allowOwnerPaths ? /receiptFile|privatePath/ : /receiptFile|privatePath|Users\/alice/);
}

// ── GET routes ─────────────────────────────────────────────────────────────

test('v2 GET routes call exactly the documented facade method with the documented argument object (MNT-ACT-003)', async () => {
  const { get, calls } = harness();
  const cases = [
    ['/inventory?scope=user&view=all&facet.kind=skill&facet.kind=plugin&sort=name&limit=5&search=cla&cursor=abc',
      'inventory', { scope: 'user', view: 'all', facets: { kind: ['skill', 'plugin'] }, sort: 'name', limit: 5, search: 'cla', cursor: 'abc' }],
    ['/inventory', 'inventory', { facets: {} }],
    [`/placements/${PLACEMENT}`, 'placement', { placementId: PLACEMENT }],
    ['/guidance?lane=steps', 'guidance', { lane: 'steps' }],
    ['/guidance', 'guidance', {}],
    [`/procedures/${GUIDANCE}?shell=bash`, 'procedure', { guidanceId: GUIDANCE, shell: 'bash' }],
    [`/procedures/${GUIDANCE}`, 'procedure', { guidanceId: GUIDANCE }],
    ['/discovery', 'discovery', undefined],
    ['/scans', 'scanProgress', undefined],
    ['/activity', 'activity', undefined],
    [`/receipts/${RECEIPT}`, 'receipt', { receiptId: RECEIPT }],
    ['/preferences', 'preferences', undefined],
  ];
  for (const [route, method, args] of cases) {
    calls.length = 0;
    const response = await get(`${V2}${route}`);
    if (route.startsWith('/inventory?')) {
      // The cursor is bound to a different inventory generation: 409, but the call itself is exact.
      assert.equal(response.status, 409, route);
      assert.equal(response.body.code, 'INVENTORY_GENERATION_MISMATCH');
    } else assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(calls, [{ name: method, args }], route);
  }
});

test('v2 GET unknown paths and malformed path parameters are 404, never dispatched (MNT-ACT-003)', async () => {
  const { get, calls } = harness();
  for (const route of ['/nope', '/placements/not-opaque', '/placements/plc_short', `/placements/${PLACEMENT}/extra`,
    '/receipts/receipt-1', '/receipts/mnt-', '/procedures/plc_abcdefghijklmnopqrstuvwxyz1', '/placements/reveal', '/plans']) {
    const response = await get(`${V2}${route}`);
    assert.equal(response.status, 404, route);
  }
  assert.deepEqual(calls, []);
});

test('v2 query grammar rejects unknown, duplicate, unbounded, and path-shaped parameters before touching the facade (MNT-PRV-004)', async () => {
  const { get, calls } = harness();
  const long = (n) => 'a'.repeat(n);
  const bad = [
    '/inventory?scope=galaxy', '/inventory?view=nope', '/inventory?sort=nope', '/inventory?facet.nope=skill',
    `/inventory?facet.kind=${long(65)}`, '/inventory?facet.kind=a%2Fb', '/inventory?facet.kind=skill&facet.kind=skill',
    `/inventory?search=${long(201)}`, '/inventory?search=%01a', '/inventory?search=%2FUsers%2Falice', '/inventory?search=~%2Fx',
    `/inventory?cursor=${long(513)}`, '/inventory?cursor=a%2Fb', '/inventory?limit=0', '/inventory?limit=201', '/inventory?limit=abc',
    '/inventory?scope=user&scope=user', '/inventory?extra=1', '/inventory?facets=1', '/inventory?facet.=skill',
    '/guidance?lane=nope', '/guidance?scope=user', `/procedures/${GUIDANCE}?shell=fish`, '/activity?x=1', '/discovery?deep=1',
    '/scans?sourceId=x', `/receipts/${RECEIPT}?x=1`, '/preferences?x=1',
  ];
  for (const route of bad) {
    const response = await get(`${V2}${route}`);
    assert.equal(response.status, 400, route);
    assert.equal(response.body.error, 'invalid maintenance request');
  }
  assert.deepEqual(calls, []);
  assert.equal((await get(`${V2}/inventory?limit=200&facet.consumer=claude&facet.scope=user`)).status, 200);
});

// ── POST routes ────────────────────────────────────────────────────────────

test('v2 POST routes call exactly the documented facade method with the documented argument object (MNT-ACT-003)', async () => {
  const { post, calls } = harness();
  const until = new Date(NOW + 86_400_000).toISOString();
  const preview = id('prv', { a: 1 });
  const exclusion = id('exc', { a: 1 });
  const preferences = {
    lastView: { scope: 'user', sort: 'name', facets: { kind: ['skill'] }, search: 'cla' },
    preferredShellByEnvironment: { [ENV]: 'zsh' }, retention: { maxSummaries: 8, maxAgeDays: null },
  };
  const cases = [
    ['/placements/reveal', { placementId: PLACEMENT }, 'revealLocator', { placementId: PLACEMENT }],
    ['/procedures/checklist', { guidanceId: GUIDANCE, stepId: 'review', done: true }, 'checklist', { guidanceId: GUIDANCE, stepId: 'review', done: true }],
    ['/discovery/preview', { kind: 'exact-project', root: '/Users/alice/Development/kit' }, 'previewSource', { kind: 'exact-project', root: '/Users/alice/Development/kit' }],
    ['/discovery/sources', { previewId: preview, confirm: true }, 'saveSource', { previewId: preview, confirmed: true }],
    ['/discovery/sources/remove', { sourceId: SOURCE, confirm: false }, 'removeSource', { sourceId: SOURCE, confirmed: false }],
    ['/discovery/sources/remove', { sourceId: 'claude-user', confirm: true }, 'removeSource', { sourceId: 'claude-user', confirmed: true }],
    ['/discovery/automatic', { sourceId: 'claude-user', enabled: false }, 'setAutomaticSource', { sourceId: 'claude-user', enabled: false }],
    ['/discovery/exclusions', { path: '/Users/alice/tmp', recursive: true }, 'addExclusion', { path: '/Users/alice/tmp', recursive: true }],
    ['/discovery/exclusions/remove', { exclusionId: exclusion }, 'removeExclusion', { exclusionId: exclusion }],
    ['/scans', { action: 'pause', sourceId: SOURCE }, 'pauseScan', { sourceId: SOURCE }],
    ['/scans', { action: 'stop', sourceId: SOURCE }, 'stopScan', { sourceId: SOURCE, confirmed: false }],
    ['/scans', { action: 'stop', sourceId: SOURCE, confirm: true }, 'stopScan', { sourceId: SOURCE, confirmed: true }],
    ['/receipts/export', { receiptId: RECEIPT, includeLocalPaths: false }, 'exportReceipt', { receiptId: RECEIPT, includeLocalPaths: false, acknowledgedWarning: false }],
    ['/receipts/export', { receiptId: RECEIPT, includeLocalPaths: true, acknowledgedWarning: true }, 'exportReceipt', { receiptId: RECEIPT, includeLocalPaths: true, acknowledgedWarning: true }],
    ['/dispositions', { guidanceId: GUIDANCE, kind: 'snoozed', until, confirm: true }, 'recordDisposition', { guidanceId: GUIDANCE, kind: 'snoozed', until, confirmed: true }],
    ['/dispositions', { guidanceId: GUIDANCE, kind: 'acknowledged', confirm: true }, 'recordDisposition', { guidanceId: GUIDANCE, kind: 'acknowledged', confirmed: true }],
    ['/audit', { receiptIds: [RECEIPT, 'mnt-two'] }, 'auditInterruption', { receiptIds: [RECEIPT, 'mnt-two'] }],
    ['/reconcile/preview', { receiptId: RECEIPT, outcome: 'record-no-change' }, 'auditInterruption', { receiptIds: [RECEIPT] }],
    ['/plans', { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE }, 'planAction', { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE }],
    ['/undo', { receiptId: 'mnt-applied', preview: true }, 'prepareUndo', { receiptId: 'mnt-applied' }],
    ['/recipes/refresh', { confirm: true }, 'refreshRecipes', { confirmed: true }],
    ['/recipes/accept', { recipeId: 'reinstall-lightpanda-homebrew', recipeVersion: '1', confirm: true }, 'acceptRecipe', { recipeId: 'reinstall-lightpanda-homebrew', recipeVersion: '1', confirmed: true }],
    ['/recipes/withdraw', { recipeId: 'reinstall-lightpanda-homebrew', confirm: true }, 'withdrawRecipe', { recipeId: 'reinstall-lightpanda-homebrew', confirmed: true }],
    ['/recipes/withdraw', { recipeId: 'reinstall-lightpanda-homebrew', recipeVersion: '1', confirm: true }, 'withdrawRecipe', { recipeId: 'reinstall-lightpanda-homebrew', recipeVersion: '1', confirmed: true }],
    ['/preferences', preferences, 'savePreferences', preferences],
  ];
  for (const [route, body, method, args] of cases) {
    calls.length = 0;
    const response = await post(route, body);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
    assert.deepEqual(calls[0], { name: method, args }, route);
  }
});

test('v2 scan control never awaits a running scan and reads progress state only (MNT-PERF-004, MNT-DSC-018)', async () => {
  const { post, calls } = harness();
  const started = await post('/scans', { action: 'start' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual(calls.map((call) => call.name), ['startScan', 'scanProgress']);
  assert.deepEqual(calls[0].args, {});
  assert.deepEqual(started.body, {
    action: 'start', accepted: true, completed: false,
    progress: [{
      sourceId: SOURCE, environmentId: ENV, state: 'scanning', visited: 40, label: 'Claude user configuration', limitingReason: null, ceiling: null,
    }],
  });
  calls.length = 0;
  const scoped = await post('/scans', { action: 'start', sourceId: SOURCE });
  assert.equal(scoped.status, 202);
  assert.deepEqual(calls[0], { name: 'startScan', args: { sourceIds: [SOURCE] } });
  calls.length = 0;
  const resumed = await post('/scans', { action: 'resume', sourceId: SOURCE });
  assert.equal(resumed.status, 202);
  assert.deepEqual(calls[0], { name: 'resumeScan', args: { sourceIds: [SOURCE] } });
  const stopped = await post('/scans', { action: 'stop', sourceId: SOURCE });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.confirmed, false);
  assert.equal(stopped.body.preview.visited, 128);
});

test('v2 scan start surfaces an immediate refusal as 409 and a finished start as 200', async () => {
  const conflict = Object.assign(new Error('Maintenance provider scan is in progress.'), { code: 'MAINTENANCE_SCAN_IN_PROGRESS' });
  const busy = harness({ management: stubManagement({ startScan: async () => { throw conflict; } }).facade });
  const refused = await busy.post('/scans', { action: 'start' });
  assert.deepEqual([refused.status, refused.body], [409, {
    error: 'maintenance provider check is in progress', code: 'MAINTENANCE_SCAN_IN_PROGRESS', effect: 'not-started',
  }]);
  const quick = harness({ management: stubManagement({ startScan: async () => ({ done: true }) }).facade });
  const finished = await quick.post('/scans', { action: 'start' });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.completed, true);
});

test('v2 body grammar rejects surplus keys, wrong types, path inputs, and unbounded lists before touching the facade (MNT-ACT-003)', async () => {
  const { post, calls } = harness();
  const until = new Date(NOW + 86_400_000).toISOString();
  const preview = id('prv', { a: 1 });
  const bad = [
    ['/placements/reveal', { placementId: PLACEMENT, path: '/x' }], ['/placements/reveal', { placementId: 'plc_short' }],
    ['/placements/reveal', {}], ['/placements/reveal', { placementId: GUIDANCE }],
    ['/procedures/checklist', { guidanceId: GUIDANCE, stepId: 'review' }], ['/procedures/checklist', { guidanceId: GUIDANCE, stepId: 'a b', done: true }],
    ['/procedures/checklist', { guidanceId: GUIDANCE, stepId: 'review', done: 'yes' }],
    ['/discovery/preview', { kind: 'automatic', root: '/Users/alice' }], ['/discovery/preview', { kind: 'exact-project', root: 'relative/path' }],
    ['/discovery/preview', { kind: 'exact-project', root: '/Users/alice/../root' }],
    ['/discovery/preview', { kind: 'exact-project', root: `/${'a'.repeat(1024)}` }],
    ['/discovery/preview', { kind: 'exact-project', root: '/Users/alice/\tx' }], ['/discovery/preview', { kind: 'exact-project', root: '~/kit' }],
    ['/discovery/preview', { kind: 'exact-project', root: '/Users/alice', maxDepth: 3 }],
    ['/discovery/sources', { previewId: preview, confirm: false }], ['/discovery/sources', { previewId: 'prv_short', confirm: true }],
    ['/discovery/sources/remove', { sourceId: SOURCE }], ['/discovery/sources/remove', { sourceId: '/Users/alice', confirm: true }],
    ['/discovery/automatic', { sourceId: SOURCE, enabled: true }], ['/discovery/automatic', { sourceId: 'claude-user', enabled: 'true' }],
    ['/discovery/exclusions', { path: 'tmp', recursive: true }], ['/discovery/exclusions', { path: '/Users/alice/tmp' }],
    ['/discovery/exclusions/remove', { exclusionId: SOURCE }],
    ['/scans', { action: 'restart' }], ['/scans', { action: 'pause' }], ['/scans', { action: 'start', confirm: true }],
    ['/scans', { action: 'stop', sourceId: SOURCE, confirm: 'yes' }],
    ['/receipts/export', { receiptId: RECEIPT }], ['/receipts/export', { receiptId: RECEIPT, includeLocalPaths: true }],
    ['/receipts/export', { receiptId: RECEIPT, includeLocalPaths: true, acknowledgedWarning: false }],
    ['/receipts/export', { receiptId: 'receipt-1', includeLocalPaths: false }],
    ['/dispositions', { guidanceId: GUIDANCE, kind: 'snoozed', confirm: true }],
    ['/dispositions', { guidanceId: GUIDANCE, kind: 'acknowledged', until, confirm: true }],
    ['/dispositions', { guidanceId: GUIDANCE, kind: 'snoozed', until: new Date(NOW - 1000).toISOString(), confirm: true }],
    ['/dispositions', { guidanceId: GUIDANCE, kind: 'snoozed', until: new Date(NOW + 366 * 86_400_000).toISOString(), confirm: true }],
    ['/dispositions', { guidanceId: GUIDANCE, kind: 'snoozed', until: 'tomorrow', confirm: true }],
    ['/dispositions', { guidanceId: GUIDANCE, kind: 'snoozed', until, confirm: false }],
    ['/dispositions', { guidanceId: GUIDANCE, kind: 'hidden', confirm: true }],
    ['/audit', { receiptIds: [] }], ['/audit', { receiptIds: Array.from({ length: 21 }, (_, index) => `mnt-${index}`) }],
    ['/audit', { receiptIds: [RECEIPT, RECEIPT] }], ['/audit', { receiptIds: ['../receipt'] }], ['/audit', { receiptIds: [RECEIPT], deep: true }],
    ['/reconcile/preview', { receiptId: RECEIPT, outcome: 'record-anything' }], ['/reconcile/preview', { receiptId: RECEIPT }],
    ['/reconcile', { capability: 'x'.repeat(43), confirm: true }], ['/reconcile', { capability: 'short', confirm: true, typedPhrase: 'RECORD' }],
    ['/plans', { placementId: APPLY_PLACEMENT }], ['/plans', { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE, findingIds: ['a'] }],
    ['/plans', { findingIds: ['finding-a'] }],
    ['/apply', { capability: 'x'.repeat(43), confirm: false }], ['/apply', { capability: 'x'.repeat(43), confirm: true, actionIds: ['a'] }],
    ['/undo', { receiptId: '../x', preview: true }],
    ['/recipes/refresh', {}], ['/recipes/refresh', { confirm: true, url: 'https://example.test' }],
    ['/recipes/accept', { recipeId: 'r1', confirm: true }], ['/recipes/accept', { recipeId: 'r 1', recipeVersion: '1', confirm: true }],
    ['/recipes/withdraw', { recipeId: 'r1', recipeVersion: 'v 1', confirm: true }],
    ['/preferences', {}], ['/preferences', { theme: 'dark' }], ['/preferences', { lastView: { scope: 'galaxy' } }],
    ['/preferences', { lastView: { facets: { nope: ['x'] } } }], ['/preferences', { lastView: { search: '/Users/alice' } }],
    ['/preferences', { preferredShellByEnvironment: { 'not-env': 'zsh' } }], ['/preferences', { preferredShellByEnvironment: { [ENV]: 'fish' } }],
    ['/preferences', { retention: { maxSummaries: 0 } }], ['/preferences', { retention: { maxAgeDays: 1.5 } }],
  ];
  for (const [route, body] of bad) {
    const response = await post(route, body);
    assert.equal(response.status, 400, `${route} ${JSON.stringify(body)} -> ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, 'invalid maintenance request');
  }
  assert.deepEqual(calls, []);
  assert.equal((await post('/plans', '{"placementId":', {})).status, 400);
  const plan = { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE };
  assert.equal((await post('/plans', plan, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('/plans', { ...plan, pad: 'x'.repeat(65_536) })).status, 413);
  assert.deepEqual(calls, []);
});

test('v2 answers 503 for every route when the management facade is absent or cannot be built', async () => {
  for (const management of [null, async () => { throw new Error('no facade'); }]) {
    const { get, post } = harness({ management });
    const read = await get(`${V2}/inventory`);
    assert.deepEqual([read.status, read.body], [503, { error: 'maintenance management unavailable' }]);
    const written = await post('/placements/reveal', { placementId: PLACEMENT });
    assert.deepEqual([written.status, written.body], [503, { error: 'maintenance management unavailable' }]);
  }
  const lazy = harness({ management: async () => stubManagement().facade });
  assert.equal((await lazy.get(`${V2}/activity`)).status, 200);
});

// ── Capabilities ───────────────────────────────────────────────────────────

test('v2 plans mint a one-use apply capability bound to ONE placement action and refuse multi-action plans (MNT-ACT-001)', async () => {
  const { post, calls, api, facade } = harness();
  const planned = await post('/plans', { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.match(planned.body.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(planned.body.plan.actions.length, 1);
  assert.equal(planned.body.plan.actions[0].placementId, APPLY_PLACEMENT);
  assert.equal(planned.body.confirmation.typedPhrase, 'APPLY 1');
  assert.equal(planned.body.confirmation.rollback, 'reversible');
  assertPublicPayload(planned.body.plan);
  assertPublicPayload(planned.body.confirmation);
  assert.equal(api.capabilityCount(), 1);

  calls.length = 0;
  const applied = await post('/apply', { capability: planned.body.capability, confirm: true, typedPhrase: 'APPLY 1' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(calls.map((call) => call.name), ['apply', 'prepareUndo']);
  assert.deepEqual(calls[0].args, {
    plan: planFixture({ placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE }), actionIds: ['action-0'],
    expectedPlanDigest: 'digest-v2', confirmed: true,
  });
  assert.equal(applied.body.receipt.undoEligible, true);
  assertPublicPayload(applied.body);
  const replay = await post('/apply', { capability: planned.body.capability, confirm: true, typedPhrase: 'APPLY 1' });
  assert.equal(replay.status, 409);
  assert.equal(calls.filter((call) => call.name === 'apply').length, 1);

  facade.planAction = async (args) => planFixture(args, 2);
  const multi = await post('/plans', { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE });
  assert.deepEqual([multi.status, multi.body], [409, {
    error: 'A maintenance plan carries exactly one action for one placement.', code: 'ONE_ACTION_PER_PLAN', effect: 'not-started',
  }]);
  assert.equal(api.capabilityCount(), 0, 'a refused multi-action plan mints nothing');
  facade.planAction = async () => { throw Object.assign(new Error('refused'), { code: 'ONE_ACTION_PER_PLAN' }); };
  assert.equal((await post('/plans', { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE })).body.code, 'ONE_ACTION_PER_PLAN');
});

test('v2 capabilities are verb-bound, surface-bound, session-bound, one-use, and expiring', async () => {
  let clock = NOW;
  const capabilities = createMaintenanceCapabilityStore({ now: () => clock, ttlMs: 30_000 });
  const owner = harness({ capabilities, now: () => clock });
  const other = harness({ capabilities, now: () => clock, sessionToken: 'session-token-b', management: owner.facade });
  const planned = (await owner.post('/plans', { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE })).body;

  const wrongVerb = await owner.post('/reconcile', { capability: planned.capability, confirm: true, typedPhrase: 'RECORD' });
  assert.equal(wrongVerb.status, 409);
  const wrongSession = await other.post('/apply', { capability: planned.capability, confirm: true, typedPhrase: 'APPLY 1' });
  assert.equal(wrongSession.status, 409);
  const wrongPhrase = await owner.post('/apply', { capability: planned.capability, confirm: true, typedPhrase: 'APPLY 2' });
  assert.deepEqual([wrongPhrase.status, wrongPhrase.body.effect], [409, 'not-started']);
  const afterRefusal = await owner.post('/apply', { capability: planned.capability, confirm: true, typedPhrase: 'APPLY 1' });
  assert.equal(afterRefusal.status, 409, 'a phrase mismatch consumes the capability');
  assert.equal(owner.calls.filter((call) => call.name === 'apply').length, 0);

  const fresh = (await owner.post('/plans', { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE })).body;
  clock += 31_000;
  const expired = await owner.post('/apply', { capability: fresh.capability, confirm: true, typedPhrase: 'APPLY 1' });
  assert.equal(expired.status, 409);

  const v1Api = createMaintenanceDashboardApi({
    service: {
      async report() { return {}; }, async scan() { return {}; },
      async plan() { return planFixture({ placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE }); },
    },
    management: owner.facade, sessionToken: SESSION, now: () => clock, capabilities,
  });
  const v1Res = fakeRes();
  await v1Api.mutate('/api/maintenance/plans', jsonReq({ findingIds: ['finding-plugin'] }), v1Res);
  assert.equal(v1Res.out.status, 200);
  const crossSurface = await owner.post('/apply', { capability: v1Res.out.body.capability, confirm: true, typedPhrase: 'APPLY 1' });
  assert.equal(crossSurface.status, 409, 'a v1 plan capability cannot drive the v2 apply route');
});

test('v2 reconcile preview mints a reconcile capability only for the outcome the audit enables (MNT-RCV-005/006)', async () => {
  const { post, calls, facade, api } = harness();
  const preview = await post('/reconcile/preview', { receiptId: RECEIPT, outcome: 'record-no-change' });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.match(preview.body.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(preview.body.confirmation.typedPhrase, 'RECORD');
  assert.equal(preview.body.confirmation.auditResultLabel, AUDIT_RESULT_LABELS['no-action-started']);
  assert.equal(preview.body.confirmation.outcomeLabel, 'Record no change');
  assert.equal(preview.body.audit.resultLabel, AUDIT_RESULT_LABELS['no-action-started']);
  assertPublicPayload(preview.body);

  const notEnabled = await post('/reconcile/preview', { receiptId: RECEIPT, outcome: 'record-completed' });
  assert.deepEqual([notEnabled.status, notEnabled.body.code, notEnabled.body.effect], [409, 'RECONCILE_OUTCOME_NOT_ENABLED', 'not-started']);
  assert.equal(api.capabilityCount(), 1);

  calls.length = 0;
  const wrongPhrase = await post('/reconcile', { capability: preview.body.capability, confirm: true, typedPhrase: 'RECORD NOW' });
  assert.equal(wrongPhrase.status, 409);
  assert.deepEqual(calls, [], 'a phrase mismatch never reaches the facade');
  const again = (await post('/reconcile/preview', { receiptId: RECEIPT, outcome: 'record-no-change' })).body;
  calls.length = 0;
  const reconciled = await post('/reconcile', { capability: again.capability, confirm: true, typedPhrase: 'RECORD' });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.deepEqual(calls, [{ name: 'reconcile', args: { receiptId: RECEIPT, outcome: 'record-no-change', confirmed: true } }]);
  assert.equal(reconciled.body.effect, 'verified');
  assertPublicPayload(reconciled.body);

  facade.auditInterruption = async ({ receiptIds }) => receiptIds.map((receiptId) => auditFixture(receiptId, {
    conclusive: false, enables: null, result: 'differs-from-both-recorded-states',
  }));
  const inconclusive = await post('/reconcile/preview', { receiptId: RECEIPT, outcome: 'record-no-change' });
  assert.equal(inconclusive.status, 409);
  assert.equal(inconclusive.body.audit.conclusive, false);
});

test('v2 audit is read-only, batches at most 20 receipts, and returns sanitized exportable results (MNT-RCV-001..005, MNT-ACT-002)', async () => {
  const { post, calls, api } = harness();
  const ids = Array.from({ length: 20 }, (_, index) => `mnt-2026-${index}`);
  const audited = await post('/audit', { receiptIds: ids });
  assert.equal(audited.status, 200);
  assert.equal(audited.body.results.length, 20);
  assert.deepEqual(calls, [{ name: 'auditInterruption', args: { receiptIds: ids } }]);
  assert.equal(api.capabilityCount(), 0, 'audits mint no capability');
  const [first] = audited.body.results;
  assert.equal(first.integrity, 'valid');
  assert.equal(first.resultLabel, AUDIT_RESULT_LABELS['no-action-started']);
  assert.equal(first.enablesLabel, 'Record no change');
  assert.deepEqual(Object.keys(first.exportable).sort(), [
    'checks', 'conclusive', 'disclosure', 'enables', 'failedComparisons', 'lastDurablePhase', 'nextSteps', 'provider', 'receiptId', 'result',
  ]);
  assertPublicPayload(audited.body);
});

// ── Projections ────────────────────────────────────────────────────────────

test('v2 projections over every sentinel fixture carry no local path and no prohibited label (MNT-EVD-006, MNT-PRV-004)', () => {
  for (const [name, build] of Object.entries(SENTINEL_FIXTURES)) {
    const fixture = build();
    const page = publicInventoryPage(runInventoryQuery(fixture, { limit: 200 }));
    assert.equal(page.total, fixture.placements.length, name);
    assert.equal(page.groups.flatMap((group) => group.placements).length, fixture.placements.length, name);
    assertPublicPayload(page);
    for (const placement of fixture.placements) assertPublicPayload(publicInspector(inspectorFor(fixture, placement.placementId)));
    assertPublicPayload(publicGuidance({
      lanes: Object.fromEntries(GUIDANCE_LANES.map((lane) => [lane, fixture.guidanceEntries.filter((entry) => entry.lane === lane)])),
      counts: { total: fixture.guidanceEntries.length }, entries: fixture.guidanceEntries,
    }));
  }
  assertPublicPayload(publicActivity(buildActivity({ receipts: [INTERRUPTED_RECEIPT] })));
  assertPublicPayload(publicProcedure(renderProcedure(BUILTIN_RECIPES[0], { shell: 'bash' })));
  assertPublicPayload(publicAuditResults([auditFixture(RECEIPT)]));
});

test('v2 inventory projection keeps the nine inspector sections and the page envelope keys intact (MNT-PERF-003)', () => {
  const page = publicInventoryPage(runInventoryQuery(inventory, { facets: { kind: ['skill'] }, limit: 1 }));
  assert.deepEqual(Object.keys(page).sort(), [
    'appliedFacets', 'facetCounts', 'facetLabels', 'groups', 'inventoryId', 'nextCursor', 'partialSources', 'projectKinds', 'schema', 'sortGroups', 'total',
  ]);
  assert.deepEqual(page.appliedFacets, { kind: ['skill'] });
  assert.equal(page.total, 2);
  assert.equal(page.groups.length, 1);
  assert.deepEqual(Object.keys(page.groups[0].placements[0]).sort(), [
    'breadcrumb', 'carrier', 'consumerHosts', 'displayName', 'guidanceLane', 'kind', 'placementId', 'projectId', 'projectKind', 'rowAction', 'scope', 'versions',
  ]);
  const inspector = publicInspector(inspectorFor(inventory, PLACEMENT));
  assert.deepEqual(Object.keys(inspector).sort(), [
    'relationships', 'whatCanIAccomplish', 'whatChangedOrConflicts', 'whatHappenedBefore', 'whatIsThis', 'whatProvesThis', 'whatVersionIsHere', 'whereIsIt', 'whoUsesIt',
  ]);
  assert.equal(inspector.whatCanIAccomplish.length, 2);
  assert.equal(inspector.whatCanIAccomplish[1].choices.length, 4);
  const remedyFree = publicInspector(inspectorFor(inventory, inventory.placements[4].placementId));
  assert.match(remedyFree.whatCanIAccomplish.detail, /^No action is requested\./);
});

test('v2 projections drop unlisted keys, strip local paths, and bound every list (MNT-PRV-004)', () => {
  const hostile = {
    placementId: PLACEMENT, displayName: `Skill at ${PRIVATE_PATH}`, scope: { value: 'user', label: 'User', icon: 'person' },
    breadcrumb: Array.from({ length: 40 }, (_, index) => `crumb-${index}`), versions: { installed: '1' }, carrier: null,
    consumerHosts: ['claude'], guidanceLane: null, rowAction: { verb: null, label: 'Open details' }, privatePath: PRIVATE_PATH,
  };
  const page = publicInventoryPage({
    inventoryId: inventory.inventoryId, total: 3_000, extra: 'dropped',
    groups: Array.from({ length: 300 }, (_, index) => ({
      resourceId: `res_${index}`, displayName: 'clarity', kind: 'skill', placementCount: 3, consumerCount: 1, placements: [hostile, hostile, hostile],
    })),
    facetCounts: {
      kind: Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`value-${index}`, 1])), nope: { a: 1 }, '/Users/alice': { a: 1 },
    },
    sortGroups: [{ bucket: 'healthy', label: 'Healthy resources', count: 3 }], partialSources: [], appliedFacets: {},
  });
  assert.equal(page.groups.flatMap((group) => group.placements).length, 200, 'page rows are capped at 200');
  assert.equal(Object.keys(page.facetCounts.kind).length, 500, 'facet values are capped at 500');
  assert.equal(page.facetCounts['/Users/alice'], undefined);
  assert.equal(page.groups[0].placements[0].displayName, 'Skill at [local path omitted]');
  assert.equal(page.groups[0].placements[0].breadcrumb.length, 16);
  assert.equal('extra' in page, false);
  assert.doesNotMatch(JSON.stringify(page), /privatePath|Users\/alice/);
  const inspector = publicInspector({
    ...inspectorFor(inventory, PLACEMENT),
    whatProvesThis: {
      evidenceScorecard: { identity: 'verified', bogus: 'verified', placement: 'guessed' },
      technicalDetails: Array.from({ length: 80 }, () => `Seen at ${PRIVATE_PATH}`),
    },
  });
  assert.equal(inspector.whatProvesThis.technicalDetails.length, 50);
  assert.deepEqual(inspector.whatProvesThis.evidenceScorecard, { identity: 'verified' });
  assert.equal(inspector.whatProvesThis.technicalDetails[0], 'Seen at [local path omitted]');
});

test('v2 reveal is the only route that returns an exact path, and export keeps paths only after the warned choice (MNT-PRV-005, MNT-RCV-011/012)', async () => {
  const { get, post } = harness();
  const revealed = await post('/placements/reveal', { placementId: PLACEMENT });
  assert.deepEqual(revealed.body, {
    placementId: PLACEMENT, breadcrumb: ['Claude', 'User configuration', 'MCP servers'], exactPath: PRIVATE_PATH, selector: 'mcpServers.lightpanda',
  });
  const detail = await get(`${V2}/receipts/${RECEIPT}`);
  assert.equal(detail.status, 200);
  assertPublicPayload(detail.body);
  assert.equal(detail.body.preserved[0], 'Kept [local path omitted]');
  const redacted = await post('/receipts/export', { receiptId: RECEIPT, includeLocalPaths: false });
  assert.equal(redacted.body.pathsIncluded, false);
  assertPublicPayload(redacted.body);
  const withPaths = await post('/receipts/export', { receiptId: RECEIPT, includeLocalPaths: true, acknowledgedWarning: true });
  assert.equal(withPaths.body.pathsIncluded, true);
  assert.equal(withPaths.body.preserved[0], `Kept ${PRIVATE_PATH}`);
  assert.equal(publicReceiptExport({ preserved: [`Kept ${PRIVATE_PATH}`], pathsIncluded: 'yes' }).preserved[0], 'Kept [local path omitted]');
  for (const route of ['/discovery', '/guidance', '/activity', `/placements/${PLACEMENT}`, '/scans', '/preferences']) {
    const response = await get(`${V2}${route}`);
    assert.equal(response.status, 200, route);
    assertPublicPayload(response.body, { allowOwnerPaths: route === '/discovery' });
  }
  const discovery = (await get(`${V2}/discovery`)).body;
  assert.equal(discovery.narrative, 'Scanned 128 entries. 3 of 3 sources are complete.', 'a narrative-string progress is exposed as narrative');
  assert.equal('progress' in discovery, false, 'progress is only present when it carries structured rows');
  const structured = publicDiscovery({ coverage: [], progress: { coverage: [], narrative: 'Scanned 1 entry.', forbiddenClaims: [] } });
  assert.deepEqual(structured, { coverage: [], progress: { coverage: [], narrative: 'Scanned 1 entry.', forbiddenClaims: [] }, narrative: 'Scanned 1 entry.' });
  assert.equal(discovery.exactProjects[0].root, '/Users/alice/Development/kit', 'Discovery is the documented owner-only surface for configured roots');
  assert.equal(discovery.exclusions[0].path, '/Users/alice/tmp');
  assertPublicPayload({ ...discovery, exactProjects: [], exclusions: [], automaticSources: [] });
});

test('v2 error mapping keeps machine codes in `code` and never echoes a prohibited label in `error` (MNT-EVD-008)', async () => {
  const failures = [
    ['inventory', Object.assign(new Error('cursor mismatch'), { code: 'inventory-generation-mismatch' }), 409, 'INVENTORY_GENERATION_MISMATCH'],
    ['placement', new TypeError(`unknown placement: ${PLACEMENT}`), 404, undefined],
    ['placement', Object.assign(new Error('gone'), { code: 'NOT_FOUND' }), 404, undefined],
    ['activity', Object.assign(new Error('busy'), { code: 'SYSTEM_SCAN_IN_PROGRESS' }), 409, 'SYSTEM_SCAN_IN_PROGRESS'],
    ['activity', new Error('disk on fire'), 503, undefined],
    ['activity', Object.assign(new Error('teapot'), { statusCode: 418 }), 418, undefined],
  ];
  for (const [method, error, status, code] of failures) {
    const { get } = harness({ management: stubManagement({ [method]: async () => { throw error; } }).facade });
    const route = method === 'placement' ? `/placements/${PLACEMENT}` : `/${method}`;
    const response = await get(`${V2}${route}`);
    assert.equal(response.status, status, `${method}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.code, code);
    assert.equal(typeof response.body.error, 'string');
    assert.equal(isProhibitedLabel(response.body.error), false, response.body.error);
    assert.doesNotMatch(response.body.error, /teapot|disk on fire|cursor mismatch/);
  }
  const unresolved = harness({
    management: stubManagement({
      planAction: async () => { throw Object.assign(new Error('x'), { code: 'PLACEMENT_FINDING_UNRESOLVED' }); },
    }).facade,
  });
  const refused = await unresolved.post('/plans', { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE });
  assert.deepEqual([refused.status, refused.body.code, refused.body.effect], [409, 'PLACEMENT_FINDING_UNRESOLVED', 'not-started']);
});

test('v2 undo delegates preview and confirmation through the facade with one-use capabilities', async () => {
  const { post, calls } = harness();
  const preview = await post('/undo', { receiptId: 'mnt-applied', preview: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.confirmation.typedPhrase, 'UNDO');
  calls.length = 0;
  const undone = await post('/undo', { capability: preview.body.capability, confirm: true, typedPhrase: 'UNDO' });
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.deepEqual(calls, [{ name: 'undo', args: { receiptId: 'mnt-applied', confirmed: true } }]);
  assert.deepEqual([undone.body.status, undone.body.effect], ['rolled-back', 'verified']);
  assert.equal((await post('/undo', { capability: preview.body.capability, confirm: true, typedPhrase: 'UNDO' })).status, 409);
});

test('v2 inventory projection carries row kind and opaque-id facet labels over every sentinel fixture (MNT-PRV-004)', () => {
  for (const [name, build] of Object.entries(SENTINEL_FIXTURES)) {
    const fixture = build();
    const page = publicInventoryPage(runInventoryQuery(fixture, { limit: 200 }));
    const rows = page.groups.flatMap((group) => group.placements);
    assert.equal(rows.length, fixture.placements.length, name);
    for (const row of rows) {
      const placement = fixture.placements.find((entry) => entry.placementId === row.placementId);
      assert.equal(row.kind, placement.kind, `${name}: row kind`);
      if(placement.projectId)assert.equal(row.projectId, placement.projectId, `${name}: project identity reaches browser`);
    }
    assert.deepEqual(Object.keys(page.facetLabels).sort(), ['environment', 'family', 'project'], name);
    for (const [environmentId, label] of Object.entries(page.facetLabels.environment)) {
      assert.match(environmentId, /^env_/, name);
      assert.equal(label, fixture.environments.find((entry) => entry.environmentId === environmentId).displayLabel, name);
    }
    assert.deepEqual(Object.keys(page.facetLabels.project).sort(), Object.keys(page.facetCounts.project ?? {}).sort(), `${name}: project labels track facet counts`);
    for (const projectId of Object.keys(page.facetLabels.project)) assert.match(projectId, /^prj_/, name);
    assertPublicPayload(page);
  }
  const projects = publicInventoryPage(runInventoryQuery(SENTINEL_FIXTURES.projects(), {}));
  assert.equal(Object.values(projects.facetLabels.project).some((label) => /agentic-kit-feature/.test(label)), true);

  const hostile = publicInventoryPage({
    inventoryId: inventory.inventoryId, total: 0, groups: [{ resourceId: 'res_x', displayName: 'x', kind: 'skill', placementCount: 1, consumerCount: 0,
      placements: [{ placementId: PLACEMENT, displayName: 'x', kind: 'not-a-kind', breadcrumb: [] }] }],
    facetCounts: {}, sortGroups: [], partialSources: [], appliedFacets: {},
    facetLabels: {
      environment: { '/Users/alice': 'leak', 'env-not-opaque': 'leak', [ENV]: `Mac at ${PRIVATE_PATH}` },
      project: Object.fromEntries(Array.from({ length: 600 }, (_, index) => [id('prj', { index }), `Project ${index}`])),
      kind: { skill: 'Skill' },
    },
  });
  assert.deepEqual(hostile.facetLabels.environment, { [ENV]: 'Mac at [local path omitted]' });
  assert.equal(Object.keys(hostile.facetLabels.project).length, 500, 'label maps are capped at 500 entries');
  assert.equal('kind' in hostile.facetLabels, false, 'only environment and project label maps are projected');
  assert.equal('kind' in hostile.groups[0].placements[0], false, 'a row kind outside RESOURCE_KINDS is omitted');
  assert.doesNotMatch(JSON.stringify(hostile), /Users\/alice|leak/);
});

test('report({ refresh:true }) fires afterScan once after a successful provider scan and never lets it fail the response', async () => {
  const events = [];
  const service = { async report() { return {}; }, async scan() { events.push('scan'); return {}; }, async plan() { return {}; } };
  const api = createMaintenanceDashboardApi({
    service, sessionToken: SESSION, afterScan: () => { events.push('afterScan'); throw new Error('rebuild failed'); },
  });
  const plain = fakeRes();
  await api.report({}, plain, { refresh: false });
  assert.deepEqual([plain.out.status, events], [200, []]);
  const refreshed = fakeRes();
  await api.report({}, refreshed, { refresh: true });
  assert.deepEqual([refreshed.out.status, events], [200, ['scan', 'afterScan']]);
  const failing = createMaintenanceDashboardApi({
    service: { ...service, async scan() { throw new Error('provider check failed'); } }, sessionToken: SESSION,
    afterScan: () => { events.push('never'); },
  });
  const failed = fakeRes();
  await failing.report({}, failed, { refresh: true });
  assert.equal(failed.out.status, 503);
  assert.equal(events.includes('never'), false, 'afterScan only follows a successful scan');
});

test('lastRefresh is allowlisted on the report, inventory, and guidance envelopes with a guarded, label-safe message (QE D6b)', async () => {
  const ok = { status: 'ok', at: FIXTURE_NOW };
  const failed = { status: 'failed', at: FIXTURE_NOW, code: 'INVENTORY_STORE_UNAVAILABLE', message: `Could not write ${PRIVATE_PATH}` };
  const page = publicInventoryPage({ ...runInventoryQuery(inventory, {}), lastRefresh: failed });
  assert.deepEqual(page.lastRefresh, {
    status: 'failed', at: FIXTURE_NOW, code: 'INVENTORY_STORE_UNAVAILABLE', message: 'Could not write [local path omitted]',
  });
  assert.deepEqual(publicInventoryPage({ ...runInventoryQuery(inventory, {}), lastRefresh: ok }).lastRefresh, ok);
  const running = { status: 'running', at: FIXTURE_NOW };
  assert.deepEqual(publicInventoryPage({ ...runInventoryQuery(inventory, {}), lastRefresh: running }).lastRefresh, running);
  assert.deepEqual(publicGuidance({ lanes: {}, counts: {}, entries: [], lastRefresh: running }).lastRefresh, running);
  assert.deepEqual(publicMaintenanceModel({ findings: [], receipts: [], lastRefresh: running }).lastRefresh, running);
  assert.deepEqual(publicGuidance({ lanes: {}, counts: {}, entries: [], lastRefresh: failed }).lastRefresh.code, 'INVENTORY_STORE_UNAVAILABLE');
  assert.deepEqual(publicMaintenanceModel({ findings: [], receipts: [], lastRefresh: ok }).lastRefresh, ok);
  assert.equal('lastRefresh' in publicMaintenanceModel({ findings: [], receipts: [] }), false);
  const hostile = publicInventoryPage({
    ...runInventoryQuery(inventory, {}),
    lastRefresh: { status: 'unknown', at: 'yesterday', code: 'has space', message: 'Unknown', extra: PRIVATE_PATH },
  });
  assert.deepEqual(hostile.lastRefresh, {}, 'a bad status, non-ISO stamp, non-token code, and prohibited-label message are all omitted');
  const { get } = harness({ management: stubManagement({
    inventory: async (args) => ({ ...runInventoryQuery(inventory, args), lastRefresh: failed }),
    guidance: async () => ({ lanes: {}, counts: {}, entries: [], lastRefresh: failed }),
  }).facade });
  const served = await get(`${V2}/inventory`);
  assert.equal(served.body.lastRefresh.status, 'failed');
  assertPublicPayload(served.body);
  assert.equal((await get(`${V2}/guidance`)).body.lastRefresh.status, 'failed');
});

test('v2 scan start of a non-filesystem automatic source maps SOURCE_NOT_SCANNABLE to 409 with a factual sentence', async () => {
  const refusal = Object.assign(new Error('runtimes is not a filesystem source'), { code: 'SOURCE_NOT_SCANNABLE' });
  let starts = 0;
  const { post, calls } = harness({ management: stubManagement({ startScan: async () => { starts += 1; throw refusal; } }).facade });
  const response = await post('/scans', { action: 'start', sourceId: 'runtimes' });
  assert.equal(response.status, 409);
  assert.deepEqual([response.body.code, response.body.effect], ['SOURCE_NOT_SCANNABLE', 'not-started']);
  assert.equal(isProhibitedLabel(response.body.error), false, response.body.error);
  assert.doesNotMatch(response.body.error, /runtimes is not/);
  assert.deepEqual([starts, calls.map((call) => call.name)], [1, []], 'a refused start never reads progress or retries');
});

test('partialSources projects the structured disclosure over the incomplete fixture and still accepts the legacy list (MNT-DSC-014/016)', () => {
  const fixture = SENTINEL_FIXTURES.incomplete();
  const page = runInventoryQuery(fixture, {});
  const live = publicInventoryPage(page).partialSources;
  assert.deepEqual(live, page.partialSources, 'the structured disclosure round-trips exactly');
  assert.equal(live.total, 1);
  assert.deepEqual([live.stopped.count, live.stopped.labels, live.stopped.reasons], [1, ['Collection root'], ['entries']]);
  assert.equal(live.action, 'discovery');
  assert.equal(typeof live.narrative, 'string');
  assert.equal(live.narrative, page.partialSources.narrative, 'the narrative comes from the query engine, never invented here');
  assert.equal(isProhibitedLabel(live.narrative), false);
  assert.equal(live.entries.length, 1);
  assert.deepEqual([live.entries[0].state, live.entries[0].ceiling, live.entries[0].visited], ['stopped', 'entries', 250000]);
  assert.deepEqual(Object.keys(live.paused).sort(), ['count', 'labels', 'visited']);
  assert.deepEqual(Object.keys(live.failed).sort(), ['count', 'labels', 'reasons']);
  assertPublicPayload(publicInventoryPage(page));
  const settled = publicInventoryPage(runInventoryQuery(SENTINEL_FIXTURES.base(), {})).partialSources;
  assert.deepEqual([settled.total, settled.action, settled.narrative, settled.entries], [0, null, null, []]);

  const stopped = fixture.sourceCoverage[0];
  const legacy = publicInventoryPage({ ...page, partialSources: [stopped] }).partialSources;
  assert.equal(Array.isArray(legacy), true, 'the legacy list shape stays accepted during the switch');
  assert.deepEqual([legacy[0].state, legacy[0].ceiling, legacy[0].visited], ['stopped', 'entries', 250000]);

  const hostile = publicInventoryPage({
    ...page,
    partialSources: {
      ...page.partialSources, action: 'panic', narrative: 'Unknown',
      stopped: { count: 1, labels: Array.from({ length: 80 }, () => `Root at ${PRIVATE_PATH}`), reasons: ['entries', 'because'], extra: 'dropped' },
      entries: Array.from({ length: 80 }, () => ({ ...stopped, label: `Seen ${PRIVATE_PATH}` })),
    },
  }).partialSources;
  assert.equal('action' in hostile, false, 'an action outside remeasure|discovery is omitted');
  assert.equal('narrative' in hostile, false, 'a prohibited-label narrative is omitted');
  assert.equal(hostile.stopped.labels.length, 50);
  assert.equal(hostile.stopped.labels[0], 'Root at [local path omitted]');
  assert.deepEqual(hostile.stopped.reasons, ['entries'], 'reasons are ceiling or limiting-reason tokens only');
  assert.equal('extra' in hostile.stopped, false);
  assert.equal(hostile.entries.length, 50);
  assert.equal(hostile.entries[0].label, 'Seen [local path omitted]');
});

test('discovery and scan polling preserve non-filesystem classification through the public API', () => {
  const coverage = [
    { sourceId: SOURCE, state: 'complete', label: 'Claude', filesystem: true },
    { sourceId: 'runtimes', state: 'not-scanned', label: 'Runtimes', filesystem: false },
  ];
  for (const payload of [publicDiscovery({ coverage }), publicScanProgress({ coverage })]) {
    assert.deepEqual(payload.coverage.map((row) => row.filesystem), [true, false]);
  }
});

test('public activity retains historical scans as well as latest source summaries', () => {
  const scans = [{ sourceId: SOURCE, state: 'complete', completedAt: '2026-09-08T23:00:00Z' }];
  const history = [...scans, { ...scans[0], completedAt: '2026-09-07T23:00:00Z' }];
  const payload = publicActivity({ scans, scanHistory: history });
  assert.equal(payload.scans.length, 1);
  assert.equal(payload.scanHistory.length, 2);
});

test('v2 reports native persistence refusal without suggesting an action started', async () => {
  const refusal = Object.assign(new Error('private adapter unavailable'), { code: 'MAINTENANCE_PERSISTENCE_UNAVAILABLE' });
  const { post } = harness({ management: stubManagement({ planAction: async () => { throw refusal; } }).facade });
  const response = await post('/plans', { placementId: APPLY_PLACEMENT, guidanceId: APPLY_GUIDANCE });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'MAINTENANCE_PERSISTENCE_UNAVAILABLE');
  assert.equal(response.body.effect, 'not-started');
  assert.match(response.body.error, /Inventory and guided procedures remain available/);
});
