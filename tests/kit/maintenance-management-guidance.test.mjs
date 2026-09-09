// ADR-0048 Guidance admission tests (MNT-GUD-*, MNT-ACT-010..012, MNT-EVD-007,
// J1/J6/J9). `admitGuidance` is pure/synchronous; every test supplies its own
// already-computed provider `detections` and never spawns a process.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MANAGEMENT_INVENTORY_SCHEMA, MANAGEMENT_SCHEMA_VERSION, assertManagementInventory, deepFreeze,
  isProhibitedLabel, NO_ACTION_REQUESTED_DETAIL,
} from '../../src/lib/maintenance/management/model.mjs';
import { admitGuidance, inspectorFor, remedyFreeInspector } from '../../src/lib/maintenance/management/guidance.mjs';
import { BUILTIN_RECIPES } from '../../src/lib/maintenance/management/recipes.mjs';
import { SENTINEL_FIXTURES, FIXTURE_KEY, FIXTURE_NOW, id } from '../fixtures/maintenance/management-fixtures.mjs';

function stripped(inventory) {
  return {
    ...inventory, guidanceEntries: [],
    placements: inventory.placements.map((placement) => ({ ...placement, guidanceLane: null })),
  };
}

/** A minimal, self-validating single-placement inventory for exercising one
 *  matcher in isolation (fixtures don't cover cache/orphaned-process/
 *  project-file placements). */
function singlePlacementInventory({
  kind, administrativeScope, displayName, consumerHosts = [], conditions = ['healthy'], versions = {},
} = {}) {
  const environmentId = id('env', { synthetic: 'matcher-tests' });
  const resourceId = id('res', { kind, displayName, synthetic: true });
  const placementId = id('plc', { kind, displayName, administrativeScope, synthetic: true });
  const artifactId = id('art', { synthetic: true, displayName });
  const bindingIds = consumerHosts.map((host) => id('bnd', { host, displayName, synthetic: true }));
  const projectId = administrativeScope === 'project' ? id('prj', { synthetic: displayName }) : undefined;
  return deepFreeze(assertManagementInventory({
    schemaVersion: MANAGEMENT_SCHEMA_VERSION, schema: MANAGEMENT_INVENTORY_SCHEMA,
    inventoryId: id('inv', { synthetic: displayName }), capturedAt: FIXTURE_NOW, sourceFingerprint: 'fp-synthetic',
    environments: [{ environmentId, kind: 'macos', displayLabel: 'Synthetic' }],
    sourceCoverage: [],
    resources: [{ resourceId, kind, displayName, placementIds: [placementId] }],
    artifacts: [{ artifactId, carrier: 'file' }],
    consumerBindings: consumerHosts.map((host, index) => ({
      bindingId: bindingIds[index], placementId, artifactId, consumerKind: 'host', consumerLabel: host,
      mechanism: 'test', enabled: true, effectiveScope: administrativeScope, grade: 'verified', affectedByProposedAction: false,
    })),
    placements: [{
      placementId, resourceId, environmentId, administrativeScope,
      ...(projectId ? { projectId } : {}),
      locationBreadcrumb: ['Synthetic'], artifactIds: [artifactId], consumerBindingIds: bindingIds,
      conditions, evidenceScorecard: { identity: 'verified', placement: 'verified' },
      displayName, kind, consumerHosts, versions, guidanceLane: null, technicalDetails: [], recentlyChangedAt: null,
    }],
    provenanceAssertions: [], versionObservations: [], dependencyEdges: [], conflictSets: [], guidanceEntries: [],
  }));
}

function claudePluginProvider(operations = ['disable', 'update', 'remove']) {
  return { id: 'claude-plugin', version: 'v1', host: 'claude', resourceKinds: ['plugin'], operations };
}

function claudePluginDetections({ enabled = true } = {}) {
  return new Map([['claude-plugin', {
    status: 'available', complete: true,
    plugins: [{ ref: 'frontend-design@claude-plugins', version: '0.3.1', scope: 'user', enabled, candidateStatus: 'exact', availableVersion: '0.4.0' }],
  }]]);
}

function admit(inventory, overrides = {}) {
  const result = admitGuidance({
    inventory: stripped(inventory), providers: new Map(), detections: new Map(),
    receipts: [], recipes: BUILTIN_RECIPES, dispositions: [], mutationBlocks: [],
    now: () => new Date(FIXTURE_NOW), installationKey: FIXTURE_KEY, ...overrides,
  });
  return { ...result, actions: result.inventory.guidanceEntries.filter((entry) => entry.lane === 'apply') };
}

// ── Basic contract ───────────────────────────────────────────────────────────

test('admitGuidance requires an installationKey', () => {
  assert.throws(() => admitGuidance({ inventory: stripped(SENTINEL_FIXTURES.base()) }), TypeError);
});

test('admitGuidance never mutates its input inventory', () => {
  const inventory = stripped(SENTINEL_FIXTURES.base());
  const before = JSON.parse(JSON.stringify(inventory));
  admit(SENTINEL_FIXTURES.base());
  assert.deepEqual(inventory, before);
});

test('the returned inventory passes assertManagementInventory for every sentinel fixture', () => {
  for (const build of Object.values(SENTINEL_FIXTURES)) {
    const { inventory } = admit(build(), {
      providers: new Map([['claude-plugin', claudePluginProvider()], ['ollama-model', { id: 'ollama-model', version: 'v1', resourceKinds: ['model'], operations: ['remove'] }]]),
      detections: new Map([
        ['claude-plugin', claudePluginDetections().get('claude-plugin')],
        ['ollama-model', ollamaContext().detections.get('ollama-model')],
      ]),
    });
    assert.doesNotThrow(() => assertManagementInventory(inventory));
  }
});

// ── J1: missing verified dependency ─────────────────────────────────────────

test('J1: Lightpanda admits a steps entry per compatible recipe and its badge lane is "steps"', () => {
  const { inventory, lanes } = admit(SENTINEL_FIXTURES.base());
  const lightpanda = inventory.placements.find((p) => p.displayName === 'Lightpanda');
  assert.equal(lightpanda.guidanceLane, 'steps');
  const steps = lanes.steps.filter((entry) => entry.placementId === lightpanda.placementId);
  assert.ok(steps.length >= 1);
  assert.ok(steps.every((entry) => typeof entry.procedureId === 'string' && entry.procedureId));
});

test('J1: Lightpanda also admits a decision entry with exactly the four missing-dependency choices', () => {
  const { lanes } = admit(SENTINEL_FIXTURES.base());
  assert.equal(lanes.decision.length, 1);
  const choiceIds = lanes.decision[0].choices.map((choice) => choice.choiceId).sort();
  assert.deepEqual(choiceIds, ['reinstall', 'relink-dependency', 'remove', 'repair-registration']);
});

test('J1: reinstall is grounded (a compatible signed recipe exists); repair/relink/remove are not, each with a reason', () => {
  const { lanes } = admit(SENTINEL_FIXTURES.base());
  const byId = Object.fromEntries(lanes.decision[0].choices.map((choice) => [choice.choiceId, choice]));
  assert.equal(byId.reinstall.grounded, true);
  assert.equal(byId.reinstall.reason, undefined);
  for (const id of ['repair-registration', 'relink-dependency', 'remove']) {
    assert.equal(byId[id].grounded, false);
    assert.equal(typeof byId[id].reason, 'string');
    assert.ok(byId[id].reason.length > 0);
  }
});

test('J1: repair-registration becomes grounded once a verified alternate executable placement exists', () => {
  const base = SENTINEL_FIXTURES.base();
  const lightpanda = base.placements.find((p) => p.displayName === 'Lightpanda');
  const withExecutable = {
    ...base,
    placements: [...base.placements, {
      placementId: 'plc_alt_lightpanda_exe_0000000000',
      resourceId: base.resources[1].resourceId, environmentId: lightpanda.environmentId, administrativeScope: 'user',
      locationBreadcrumb: ['Homebrew', 'bin'], artifactIds: [], consumerBindingIds: [], conditions: ['healthy'],
      evidenceScorecard: { identity: 'verified', placement: 'verified' },
      displayName: 'lightpanda', kind: 'executable', consumerHosts: [], versions: {},
      guidanceLane: null, technicalDetails: [], recentlyChangedAt: null,
    }],
  };
  const { lanes } = admit(withExecutable);
  const byId = Object.fromEntries(lanes.decision[0].choices.map((choice) => [choice.choiceId, choice]));
  assert.equal(byId['repair-registration'].grounded, true);
});

test('J1: remove becomes grounded once a matching removal provider is registered', () => {
  // resourceKinds uses the legacy vocabulary a real MCP-removal provider
  // would declare (mirrors codex-mcp.mjs's own `resourceKinds: ['mcpServer']`,
  // 'host: claude' hypothesized since no such provider exists yet — the
  // fixture's decision choice text says exactly that).
  const provider = { id: 'claude-mcp-remove', version: '1', host: 'claude', resourceKinds: ['mcpServer'], operations: ['remove'] };
  const { lanes } = admit(SENTINEL_FIXTURES.base(), { providers: new Map([['claude-mcp-remove', provider]]) });
  const byId = Object.fromEntries(lanes.decision[0].choices.map((choice) => [choice.choiceId, choice]));
  assert.equal(byId.remove.grounded, true);
});

// ── J2: shared skill never admits guidance ─────────────────────────────────

test('J2: the shared skill placement (healthy, consumed by two hosts) admits no Guidance', () => {
  const { inventory } = admit(SENTINEL_FIXTURES.base());
  const skill = inventory.placements.find((p) => p.displayName === 'clarity' && p.administrativeScope === 'user');
  assert.equal(skill.guidanceLane, null);
});

// ── J6: provider-owned model removal ────────────────────────────────────────

function ollamaContext(activeSecond = true) {
  // Real shape from src/lib/maintenance/providers/ollama-model-remove.mjs's
  // detect(): tags = every installed model (by name+digest); loaded = the
  // subset currently loaded by name only (MNT-MDL-002 gate).
  return {
    providers: new Map([['ollama-model', { id: 'ollama-model', version: 'v1', resourceKinds: ['model'], operations: ['remove'] }]]),
    detections: new Map([['ollama-model', {
      status: 'available', complete: true,
      tags: [{ name: 'llama3.2:3b', digest: 'sha256-llama32', sizeBytes: 2_000_000_000 }, { name: 'qwen2.5-coder:7b', digest: 'sha256-qwen', sizeBytes: 3_000_000_000 }],
      loaded: activeSecond ? [{ name: 'qwen2.5-coder:7b' }] : [],
    }]]),
  };
}

test('J6: inactive model removal remains optional with irreversible+redownload impact', () => {
  const { inventory, actions, counts } = admit(SENTINEL_FIXTURES.models(), ollamaContext());
  const inactive = inventory.placements.find((p) => p.displayName === 'llama3.2:3b');
  assert.equal(inactive.guidanceLane, null);
  assert.equal(counts.apply, 0);
  const entry = actions.find((e) => e.placementId === inactive.placementId);
  assert.equal(entry.verb, 'remove');
  assert.equal(entry.purpose, 'optional-management');
  assert.equal(entry.impact.irreversible, true);
  assert.equal(entry.impact.redownloadRequired, true);
  assert.ok(entry.warning);
  assert.equal(entry.warning.containmentChoice, 'snooze');
});

test('J6: the active model never admits removal (MNT-MDL-002)', () => {
  const { inventory } = admit(SENTINEL_FIXTURES.models(), ollamaContext());
  const active = inventory.placements.find((p) => p.displayName === 'qwen2.5-coder:7b');
  assert.equal(active.guidanceLane, null);
});

test('J6: without a registered ollama-model provider, no apply guidance is admitted at all', () => {
  const { counts, actions } = admit(SENTINEL_FIXTURES.models());
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

// ── J9: remedy-free stays calm evidence ─────────────────────────────────────

test('J9: remedyFreeInspector returns the exact NO_ACTION_REQUESTED_DETAIL copy', () => {
  assert.equal(remedyFreeInspector(), NO_ACTION_REQUESTED_DETAIL);
});

test('J9: the hook and unchecked-credential placements admit no Guidance and cost nothing in counts', () => {
  const { inventory, counts } = admit(SENTINEL_FIXTURES.base());
  const hook = inventory.placements.find((p) => p.displayName === 'SessionStart AutoMemory');
  const credential = inventory.placements.find((p) => p.displayName === 'OpenAI credential');
  assert.equal(hook.guidanceLane, null);
  assert.equal(credential.guidanceLane, null);
  assert.equal(counts.total, lanesTotalOf(counts));
  function lanesTotalOf(c) { return c.apply + c.steps + c.decision + c.update + c.recovery; }
});

test('J9: inspectorFor a remedy-free placement reports NO_ACTION_REQUESTED_DETAIL', () => {
  const { inventory } = admit(SENTINEL_FIXTURES.base());
  const hook = inventory.placements.find((p) => p.displayName === 'SessionStart AutoMemory');
  const inspector = inspectorFor(inventory, hook.placementId, { guidance: inventory.guidanceEntries });
  assert.deepEqual(inspector.whatCanIAccomplish, { detail: NO_ACTION_REQUESTED_DETAIL });
});

// ── Apply lane: claude-plugin ────────────────────────────────────────────────

test('an enabled Claude plugin offers optional disabling without recommending it', () => {
  const { actions, counts } = admit(SENTINEL_FIXTURES.base(), { providers: new Map([['claude-plugin', claudePluginProvider()]]), detections: claudePluginDetections() });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].purpose, 'optional-management');
  assert.equal(counts.apply, 0);
  assert.equal(actions[0].verb, 'disable');
  assert.match(actions[0].providerCapabilityId, /^claude-plugin:v1:disable:user$/);
});

test('a provider that does not declare the matched operation admits nothing (defense in depth)', () => {
  const { counts, actions } = admit(SENTINEL_FIXTURES.base(), { providers: new Map([['claude-plugin', claudePluginProvider([])]]), detections: claudePluginDetections() });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

test('a disabled plugin never admits an apply/disable entry', () => {
  const { counts, actions } = admit(SENTINEL_FIXTURES.base(), { providers: new Map([['claude-plugin', claudePluginProvider()]]), detections: claudePluginDetections({ enabled: false }) });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

// ── Mutation blocks (MNT-RCV-009) ───────────────────────────────────────────

test('a mutation block on the exact placement suppresses only its apply-lane entry', () => {
  const { inventory: unblocked } = admit(SENTINEL_FIXTURES.base(), { providers: new Map([['claude-plugin', claudePluginProvider()]]), detections: claudePluginDetections() });
  const pluginPlacementId = unblocked.placements.find((p) => p.displayName === 'frontend-design').placementId;
  const { counts, actions } = admit(SENTINEL_FIXTURES.base(), {
    providers: new Map([['claude-plugin', claudePluginProvider()]]), detections: claudePluginDetections(),
    mutationBlocks: [{ receiptId: 'mnt-x', placementIds: [pluginPlacementId], environmentId: 'env_x', dependents: [], broad: false }],
  });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
  assert.ok(counts.steps > 0); // unrelated lanes for other placements remain
});

test('a broad mutation block suppresses apply guidance across its whole environment', () => {
  const base = SENTINEL_FIXTURES.base();
  const environmentId = base.environments[0].environmentId;
  const { counts, actions } = admit(base, {
    providers: new Map([['claude-plugin', claudePluginProvider()]]), detections: claudePluginDetections(),
    mutationBlocks: [{ receiptId: 'mnt-x', placementIds: [], environmentId, dependents: [], broad: true }],
  });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

// ── Dispositions (MNT-GUD-009) ───────────────────────────────────────────────

test('a snoozed disposition suppresses only its exact matching guidance entry', () => {
  const withApply = admit(SENTINEL_FIXTURES.base(), { providers: new Map([['claude-plugin', claudePluginProvider()]]), detections: claudePluginDetections() });
  const identity = withApply.actions[0].dispositionIdentity;
  const { counts, actions } = admit(SENTINEL_FIXTURES.base(), {
    providers: new Map([['claude-plugin', claudePluginProvider()]]), detections: claudePluginDetections(),
    dispositions: [{ dispositionIdentity: identity, kind: 'snoozed' }],
  });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
  assert.ok(counts.steps > 0); // Lightpanda's steps entries are untouched
});

test('an acknowledged disposition does NOT suppress the guidance entry (MNT-GUD-009)', () => {
  const withApply = admit(SENTINEL_FIXTURES.base(), { providers: new Map([['claude-plugin', claudePluginProvider()]]), detections: claudePluginDetections() });
  const identity = withApply.actions[0].dispositionIdentity;
  const { counts, actions } = admit(SENTINEL_FIXTURES.base(), {
    providers: new Map([['claude-plugin', claudePluginProvider()]]), detections: claudePluginDetections(),
    dispositions: [{ dispositionIdentity: identity, kind: 'acknowledged' }],
  });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 1);
});

// ── Update lane (MNT-GUD-004..008; not exercised by any sentinel fixture) ──

function updateInventory({ compatible = true, recommended = false, channel = 'stable', candidate = '2.0.0' } = {}) {
  const base = SENTINEL_FIXTURES.base();
  const target = base.placements.find((p) => p.displayName === 'frontend-design');
  const scorecard = {
    ...target.evidenceScorecard,
    ...(compatible ? { compatibility: 'verified' } : {}),
    ...(recommended ? { recommendationAuthority: 'verified' } : {}),
  };
  return {
    ...base,
    placements: base.placements.map((p) => (p.placementId === target.placementId
      ? { ...p, evidenceScorecard: scorecard, versions: { ...p.versions, channel } }
      : p)),
    versionObservations: [
      ...base.versionObservations,
      { subjectId: target.placementId, field: 'candidateSource', value: candidate, grade: 'provider-declared', authority: 'claude-plugins marketplace', sourceRef: 'claude:marketplace', capturedAt: FIXTURE_NOW, freshness: 'fresh', completeness: 'complete', scope: 'user', axis: 'candidate' },
    ],
  };
}

test('a verified candidate WITHOUT verified compatibility never admits Updates available (MNT-GUD-006)', () => {
  const { counts } = admit(updateInventory({ compatible: false }));
  assert.equal(counts.update, 0);
});

test('a verified candidate WITH verified compatibility admits Updates available, unrecommended by default', () => {
  const { lanes } = admit(updateInventory({ compatible: true, recommended: false }));
  assert.equal(lanes.update.length, 1);
  assert.equal(lanes.update[0].recommended, undefined);
});

test('"Recommended" appears only with a named recommendation authority (MNT-GUD-005)', () => {
  const { lanes } = admit(updateInventory({ compatible: true, recommended: true }));
  assert.equal(lanes.update[0].recommended, true);
  assert.match(lanes.update[0].outcome, /recommended/);
});

test('a prerelease candidate is withheld unless enrolled or explicitly enabled (MNT-GUD-007)', () => {
  const withheld = admit(updateInventory({ compatible: true, channel: 'prerelease' }));
  assert.equal(withheld.counts.update, 0);
  const enabledByChannel = admit(updateInventory({ compatible: true, channel: 'prerelease' }), {
    channelPolicy: { enabledChannels: ['prerelease'] },
  });
  assert.equal(enabledByChannel.counts.update, 1);
});

// ── Recovery lane ────────────────────────────────────────────────────────────

test('a receipt whose action carries a matching placementId admits a recovery entry with the Audit action', () => {
  const base = SENTINEL_FIXTURES.base();
  const target = base.placements.find((p) => p.displayName === 'frontend-design');
  const receipt = { id: 'mnt-x', status: 'applying', actions: [{ actionId: 'a1', placementId: target.placementId }] };
  const { lanes, inventory } = admit(base, { receipts: [receipt] });
  assert.equal(lanes.recovery.length, 1);
  assert.equal(lanes.recovery[0].receiptId, 'mnt-x');
  const row = inventory.placements.find((p) => p.placementId === target.placementId);
  assert.equal(row.guidanceLane, 'recovery'); // recovery outranks every other lane
});

test('a legacy receipt with no placementId linkage admits no recovery entry (graceful no-op)', () => {
  const { counts } = admit(SENTINEL_FIXTURES.base(), {
    receipts: [{ id: 'mnt-legacy', status: 'applying', actions: [{ actionId: 'a1', resourceIdentity: { kind: 'stale-npx-env' } }] }],
  });
  assert.equal(counts.recovery, 0);
});

test('a finished receipt never admits a recovery entry', () => {
  const base = SENTINEL_FIXTURES.base();
  const target = base.placements.find((p) => p.displayName === 'frontend-design');
  const receipt = { id: 'mnt-done', status: 'committed', actions: [{ actionId: 'a1', placementId: target.placementId }] };
  const { counts } = admit(base, { receipts: [receipt] });
  assert.equal(counts.recovery, 0);
});

// ── Language policy ──────────────────────────────────────────────────────────

test('no outcome, choice label/reason, or warning text across any fixture combination is a prohibited label', () => {
  const combos = [
    admit(SENTINEL_FIXTURES.base(), { providers: new Map([['claude-plugin', claudePluginProvider()]]), detections: claudePluginDetections() }),
    admit(SENTINEL_FIXTURES.models(), ollamaContext()),
    admit(SENTINEL_FIXTURES.wsl()),
    admit(SENTINEL_FIXTURES.incomplete()),
    admit(SENTINEL_FIXTURES.projects()),
  ];
  for (const { inventory } of combos) {
    for (const entry of inventory.guidanceEntries) {
      assert.equal(isProhibitedLabel(entry.outcome), false);
      for (const choice of entry.choices ?? []) {
        assert.equal(isProhibitedLabel(choice.label), false);
        if (choice.reason) assert.equal(isProhibitedLabel(choice.reason), false);
      }
    }
  }
});

// ── Real provider matchers: ground-truth identity fields ────────────────────
// Detection shapes below are copied from the providers' own source and their
// conformance tests (maintenance-provider-conformance.test.mjs,
// maintenance-owned-providers.test.mjs, maintenance-git-project-patch.test.mjs,
// maintenance-model-removal.test.mjs) — not invented shapes.

test('claude-plugin: an exact ref+scope match is required — a same-name plugin in a DIFFERENT scope never matches (never name-only)', () => {
  const { counts, actions } = admit(SENTINEL_FIXTURES.base(), {
    providers: new Map([['claude-plugin', claudePluginProvider()]]),
    // Same ref as the fixture's user-scope plugin, but only a PROJECT-scope
    // row is detected — the fixture's placement is user-scope.
    detections: new Map([['claude-plugin', {
      status: 'available', complete: true,
      plugins: [{ ref: 'frontend-design@claude-plugins', version: '0.3.1', scope: 'project', enabled: true, candidateStatus: 'exact', availableVersion: '0.4.0' }],
    }]]),
  });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

function codexPluginPlacement({ installed = true, enabled = true } = {}) {
  const inventory = singlePlacementInventory({
    kind: 'plugin', administrativeScope: 'user', displayName: 'demo', consumerHosts: ['codex'],
  });
  const providers = new Map([['codex-plugin', { id: 'codex-plugin', version: 'v1', host: 'codex', resourceKinds: ['plugin'], operations: ['remove'] }]]);
  const detections = new Map([['codex-plugin', {
    status: 'available', complete: true,
    plugins: [{ ref: 'demo', version: '1.0.0', installed, enabled, candidates: [] }],
  }]]);
  return { inventory, providers, detections };
}

test('codex-plugin: an installed plugin admits apply/remove regardless of enabled state (no enabled gate in the real provider)', () => {
  const { inventory, providers, detections } = codexPluginPlacement({ installed: true, enabled: false });
  const { actions, counts } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].purpose, 'optional-management');
  assert.equal(actions[0].verb, 'remove');
  assert.match(actions[0].providerCapabilityId, /^codex-plugin:v1:remove:user$/);
});

test('codex-plugin: incomplete detection admits no apply-lane guidance', () => {
  const { inventory, providers } = codexPluginPlacement();
  const { counts, actions } = admit(inventory, {
    providers, detections: new Map([['codex-plugin', { status: 'available', complete: false, plugins: [] }]]),
  });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

test('codex-plugin: a name-equal plugin the host reports as NOT installed never matches (identity, not name, proves eligibility)', () => {
  const { inventory, providers } = codexPluginPlacement({ installed: false });
  const { counts, actions } = admit(inventory, {
    providers, detections: new Map([['codex-plugin', {
      status: 'available', complete: true, plugins: [{ ref: 'demo', version: '1.0.0', installed: false, enabled: false, candidates: [] }],
    }]]),
  });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

function codexMcpPlacement(scope = 'user') {
  const inventory = singlePlacementInventory({
    kind: 'mcp-registration', administrativeScope: scope, displayName: 'demo-mcp', consumerHosts: ['codex'],
  });
  const providers = new Map([['codex-mcp', { id: 'codex-mcp', version: 'v1', host: 'codex', resourceKinds: ['mcpServer'], operations: ['remove'] }]]);
  return { inventory, providers };
}

test('codex-mcp: a registered server at scope=user admits apply/remove (matches the conformance test\'s own fixture shape)', () => {
  const { inventory, providers } = codexMcpPlacement('user');
  const detections = new Map([['codex-mcp', { status: 'available', complete: true, servers: [{ name: 'demo-mcp', enabled: true }] }]]);
  const { actions, counts } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].purpose, 'optional-management');
  assert.equal(actions[0].findingResourceKey.id, 'mcp:codex:demo-mcp');
});

test('codex-mcp: the SAME name at a different scope never matches — codex-mcp only supports scope=user', () => {
  const { inventory, providers } = codexMcpPlacement('project');
  const detections = new Map([['codex-mcp', { status: 'available', complete: true, servers: [{ name: 'demo-mcp', enabled: true }] }]]);
  const { counts, actions } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

test('codex-mcp: incomplete detection admits no apply-lane guidance', () => {
  const { inventory, providers } = codexMcpPlacement('user');
  const { counts, actions } = admit(inventory, {
    providers, detections: new Map([['codex-mcp', { status: 'available', complete: false, servers: [] }]]),
  });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

function npxCachePlacement() {
  return singlePlacementInventory({ kind: 'cache', administrativeScope: 'machine', displayName: 'stale npx cache' });
}

test('agentic-kit-npx-cache: an executable candidate linked by placementId admits apply/clean-cache', () => {
  const inventory = npxCachePlacement();
  const placementId = inventory.placements[0].placementId;
  const providers = new Map([['agentic-kit-npx-cache', { id: 'agentic-kit-npx-cache', version: 'v1', resourceKinds: ['stale-npx-env'], operations: ['clean'] }]]);
  const detections = new Map([['agentic-kit-npx-cache', {
    status: 'available', complete: true,
    candidates: [{ resourceId: 'stale-npx-env:demo', executable: true, sourceFingerprint: 'fp', placementId, bytesReclaimable: 5_000_000 }],
  }]]);
  const { lanes, counts } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 1);
  assert.equal(lanes.apply[0].providerCapabilityId, 'agentic-kit-npx-cache:v1:clean:machine');
  assert.equal(lanes.apply[0].findingResourceKey.id, 'stale-npx-env:demo');
});

test('agentic-kit-npx-cache: a candidate for a DIFFERENT placementId never matches (identity, not proximity)', () => {
  const inventory = npxCachePlacement();
  const providers = new Map([['agentic-kit-npx-cache', { id: 'agentic-kit-npx-cache', version: 'v1', resourceKinds: ['stale-npx-env'], operations: ['clean'] }]]);
  const detections = new Map([['agentic-kit-npx-cache', {
    status: 'available', complete: true,
    candidates: [{ resourceId: 'stale-npx-env:demo', executable: true, sourceFingerprint: 'fp', placementId: 'plc_someone_elses_cache_00000000' }],
  }]]);
  const { counts, actions } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

test('agentic-kit-npx-cache: incomplete detection admits no apply-lane guidance', () => {
  const inventory = npxCachePlacement();
  const providers = new Map([['agentic-kit-npx-cache', { id: 'agentic-kit-npx-cache', version: 'v1', resourceKinds: ['stale-npx-env'], operations: ['clean'] }]]);
  const { counts, actions } = admit(inventory, {
    providers, detections: new Map([['agentic-kit-npx-cache', { status: 'available', complete: false, candidates: [] }]]),
  });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

function orphanPlacement() {
  return singlePlacementInventory({ kind: 'executable', administrativeScope: 'machine', displayName: 'orphaned ruflo transport', conditions: ['orphaned-process'] });
}

test('ruflo-mcp-orphan: an executable orphan linked by placementId admits apply/remove(terminate)', () => {
  const inventory = orphanPlacement();
  const placementId = inventory.placements[0].placementId;
  const providers = new Map([['ruflo-mcp-orphan', { id: 'ruflo-mcp-orphan', version: 'v1', resourceKinds: ['daemon'], operations: ['terminate'] }]]);
  const detections = new Map([['ruflo-mcp-orphan', {
    status: 'available', complete: true, capability: { status: 'available' },
    orphans: [{ resourceId: 'ruflo-mcp-orphan:4242', pid: 4242, executable: true, placementId }],
  }]]);
  const { lanes, counts } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 1);
  assert.equal(lanes.apply[0].findingResourceKey.id, 'ruflo-mcp-orphan:4242');
});

test('ruflo-mcp-orphan: an unsupported capability (current user identity unavailable) admits no apply-lane guidance', () => {
  const inventory = orphanPlacement();
  const providers = new Map([['ruflo-mcp-orphan', { id: 'ruflo-mcp-orphan', version: 'v1', resourceKinds: ['daemon'], operations: ['terminate'] }]]);
  const { counts, actions } = admit(inventory, {
    providers, detections: new Map([['ruflo-mcp-orphan', { status: 'unsupported', complete: false, capability: { status: 'unsupported' }, orphans: [] }]]),
  });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

test('ruflo-mcp-orphan: a placement without the orphaned-process condition never matches even with a live detection', () => {
  const inventory = singlePlacementInventory({ kind: 'executable', administrativeScope: 'machine', displayName: 'not orphaned', conditions: ['healthy'] });
  const placementId = inventory.placements[0].placementId;
  const providers = new Map([['ruflo-mcp-orphan', { id: 'ruflo-mcp-orphan', version: 'v1', resourceKinds: ['daemon'], operations: ['terminate'] }]]);
  const detections = new Map([['ruflo-mcp-orphan', {
    status: 'available', complete: true, capability: { status: 'available' },
    orphans: [{ resourceId: 'ruflo-mcp-orphan:4242', pid: 4242, executable: true, placementId }],
  }]]);
  const { counts, actions } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

function skillReceiptPlacement(scope = 'user') {
  return singlePlacementInventory({ kind: 'skill', administrativeScope: scope, displayName: 'clarity' });
}

test('agentic-kit-owned-skill: an owned-current, executable receipt linked by placementId admits apply/archive', () => {
  const inventory = skillReceiptPlacement('user');
  const placementId = inventory.placements[0].placementId;
  const providers = new Map([['agentic-kit-owned-skill', { id: 'agentic-kit-owned-skill', version: 'v1', resourceKinds: ['skill'], operations: ['archive', 'prune'] }]]);
  const detections = new Map([['agentic-kit-owned-skill', {
    status: 'available', complete: true,
    skills: [{ resourceId: 'skill-receipt:clarity:user', scope: 'user', status: 'owned-current', executable: true, sourceFingerprint: 'fp', placementId }],
  }]]);
  const { actions, counts } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].purpose, 'optional-management');
  assert.equal(actions[0].verb, 'archive');
  assert.equal(actions[0].findingResourceKey.scope, 'user');
});

test('agentic-kit-owned-skill: the same linked receipt with drifted content (not owned-current) never matches', () => {
  const inventory = skillReceiptPlacement('user');
  const placementId = inventory.placements[0].placementId;
  const providers = new Map([['agentic-kit-owned-skill', { id: 'agentic-kit-owned-skill', version: 'v1', resourceKinds: ['skill'], operations: ['archive', 'prune'] }]]);
  const detections = new Map([['agentic-kit-owned-skill', {
    status: 'available', complete: true,
    skills: [{ resourceId: 'skill-receipt:clarity:user', scope: 'user', status: 'modified-or-shape-drift', executable: false, placementId }],
  }]]);
  const { counts, actions } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

function projectFilePlacement() {
  return singlePlacementInventory({ kind: 'instruction-context-file', administrativeScope: 'project', displayName: 'CLAUDE.md' });
}

test('git-project-patch: a preview matching the recorded preimage (status=matches-preimage) admits apply/apply-project-patch', () => {
  const inventory = projectFilePlacement();
  const placementId = inventory.placements[0].placementId;
  const providers = new Map([['git-project-patch', { id: 'git-project-patch', version: 'v1', resourceKinds: ['project-file'], operations: ['apply-project-patch'] }]]);
  const detections = new Map([['git-project-patch', {
    status: 'available', complete: true,
    patches: [{ resourceId: 'patch:claude-md:1', status: 'matches-preimage', placementId }],
  }]]);
  const { lanes, counts } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 1);
  assert.equal(lanes.apply[0].rowAction ?? lanes.apply[0].verb, 'apply-project-patch');
});

test('git-project-patch: affected-path drift (status=drift) never admits apply, mirroring actionFor\'s own refusal', () => {
  const inventory = projectFilePlacement();
  const placementId = inventory.placements[0].placementId;
  const providers = new Map([['git-project-patch', { id: 'git-project-patch', version: 'v1', resourceKinds: ['project-file'], operations: ['apply-project-patch'] }]]);
  const detections = new Map([['git-project-patch', {
    status: 'available', complete: true,
    patches: [{ resourceId: 'patch:claude-md:1', status: 'drift', placementId }],
  }]]);
  const { counts, actions } = admit(inventory, { providers, detections });
  assert.equal(counts.apply, 0);
  assert.equal(actions.length, 0);
});

test('ollama-model: a placement-carried digest that disagrees with the detected tag never matches (identity, not name-only)', () => {
  const strippedModels = { ...SENTINEL_FIXTURES.models(), guidanceEntries: [], placements: SENTINEL_FIXTURES.models().placements.map((p) => ({ ...p, guidanceLane: null })) };
  const providers = new Map([['ollama-model', { id: 'ollama-model', version: 'v1', resourceKinds: ['model'], operations: ['remove'] }]]);
  const detections = new Map([['ollama-model', {
    status: 'available', complete: true,
    // Same NAME as the fixture's inactive model, but a different digest —
    // and the second model stays loaded, so only the digest check is
    // exercised for llama3.2:3b.
    tags: [{ name: 'llama3.2:3b', digest: 'sha256-completely-different', sizeBytes: 1_000 }, { name: 'qwen2.5-coder:7b', digest: 'sha256-qwen', sizeBytes: 1 }],
    loaded: [{ name: 'qwen2.5-coder:7b' }],
  }]]);
  const { inventory, counts } = admit(strippedModels, { providers, detections });
  const llama = inventory.placements.find((p) => p.displayName === 'llama3.2:3b');
  assert.equal(llama.guidanceLane, null);
  assert.equal(counts.apply, 0);
});
