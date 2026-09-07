import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mutationBlocksForGuidance, placementsForResourceKey, resolvePlacementFinding,
} from '../../src/lib/maintenance/management/correlation.mjs';
import { admitGuidance } from '../../src/lib/maintenance/management/guidance.mjs';
import {
  FIXTURE_KEY, baseInventory, id as fixtureId, wslInventory,
} from '../fixtures/maintenance/management-fixtures.mjs';

function findPlacement(inventory, predicate) {
  const placement = inventory.placements.find(predicate);
  assert.ok(placement, 'fixture must contain the expected placement');
  return placement;
}

// MNT-ACT: resolvePlacementFinding — exactly-one-match resolution ─────────────

test('resolvePlacementFinding: correlates a plugin placement to its exact finding (MNT-ACT-013)', () => {
  const inventory = baseInventory();
  const plugin = findPlacement(inventory, (p) => p.kind === 'plugin');
  const findings = [
    {
      id: 'finding-plugin-1',
      resource: {
        id: 'plugin:claude:frontend-design@claude-plugins', kind: 'plugin', name: 'frontend-design',
        host: 'claude', scope: 'user', providerRef: 'frontend-design@claude-plugins',
      },
    },
    {
      id: 'finding-unrelated',
      resource: {
        id: 'skill:clarity', kind: 'skill', name: 'clarity', host: 'claude', scope: 'user',
      },
    },
  ];
  const { findingId, finding } = resolvePlacementFinding({
    inventory, findings, placementId: plugin.placementId,
  });
  assert.equal(findingId, 'finding-plugin-1');
  assert.equal(finding.resource.name, 'frontend-design');
});

test('resolvePlacementFinding: refuses an unknown placement (MNT-ACT-013)', () => {
  const inventory = baseInventory();
  assert.throws(
    () => resolvePlacementFinding({ inventory, findings: [], placementId: 'plc_does-not-exist' }),
    (error) => error.code === 'PLACEMENT_FINDING_UNRESOLVED' && error.matchCount === 0,
  );
});

test('resolvePlacementFinding: refuses when zero findings correlate (MNT-ACT-013)', () => {
  const inventory = baseInventory();
  const plugin = findPlacement(inventory, (p) => p.kind === 'plugin');
  assert.throws(
    () => resolvePlacementFinding({ inventory, findings: [], placementId: plugin.placementId }),
    (error) => error.code === 'PLACEMENT_FINDING_UNRESOLVED' && error.matchCount === 0,
  );
});

test('resolvePlacementFinding: refuses when more than one finding correlates (MNT-ACT-013)', () => {
  const inventory = baseInventory();
  const plugin = findPlacement(inventory, (p) => p.kind === 'plugin');
  const ambiguous = {
    resource: {
      id: 'plugin:claude:frontend-design', kind: 'plugin', name: 'frontend-design', host: 'claude', scope: 'user',
    },
  };
  const findings = [{ id: 'a', ...ambiguous }, { id: 'b', ...ambiguous }];
  assert.throws(
    () => resolvePlacementFinding({ inventory, findings, placementId: plugin.placementId }),
    (error) => error.code === 'PLACEMENT_FINDING_UNRESOLVED' && error.matchCount === 2,
  );
});

test('resolvePlacementFinding: a user-scope finding never correlates to a project-scope placement of the same name', () => {
  const inventory = baseInventory();
  const projectSkill = findPlacement(inventory, (p) => p.kind === 'skill' && p.administrativeScope === 'project');
  const userScopeFinding = {
    id: 'finding-user-skill',
    resource: { id: 'skill:clarity', kind: 'skill', name: 'clarity', host: 'claude', scope: 'user' },
  };
  assert.throws(
    () => resolvePlacementFinding({ inventory, findings: [userScopeFinding], placementId: projectSkill.placementId }),
    (error) => error.code === 'PLACEMENT_FINDING_UNRESOLVED' && error.matchCount === 0,
  );
});

test('resolvePlacementFinding: a project-scope finding correlates to the matching project placement', () => {
  const inventory = baseInventory();
  const projectSkill = findPlacement(inventory, (p) => p.kind === 'skill' && p.administrativeScope === 'project');
  const projectFinding = {
    id: 'finding-project-skill',
    resource: {
      id: 'skill:clarity:project', kind: 'skill', name: 'clarity', host: 'claude',
      scope: 'project + shared', projectRef: 'maintenance-project-abc123',
    },
  };
  const { findingId } = resolvePlacementFinding({
    inventory, findings: [projectFinding], placementId: projectSkill.placementId,
  });
  assert.equal(findingId, 'finding-project-skill');
});

test('resolvePlacementFinding: codex-mcp correlates by kind/host/scope/name even when findingResourceKey.id differs from the scanner id', () => {
  const base = baseInventory();
  const envId = base.environments[0].environmentId;
  const resourceId = fixtureId('res', { kind: 'mcp-registration', host: 'codex', name: 'my-server' });
  const placementId = fixtureId('plc', { res: resourceId, env: envId, scope: 'user' });
  const placement = {
    placementId,
    resourceId,
    environmentId: envId,
    administrativeScope: 'user',
    locationBreadcrumb: ['Codex', 'User configuration', 'MCP servers'],
    artifactIds: [],
    consumerBindingIds: [],
    conditions: ['healthy'],
    evidenceScorecard: { identity: 'verified', placement: 'verified' },
    displayName: 'my-server',
    kind: 'mcp-registration',
    hostNamespace: 'codex',
    consumerHosts: ['codex'],
    versions: {},
    guidanceLane: null,
    technicalDetails: [],
    recentlyChangedAt: null,
  };
  const inventory = { ...base, placements: [...base.placements, placement] };

  // scanner.mjs's own finding id for a catalog row (`item.canonicalId`) is
  // computed independently of Q's guidance `findingResourceKey.id`
  // convention for the SAME row (`mcp:codex:<name>`, per a conformance
  // fixture) — the two need not agree, so `id` must never be a required
  // filter, only a disambiguating tiebreaker when the rest is ambiguous.
  const finding = {
    id: 'mcpServer::my-server',
    resource: {
      id: 'mcpServer::my-server', kind: 'mcpServer', name: 'my-server', host: 'codex', scope: 'user',
    },
  };
  const findingResourceKey = {
    kind: 'mcp-registration', id: 'mcp:codex:my-server', host: 'codex', scope: 'user',
  };

  const { findingId } = resolvePlacementFinding({
    inventory, findings: [finding], placementId, findingResourceKey,
  });
  assert.equal(findingId, 'mcpServer::my-server');
});

// placementsForResourceKey ────────────────────────────────────────────────────

test('placementsForResourceKey: narrows by mapped kind, host, and scope', () => {
  const inventory = baseInventory();
  const plugin = findPlacement(inventory, (p) => p.kind === 'plugin');
  const matches = placementsForResourceKey(inventory, { kind: 'plugin', host: 'claude', scope: 'user' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].placementId, plugin.placementId);
});

test('placementsForResourceKey: an unmatched key correlates to nothing', () => {
  const inventory = baseInventory();
  const matches = placementsForResourceKey(inventory, { kind: 'model', host: 'claude', scope: 'user' });
  assert.deepEqual(matches, []);
});

test('placementsForResourceKey: environmentId further narrows across WSL environments', () => {
  const inventory = wslInventory();
  const [windowsEnv, ubuntuEnv] = inventory.environments;
  const onWindows = placementsForResourceKey(
    inventory, { kind: 'executable', host: 'codex' }, { environmentId: windowsEnv.environmentId },
  );
  assert.equal(onWindows.length, 1);
  assert.equal(onWindows[0].environmentId, windowsEnv.environmentId);
  const onUbuntu = placementsForResourceKey(
    inventory, { kind: 'executable', host: 'codex' }, { environmentId: ubuntuEnv.environmentId },
  );
  assert.equal(onUbuntu.length, 1);
  assert.notEqual(onUbuntu[0].placementId, onWindows[0].placementId);
});

// mutationBlocksForGuidance ────────────────────────────────────────────────────

test('mutationBlocksForGuidance: a scoped block correlates to its exact placement', () => {
  const inventory = baseInventory();
  const plugin = findPlacement(inventory, (p) => p.kind === 'plugin');
  const rawBlocks = [{
    receiptId: 'mnt-1', status: 'applying', broad: false, environmentScope: 'current',
    placementKeys: [{ kind: 'plugin', id: 'x', host: 'claude', scope: 'user' }],
  }];
  const blocks = mutationBlocksForGuidance(rawBlocks, inventory);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].placementIds, [plugin.placementId]);
  assert.equal(blocks[0].broad, false);
  assert.equal(blocks[0].environmentId, plugin.environmentId);
});

test('mutationBlocksForGuidance: a broad block fans out to one entry per environment (fail-closed)', () => {
  const inventory = wslInventory();
  const rawBlocks = [{ receiptId: 'mnt-broken', status: 'unknown-recovery-required', broad: true, placementKeys: [] }];
  const blocks = mutationBlocksForGuidance(rawBlocks, inventory);
  assert.equal(blocks.length, inventory.environments.length);
  for (const environment of inventory.environments) {
    assert.ok(blocks.some((block) => block.broad && block.environmentId === environment.environmentId));
  }
});

test('mutationBlocksForGuidance: a scoped block with no correlating placement contributes no block', () => {
  const inventory = baseInventory();
  const rawBlocks = [{
    receiptId: 'mnt-2', status: 'applying', broad: false, environmentScope: 'current',
    placementKeys: [{ kind: 'model', id: 'x', host: 'ollama', scope: 'user' }],
  }];
  assert.deepEqual(mutationBlocksForGuidance(rawBlocks, inventory), []);
});

test("mutationBlocksForGuidance: T's own placementIds (from an action that carried an opaque placementId) are used directly", () => {
  const inventory = baseInventory();
  const plugin = findPlacement(inventory, (p) => p.kind === 'plugin');
  const rawBlocks = [{
    receiptId: 'mnt-3', status: 'applying', broad: false, environmentScope: 'current',
    placementKeys: [], placementIds: [plugin.placementId],
  }];
  const blocks = mutationBlocksForGuidance(rawBlocks, inventory);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].placementIds, [plugin.placementId]);
});

test("mutationBlocksForGuidance: environmentScope:'current' resolves to the caller's current environment id", () => {
  const inventory = wslInventory();
  const [windowsEnv] = inventory.environments;
  const executablePlacement = inventory.placements.find((p) => p.environmentId === windowsEnv.environmentId);
  const rawBlocks = [{
    receiptId: 'mnt-4', status: 'applying', broad: false, environmentScope: 'current',
    placementKeys: [], placementIds: [executablePlacement.placementId],
  }];
  const blocks = mutationBlocksForGuidance(rawBlocks, inventory, { currentEnvironmentId: windowsEnv.environmentId });
  assert.equal(blocks[0].environmentId, windowsEnv.environmentId);
});

// mutationBlocksForGuidance dependents + admitGuidance integration ──────────────
// Builds a small synthetic inventory of three `cache` placements admissible
// via the `agentic-kit-npx-cache` apply matcher, with C declared as depending
// on A, to prove a scoped block on A hides Guidance for A AND its verified
// dependent C, while leaving the unrelated B placement untouched — and that
// a broad (integrity-failure) block hides every one of them.

function cachePlacement(name, environmentId) {
  const resourceId = fixtureId('res', { kind: 'cache', name });
  const placementId = fixtureId('plc', { res: resourceId, env: environmentId });
  return {
    placementId,
    resourceId,
    environmentId,
    administrativeScope: 'machine',
    locationBreadcrumb: ['Storage', name],
    artifactIds: [],
    consumerBindingIds: [],
    conditions: ['healthy'],
    evidenceScorecard: { identity: 'verified', placement: 'verified' },
    displayName: name,
    kind: 'cache',
    consumerHosts: [],
    versions: {},
    guidanceLane: null,
    technicalDetails: [],
    recentlyChangedAt: null,
  };
}

function buildCacheInventory() {
  const environmentId = fixtureId('env', { kind: 'macos' });
  const a = cachePlacement('cache-a', environmentId);
  const b = cachePlacement('cache-b', environmentId);
  const c = cachePlacement('cache-c', environmentId);
  const edgeCtoA = {
    edgeId: fixtureId('edg', { from: c.placementId, to: a.placementId }),
    fromPlacementId: c.placementId,
    toId: a.placementId,
    kind: 'requires-runtime',
    grade: 'verified',
  };
  const inventory = {
    schemaVersion: 2,
    schema: 'maintenance-management-inventory/v2',
    inventoryId: fixtureId('inv', { fixture: 'cache-block-test' }),
    capturedAt: '2026-09-05T12:00:00.000Z',
    sourceFingerprint: 'fp-cache-block-test',
    environments: [{ environmentId, kind: 'macos', displayLabel: 'This Mac' }],
    sourceCoverage: [],
    resources: [a, b, c].map((placement) => ({
      resourceId: placement.resourceId, kind: 'cache', displayName: placement.displayName,
      placementIds: [placement.placementId],
    })),
    placements: [a, b, c],
    artifacts: [],
    consumerBindings: [],
    provenanceAssertions: [],
    versionObservations: [],
    dependencyEdges: [edgeCtoA],
    conflictSets: [],
    guidanceEntries: [],
  };
  return {
    inventory, environmentId, a, b, c,
  };
}

function npxCacheProviderAndDetections(placementIds) {
  const providers = new Map([
    ['agentic-kit-npx-cache', { id: 'agentic-kit-npx-cache', version: 'v1', operations: ['clean'] }],
  ]);
  const detections = new Map([
    ['agentic-kit-npx-cache', {
      status: 'available',
      complete: true,
      candidates: placementIds.map((placementId) => ({
        placementId, resourceId: `stale-npx-env:${placementId}`, executable: true,
      })),
    }],
  ]);
  return { providers, detections };
}

test('mutationBlocksForGuidance + admitGuidance: a scoped block hides the apply lane on the blocked placement and its verified dependent only', () => {
  const {
    inventory, environmentId, a, b, c,
  } = buildCacheInventory();
  const allIds = [a.placementId, b.placementId, c.placementId];
  const { providers, detections } = npxCacheProviderAndDetections(allIds);

  const baseline = admitGuidance({
    inventory, providers, detections, installationKey: FIXTURE_KEY,
  });
  assert.deepEqual(new Set(baseline.lanes.apply.map((entry) => entry.placementId)), new Set(allIds));

  const rawBlocks = [{
    receiptId: 'mnt-blocked', status: 'applying', broad: false, environmentScope: 'current',
    placementKeys: [], placementIds: [a.placementId],
  }];
  const mutationBlocks = mutationBlocksForGuidance(rawBlocks, inventory, { currentEnvironmentId: environmentId });
  assert.equal(mutationBlocks.length, 1);
  assert.deepEqual(mutationBlocks[0].placementIds, [a.placementId]);
  assert.deepEqual(new Set(mutationBlocks[0].dependents), new Set([c.placementId]));

  const blocked = admitGuidance({
    inventory, providers, detections, mutationBlocks, installationKey: FIXTURE_KEY,
  });
  const applyIds = new Set(blocked.lanes.apply.map((entry) => entry.placementId));
  assert.deepEqual(applyIds, new Set([b.placementId]), 'only the unrelated placement keeps its apply lane');
});

test('mutationBlocksForGuidance + admitGuidance: a broad block hides every apply lane', () => {
  const { inventory, a, b, c } = buildCacheInventory();
  const allIds = [a.placementId, b.placementId, c.placementId];
  const { providers, detections } = npxCacheProviderAndDetections(allIds);

  const rawBlocks = [{ receiptId: 'mnt-broken', status: 'unknown-recovery-required', broad: true, placementKeys: [] }];
  const mutationBlocks = mutationBlocksForGuidance(rawBlocks, inventory);
  assert.equal(mutationBlocks.length, inventory.environments.length);

  const blocked = admitGuidance({
    inventory, providers, detections, mutationBlocks, installationKey: FIXTURE_KEY,
  });
  assert.deepEqual(blocked.lanes.apply, []);
});
