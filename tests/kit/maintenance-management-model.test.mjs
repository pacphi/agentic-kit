import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMINISTRATIVE_SCOPES, AUDIT_RESULTS, AUDIT_RESULT_LABELS, CONFLICT_EXPLANATIONS, CONFLICT_KINDS,
  CREDENTIAL_READINESS, CREDENTIAL_READINESS_LABELS, CURATED_VIEWS, CURATED_VIEW_LABELS,
  GUIDANCE_LANES, GUIDANCE_LANE_LABELS, INVENTORY_GROUP_ORDER, MANAGEMENT_INVENTORY_SCHEMA,
  MANAGEMENT_SCHEMA_VERSION, NO_ACTION_REQUESTED_DETAIL, PACKAGE_MANAGERS,
  PACKAGE_MANAGER_RELEASE_MODELS, RECONCILE_OUTCOME_LABELS, RECONCILE_OUTCOMES, RESOURCE_KINDS,
  RESOURCE_KIND_LABELS, SCAN_STATES, SCAN_TRANSITIONS, SCOPE_LENSES, assertLabelAllowed,
  assertManagementInventory, canonicalJson, emptyManagementInventory, isOpaqueId, isProhibitedLabel,
  opaqueId, sourceComplete,
} from '../../src/lib/maintenance/management/model.mjs';
import {
  FIXTURE_KEY, FIXTURE_NOW, SENTINEL_FIXTURES, id,
} from '../fixtures/maintenance/management-fixtures.mjs';

const KEY = 'k'.repeat(32);

test('MNT-INV-005: administrative scopes are stored and Across scopes is only a lens', () => {
  assert.deepEqual([...ADMINISTRATIVE_SCOPES], ['system', 'machine', 'user', 'project']);
  assert.ok(SCOPE_LENSES.includes('across'));
  assert.ok(!ADMINISTRATIVE_SCOPES.includes('across'));
});

test('MNT-INV-006: all fifteen v1 resource kinds are first-class and labelled', () => {
  assert.equal(RESOURCE_KINDS.length, 15);
  for (const kind of RESOURCE_KINDS) {
    assert.equal(typeof RESOURCE_KIND_LABELS[kind], 'string');
    assert.ok(!isProhibitedLabel(RESOURCE_KIND_LABELS[kind]), kind);
  }
});

test('MNT-GUD-001: guidance has exactly the five visible lanes', () => {
  assert.deepEqual([...GUIDANCE_LANES], ['apply', 'steps', 'decision', 'update', 'recovery']);
  assert.deepEqual(Object.values(GUIDANCE_LANE_LABELS), [
    'Can apply here', 'Steps available', 'Decisions to make', 'Updates available', 'Recovery to finish',
  ]);
  assert.deepEqual([...INVENTORY_GROUP_ORDER], [
    'recovery', 'apply', 'steps', 'decision', 'update', 'evidence-only', 'healthy',
  ]);
});

test('MNT-EVD-006: prohibited user-facing labels are detected; explanatory sentences are allowed', () => {
  for (const label of ['Unknown', 'unsupported', 'Needs attention', 'Review', 'Fix', 'Repair all', 'Clean all', 'Unknown source']) {
    assert.equal(isProhibitedLabel(label), true, label);
  }
  for (const label of ['Remove MCP registration', 'The intended source cannot be inferred.', 'Disable Claude plugin', 'Open details', 'Fixture']) {
    assert.equal(isProhibitedLabel(label), false, label);
  }
  assert.throws(() => assertLabelAllowed('Needs attention', 'row.label'), /prohibited/);
  assert.equal(assertLabelAllowed('Clean cache'), 'Clean cache');
  for (const label of Object.values(CURATED_VIEW_LABELS)) assert.ok(!isProhibitedLabel(label), label);
  for (const label of Object.values(CREDENTIAL_READINESS_LABELS)) assert.ok(!isProhibitedLabel(label), label);
  for (const label of Object.values(AUDIT_RESULT_LABELS)) assert.ok(!isProhibitedLabel(label), label);
  for (const label of Object.values(RECONCILE_OUTCOME_LABELS)) assert.ok(!isProhibitedLabel(label), label);
});

test('MNT-EVD-007: the remedy-free detail text says no action is requested', () => {
  assert.match(NO_ACTION_REQUESTED_DETAIL, /^No action is requested\./);
});

test('MNT-EVD-010: every conflict classification explains what it proves and does not prove', () => {
  assert.equal(CONFLICT_KINDS.length, 7);
  for (const kind of CONFLICT_KINDS) {
    const explanation = CONFLICT_EXPLANATIONS[kind];
    assert.ok(explanation.proves.length > 10, kind);
    assert.ok(explanation.doesNotProve.length > 10, kind);
    assert.ok(!isProhibitedLabel(explanation.label), kind);
  }
  assert.match(CONFLICT_EXPLANATIONS['shared-artifact'].doesNotProve, /not a duplicate/);
});

test('MNT-PRV-001: credential readiness uses exactly the five agreed states', () => {
  assert.deepEqual([...CREDENTIAL_READINESS], [
    'not-configured', 'configured-not-checked', 'ready', 'check-failed', 'expired-renewal-needed',
  ]);
  assert.equal(CREDENTIAL_READINESS_LABELS['configured-not-checked'], 'Configured but not checked');
});

test('MNT-RCV-006: conclusive audit results map to exactly three reconciliation writes', () => {
  assert.equal(AUDIT_RESULTS.length, 7);
  assert.deepEqual([...RECONCILE_OUTCOMES], ['record-no-change', 'record-completed', 'record-restored']);
  assert.equal(AUDIT_RESULT_LABELS['matching-inspection-provider-not-present'], 'Matching inspection provider is not present');
});

test('MNT-ACT-018: every named package manager has a release model for the N-3 policy', () => {
  assert.equal(PACKAGE_MANAGERS.length, 20);
  for (const manager of PACKAGE_MANAGERS) {
    assert.ok(['semver', 'os-coupled', 'rolling'].includes(PACKAGE_MANAGER_RELEASE_MODELS[manager]), manager);
  }
});

test('MNT-DSC-011: the scan state machine never lets a work slice terminate a valid scan', () => {
  assert.deepEqual([...SCAN_STATES], [
    'configured', 'queued', 'scanning', 'checkpointed', 'paused', 'complete', 'published', 'stopped', 'failed',
  ]);
  assert.ok(SCAN_TRANSITIONS.scanning.includes('checkpointed'));
  assert.ok(SCAN_TRANSITIONS.checkpointed.includes('scanning'));
  assert.ok(!SCAN_TRANSITIONS.checkpointed.includes('failed'));
  assert.ok(!SCAN_TRANSITIONS.checkpointed.includes('complete'), 'a checkpoint is continuation, not completion');
  assert.deepEqual(SCAN_TRANSITIONS.published, []);
});

test('opaque ids are stable per installation key, prefixed, and non-reversible', () => {
  const a = opaqueId('plc', { path: '/Users/secret/.claude/settings.json', selector: 'mcpServers.x' }, KEY);
  const again = opaqueId('plc', { selector: 'mcpServers.x', path: '/Users/secret/.claude/settings.json' }, KEY);
  const other = opaqueId('plc', { path: '/Users/secret/.claude/settings.json', selector: 'mcpServers.x' }, 'z'.repeat(32));
  assert.equal(a, again, 'key order does not change identity');
  assert.notEqual(a, other, 'a different installation key changes identity');
  assert.ok(isOpaqueId(a, 'plc'));
  assert.ok(!isOpaqueId(a, 'res'));
  assert.ok(!a.includes('secret'));
  assert.throws(() => opaqueId('nope', {}, KEY), /unknown opaque id prefix/);
  assert.throws(() => opaqueId('plc', {}, 'short'), /installation key/);
  assert.equal(canonicalJson({ b: 1, a: [undefined, { d: 2, c: 3 }] }), '{"a":[null,{"c":3,"d":2}],"b":1}');
});

test('empty inventories validate and carry the versioned schema', () => {
  const inventory = emptyManagementInventory({ inventoryId: opaqueId('inv', { n: 1 }, KEY), capturedAt: FIXTURE_NOW });
  assert.equal(inventory.schemaVersion, MANAGEMENT_SCHEMA_VERSION);
  assert.equal(inventory.schema, MANAGEMENT_INVENTORY_SCHEMA);
  assert.equal(assertManagementInventory(inventory), inventory);
  assert.ok(Object.isFrozen(inventory.placements));
});

test('every sentinel fixture validates against the structural contract', () => {
  for (const [name, build] of Object.entries(SENTINEL_FIXTURES)) {
    const inventory = build();
    assert.equal(assertManagementInventory(inventory), inventory, name);
    assert.ok(!JSON.stringify(inventory).includes('/Users/'), `${name} carries no home path`);
  }
});

test('MNT-PRV-004: an inventory carrying a local path anywhere is rejected', () => {
  const base = structuredClone(SENTINEL_FIXTURES.base());
  base.placements[0].technicalDetails = ['Configured at /Users/someone/.claude.json'];
  assert.throws(() => assertManagementInventory(base), /must not carry a local path/);
  const windows = structuredClone(SENTINEL_FIXTURES.base());
  windows.artifacts[0].label = 'C:\\Users\\someone\\.claude.json';
  assert.throws(() => assertManagementInventory(windows), /must not carry a local path/);
});

test('MNT-INV-003: placements must reference resources, environments, artifacts, and bindings in the same inventory', () => {
  const broken = structuredClone(SENTINEL_FIXTURES.base());
  broken.placements[0].resourceId = id('res', { stray: true });
  assert.throws(() => assertManagementInventory(broken), /must reference a resource/);
  const acrossStored = structuredClone(SENTINEL_FIXTURES.base());
  acrossStored.placements[0].administrativeScope = 'across';
  assert.throws(() => assertManagementInventory(acrossStored), /never across/);
  const locator = structuredClone(SENTINEL_FIXTURES.base());
  locator.placements[0].exactLocatorRef = 'x';
  assert.throws(() => assertManagementInventory(locator), /owner-private/);
});

test('MNT-EVD-002: inferred identity or placement evidence cannot enter the inventory', () => {
  const inferred = structuredClone(SENTINEL_FIXTURES.base());
  inferred.placements[1].evidenceScorecard = { identity: 'inferred', placement: 'verified' };
  assert.throws(() => assertManagementInventory(inferred), /verified identity and placement/);
});

test('MNT-GUD-002: guidance entries require an exact placement and lane-specific grounding', () => {
  const ungrounded = structuredClone(SENTINEL_FIXTURES.base());
  delete ungrounded.guidanceEntries[0].procedureId;
  assert.throws(() => assertManagementInventory(ungrounded), /must bind an operation, procedure, choice, candidate, or receipt audit/);
  const wrongLane = structuredClone(SENTINEL_FIXTURES.base());
  wrongLane.guidanceEntries[0].lane = 'apply';
  assert.throws(() => assertManagementInventory(wrongLane), /requires a provider capability/);
  const prohibited = structuredClone(SENTINEL_FIXTURES.base());
  prohibited.guidanceEntries[2].outcome = 'Fix';
  assert.throws(() => assertManagementInventory(prohibited), /prohibited/);
});

test('MNT-INV-012: WSL environments must name their Windows host', () => {
  const wsl = structuredClone(SENTINEL_FIXTURES.wsl());
  delete wsl.environments[1].parentEnvironmentId;
  assert.throws(() => assertManagementInventory(wsl), /WSL requires its Windows host/);
});

test('MNT-DSC-013: complete coverage cannot carry pending partitions and source completeness is per environment', () => {
  const inventory = SENTINEL_FIXTURES.base();
  assert.equal(sourceComplete(inventory, inventory.environments[0].environmentId), true);
  const incomplete = SENTINEL_FIXTURES.incomplete();
  assert.equal(sourceComplete(incomplete, incomplete.environments[0].environmentId), false);
  assert.equal(sourceComplete(inventory, id('env', { missing: true })), false);
  const broken = structuredClone(inventory);
  broken.sourceCoverage[0].pendingPartitions = 1;
  assert.throws(() => assertManagementInventory(broken), /complete coverage cannot have pending partitions/);
});

test('fixture ids derive from the fixture key only', () => {
  assert.equal(id('plc', { a: 1 }), opaqueId('plc', { a: 1 }, FIXTURE_KEY));
  assert.equal(CURATED_VIEWS.length, 15);
});

test('MNT-INV-004/J2: a shared-artifact set may hold one placement but must name exactly one artifact; other kinds need two placements', () => {
  const base = SENTINEL_FIXTURES.base();
  const shared = base.conflictSets.find((set) => set.kind === 'shared-artifact');
  assert.equal(shared.placementIds.length, 1, 'one artifact, one placement, two bindings is a shared set');
  assert.equal(shared.artifactIds.length, 1);
  const noArtifact = structuredClone(base);
  delete noArtifact.conflictSets.find((set) => set.kind === 'shared-artifact').artifactIds;
  assert.throws(() => assertManagementInventory(noArtifact), /names exactly one artifact/);
  const twoArtifacts = structuredClone(base);
  twoArtifacts.conflictSets.find((set) => set.kind === 'shared-artifact').artifactIds = [base.artifacts[1].artifactId, base.artifacts[2].artifactId];
  assert.throws(() => assertManagementInventory(twoArtifacts), /names exactly one artifact/);
  const loneDuplicate = structuredClone(base);
  loneDuplicate.conflictSets.find((set) => set.kind === 'duplicate-placement').placementIds = [base.placements[1].placementId];
  assert.throws(() => assertManagementInventory(loneDuplicate), /at least 2 placement/);
});
