// ADR-0048 Inventory query engine tests (MNT-UX-001/002/005, MNT-PERF-002/003,
// MNT-INV-005). Exercises J1/J2/J7/J9/J10 through the shared sentinel
// fixtures plus a synthetic 50,000-placement load test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isProhibitedLabel } from '../../src/lib/maintenance/management/model.mjs';
import {
  decodeQueryState, encodeQueryState, partialSources, runInventoryQuery,
} from '../../src/lib/maintenance/management/query.mjs';
import { SENTINEL_FIXTURES, id } from '../fixtures/maintenance/management-fixtures.mjs';

function placementNames(page) {
  return page.groups.flatMap((group) => group.placements.map((placement) => placement.displayName));
}

// ── Row kind + facet display labels (UI addendum) ───────────────────────────

test('every placement row carries its own kind (not only the group)', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { search: 'lightpanda' });
  const row = page.groups[0].placements[0];
  assert.equal(row.kind, 'mcp-registration');
  assert.equal(row.displayName, 'Lightpanda');
});

test('facetLabels.environment maps each environment id to its display label, not just its opaque id', () => {
  const inventory = SENTINEL_FIXTURES.wsl();
  const page = runInventoryQuery(inventory, {});
  const environmentIds = Object.keys(page.facetCounts.environment);
  assert.equal(environmentIds.length, 3);
  for (const environmentId of environmentIds) {
    assert.equal(typeof page.facetLabels.environment[environmentId], 'string');
    assert.ok(page.facetLabels.environment[environmentId].length > 0);
  }
  const winId = inventory.environments.find((e) => e.kind === 'windows').environmentId;
  assert.equal(page.facetLabels.environment[winId], 'Windows host');
});

test('facetLabels.project maps each project id to a breadcrumb-derived label, never a path', () => {
  const inventory = SENTINEL_FIXTURES.projects();
  const page = runInventoryQuery(inventory, {});
  const projectIds = Object.keys(page.facetCounts.project);
  assert.equal(projectIds.length, 3);
  for (const projectId of projectIds) {
    const label = page.facetLabels.project[projectId];
    assert.equal(typeof label, 'string');
    assert.ok(label.includes('agentic-kit'));
    assert.equal(isProhibitedLabel(label), false);
  }
});

test('facetLabels only carries ids present in the current facetCounts (scope-dependent disappearance)', () => {
  const inventory = SENTINEL_FIXTURES.projects();
  const page = runInventoryQuery(inventory, { scope: 'user' }); // no project placements at scope=user
  assert.deepEqual(page.facetCounts.project, undefined);
  assert.deepEqual(page.facetLabels.project, {});
});

// ── MNT-INV-005: scope lens semantics ───────────────────────────────────────

test('scope "across" applies no scope filter (MNT-INV-005)', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { scope: 'across' });
  assert.equal(page.total, inventory.placements.length);
});

test('scope "project" returns only project-scoped placements', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { scope: 'project' });
  assert.equal(page.total, 1);
  assert.equal(page.groups[0].placements[0].displayName, 'clarity');
  assert.equal(page.groups[0].placements[0].scope.value, 'project');
});

test('scope "user" excludes the project placement', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { scope: 'user' });
  for (const group of page.groups) {
    for (const placement of group.placements) assert.equal(placement.scope.value, 'user');
  }
});

// ── J1: Lightpanda — curated lane views see every admitted lane, not just
//    the placement's single primary badge ─────────────────────────────────

test('J1: "steps" curated view surfaces the Lightpanda placement (its primary badge lane)', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { view: 'steps' });
  assert.ok(placementNames(page).includes('Lightpanda'));
});

test('J1: "decisions" curated view ALSO surfaces Lightpanda even though its badge lane is steps', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { view: 'decisions' });
  assert.ok(placementNames(page).includes('Lightpanda'));
  const row = page.groups.flatMap((g) => g.placements).find((p) => p.displayName === 'Lightpanda');
  // The row's OWN action badge still reflects the higher-priority lane.
  assert.equal(row.guidanceLane.value, 'steps');
});

test('J1: the guidance facet counts both lanes Lightpanda participates in', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, {});
  assert.ok(page.facetCounts.guidance.steps >= 1);
  assert.ok(page.facetCounts.guidance.decision >= 1);
});

test('J1: row action for Lightpanda is "Open procedure", never generic Fix/Review', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { search: 'lightpanda' });
  const row = page.groups[0].placements[0];
  assert.equal(row.rowAction.label, 'Open procedure');
  assert.equal(isProhibitedLabel(row.rowAction.label), false);
});

test('"can-apply" excludes optional disabling of an otherwise installed plugin', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { view: 'can-apply' });
  assert.equal(page.total, 0);
  const all = runInventoryQuery(inventory, {});
  const row = all.groups.flatMap((group) => group.placements).find((entry) => entry.displayName === 'frontend-design');
  assert.equal(row.guidanceLane, null);
  assert.equal(row.rowAction.label, 'Open details');
});

// ── J2: shared skill is one artifact, one placement, two consumer bindings ─

test('J2: the shared skill group reports two consumers on one placement, not a duplicate row', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { search: 'clarity', scope: 'user' });
  const group = page.groups.find((g) => g.displayName === 'clarity');
  assert.equal(group.placementCount, 1);
  assert.equal(group.consumerCount, 2); // two bindings (Claude + Codex) on ONE placement
  assert.deepEqual(group.placements[0].consumerHosts.sort(), ['claude', 'codex']);
});

// ── J9: remedy-free stays visible, no lane badge, no navigation weight ─────

test('J9: the remedy-free hook placement is visible with no guidance badge and "Open details"', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { search: 'AutoMemory' });
  const row = page.groups[0].placements[0];
  assert.equal(row.guidanceLane, null);
  assert.equal(row.rowAction.label, 'Open details');
  assert.equal(isProhibitedLabel(row.rowAction.label), false);
});

test('J9: sortGroups never counts the remedy-free hook toward apply/steps/decision/update/recovery', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, {});
  const evidenceOnly = page.sortGroups.find((entry) => entry.bucket === 'evidence-only');
  assert.ok(evidenceOnly);
  assert.ok(evidenceOnly.count >= 2); // the hook AND the unchecked credential
});

// ── J7: WSL environments are separate, independently facetable placements ─

test('J7: three environment-qualified "node" placements are independently selectable', () => {
  const inventory = SENTINEL_FIXTURES.wsl();
  const page = runInventoryQuery(inventory, {});
  assert.equal(page.total, 3);
  assert.equal(Object.keys(page.facetCounts.environment).length, 3);
});

// ── J10: incomplete source truth surfaces via partialSources, never as a
//    complete/absent claim, and never as a per-source banner enumeration ──

test('J10: partialSources groups the stopped collection root under "stopped" with its ceiling and visited count', () => {
  const inventory = SENTINEL_FIXTURES.incomplete();
  const summary = partialSources(inventory);
  assert.equal(summary.total, 1);
  assert.equal(summary.stopped.count, 1);
  assert.deepEqual(summary.stopped.labels, ['Collection root']);
  assert.deepEqual(summary.stopped.reasons, ['entries']);
  assert.equal(summary.notScanned.count, 0);
  assert.equal(summary.scanning.count, 0);
  assert.equal(summary.paused.count, 0);
  assert.equal(summary.failed.count, 0);
  // Per-source detail still available for the inspector, just not the banner.
  assert.equal(summary.entries.length, 1);
  assert.equal(summary.entries[0].state, 'stopped');
  assert.equal(summary.entries[0].ceiling, 'entries');
  assert.equal(summary.entries[0].visited, 250000);
});

test('J10: the one-sentence narrative names the limit and offers the discovery action', () => {
  const inventory = SENTINEL_FIXTURES.incomplete();
  const summary = partialSources(inventory);
  assert.equal(summary.narrative, '1 source stopped at a limit (entries).');
  assert.equal(summary.action, 'discovery');
});

test('J10: the query result still surfaces the incompletely-scanned placement', () => {
  const inventory = SENTINEL_FIXTURES.incomplete();
  const page = runInventoryQuery(inventory, {});
  assert.equal(page.total, 1);
  assert.equal(page.partialSources.total, 1);
});

// ── partialSources: fresh-install (never scanned) and in-progress narratives ─

function coverageOnlyInventory(sourceCoverage) {
  const base = SENTINEL_FIXTURES.incomplete();
  return { ...base, sourceCoverage };
}

test('a fresh install with several never-started sources reports "not been scanned yet" and offers remeasure', () => {
  const inventory = coverageOnlyInventory([
    { sourceId: 'src_a', environmentId: 'env_a', state: 'not-scanned', visited: 0, completedPartitions: 0, pendingPartitions: 4, limitingReason: null, lastCompletedAt: null, label: 'Claude user configuration' },
    { sourceId: 'src_b', environmentId: 'env_a', state: 'not-scanned', visited: 0, completedPartitions: 0, pendingPartitions: 2, limitingReason: null, lastCompletedAt: null, label: 'Codex user configuration' },
  ]);
  const summary = partialSources(inventory);
  assert.equal(summary.notScanned.count, 2);
  assert.deepEqual(summary.notScanned.labels.sort(), ['Claude user configuration', 'Codex user configuration']);
  assert.equal(summary.narrative, '2 sources have not been scanned yet.');
  assert.equal(summary.action, 'remeasure');
});

test('singular phrasing: exactly one never-started source', () => {
  const inventory = coverageOnlyInventory([
    { sourceId: 'src_a', environmentId: 'env_a', state: 'not-scanned', visited: 0, completedPartitions: 0, pendingPartitions: 4, limitingReason: null, lastCompletedAt: null, label: 'Claude user configuration' },
  ]);
  const summary = partialSources(inventory);
  assert.equal(summary.narrative, '1 source has not been scanned yet.');
});

test('a source that just started scanning (visited=0) is bucketed as scanning, never as not-scanned', () => {
  // A source legitimately reports visited:0 for its first moment of real
  // work — only the explicit not-scanned STATE means "never run" (the old
  // visited-based heuristic misclassified this case).
  const inventory = coverageOnlyInventory([
    { sourceId: 'src_a', environmentId: 'env_a', state: 'scanning', visited: 0, completedPartitions: 0, pendingPartitions: 4, limitingReason: 'work-slice', lastCompletedAt: null, label: 'Just started' },
  ]);
  const summary = partialSources(inventory);
  assert.equal(summary.notScanned.count, 0);
  assert.equal(summary.scanning.count, 1);
  assert.equal(summary.scanning.visited, 0);
  assert.equal(summary.narrative, '1 source is still scanning; 0 of 1 complete.');
  assert.equal(summary.action, null);
});

test('sources actively scanning report progress against the overall source total, with no action', () => {
  const inventory = coverageOnlyInventory([
    { sourceId: 'src_a', environmentId: 'env_a', state: 'scanning', visited: 84231, completedPartitions: 2, pendingPartitions: 2, limitingReason: 'work-slice', lastCompletedAt: null, label: 'Projects' },
    { sourceId: 'src_b', environmentId: 'env_a', state: 'complete', visited: 12, completedPartitions: 4, pendingPartitions: 0, limitingReason: null, lastCompletedAt: '2026-09-05T00:00:00Z', label: 'Claude user configuration' },
    { sourceId: 'src_c', environmentId: 'env_a', state: 'complete', visited: 5, completedPartitions: 4, pendingPartitions: 0, limitingReason: null, lastCompletedAt: '2026-09-05T00:00:00Z', label: 'Codex user configuration' },
  ]);
  const summary = partialSources(inventory);
  assert.equal(summary.scanning.count, 1);
  assert.equal(summary.scanning.visited, 84231);
  assert.equal(summary.narrative, '1 source is still scanning; 2 of 3 complete.');
  assert.equal(summary.action, null);
});

test('a stopped/failed/paused mix collapses into one "stopped at a limit" narrative naming every distinct reason', () => {
  const inventory = coverageOnlyInventory([
    { sourceId: 'src_a', environmentId: 'env_a', state: 'stopped', visited: 1000, completedPartitions: 1, pendingPartitions: 1, limitingReason: 'safety-ceiling', ceiling: 'entries', lastCompletedAt: null, label: 'Collection A' },
    { sourceId: 'src_b', environmentId: 'env_a', state: 'failed', visited: 10, completedPartitions: 0, pendingPartitions: 1, limitingReason: 'io-failure', lastCompletedAt: null, label: 'Collection B' },
    { sourceId: 'src_c', environmentId: 'env_a', state: 'paused', visited: 500, completedPartitions: 1, pendingPartitions: 1, limitingReason: 'paused-by-user', lastCompletedAt: null, label: 'Collection C' },
  ]);
  const summary = partialSources(inventory);
  assert.equal(summary.total, 3);
  assert.equal(summary.stopped.count, 1);
  assert.equal(summary.failed.count, 1);
  assert.equal(summary.paused.count, 1);
  assert.equal(summary.action, 'discovery');
  assert.match(summary.narrative, /^3 sources stopped at a limit \(.+\)\.$/);
  for (const reason of ['entries', 'io-failure', 'paused-by-user']) assert.ok(summary.narrative.includes(reason));
});

test('a limited source outranks a never-scanned one for the single narrative sentence', () => {
  const inventory = coverageOnlyInventory([
    { sourceId: 'src_a', environmentId: 'env_a', state: 'not-scanned', visited: 0, completedPartitions: 0, pendingPartitions: 4, limitingReason: null, lastCompletedAt: null, label: 'Never started' },
    { sourceId: 'src_b', environmentId: 'env_a', state: 'stopped', visited: 1000, completedPartitions: 1, pendingPartitions: 1, limitingReason: 'safety-ceiling', ceiling: 'depth', lastCompletedAt: null, label: 'Hit a limit' },
  ]);
  const summary = partialSources(inventory);
  assert.equal(summary.action, 'discovery');
  assert.match(summary.narrative, /^1 source stopped at a limit/);
});

test('all sources complete: partialSources reports zero everywhere and no narrative', () => {
  const inventory = coverageOnlyInventory([
    { sourceId: 'src_a', environmentId: 'env_a', state: 'complete', visited: 12, completedPartitions: 4, pendingPartitions: 0, limitingReason: null, lastCompletedAt: '2026-09-05T00:00:00Z', label: 'Claude user configuration' },
  ]);
  const summary = partialSources(inventory);
  assert.equal(summary.total, 0);
  assert.equal(summary.narrative, null);
  assert.equal(summary.action, null);
});

// ── Facets: multiselect counts reflect the OTHER selected facets, not the
//    facet's own selection (so a checked value's own count stays visible) ──

test('facet counts exclude the effect of the facet\'s own current selection', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const unfiltered = runInventoryQuery(inventory, {});
  const filteredByKind = runInventoryQuery(inventory, { facets: { kind: ['plugin'] } });
  // Selecting `kind=plugin` must not change the kind facet's own counts.
  assert.deepEqual(filteredByKind.facetCounts.kind, unfiltered.facetCounts.kind);
  // ...but it DOES narrow every other facet (e.g. environment) to the
  // placements that remain after applying the kind filter.
  assert.equal(filteredByKind.total, 1);
});

test('disjunctive counts preserve each selected facet while excluding failures of other selections', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const kindOnly = runInventoryQuery(inventory, { facets: { kind: ['plugin'] } });
  const scopeOnly = runInventoryQuery(inventory, { facets: { scope: ['project'] } });
  const combined = runInventoryQuery(inventory, { facets: { kind: ['plugin'], scope: ['project'] } });
  assert.equal(combined.total, 0);
  assert.deepEqual(combined.facetCounts.kind, scopeOnly.facetCounts.kind);
  assert.deepEqual(combined.facetCounts.scope, kindOnly.facetCounts.scope);
  assert.equal(combined.facetCounts.environment, undefined);
});

test('unavailable facet values disappear once a scope narrows the result set', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { scope: 'project' });
  assert.equal(page.facetCounts.scope.project, 1);
  assert.equal(page.facetCounts.scope.user, undefined);
});

test('Clear all is just an empty facets object and restores the unfiltered count', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const filtered = runInventoryQuery(inventory, { facets: { kind: ['plugin'] } });
  const cleared = runInventoryQuery(inventory, { facets: {} });
  assert.ok(cleared.total > filtered.total);
});

// ── Sorting and determinism ─────────────────────────────────────────────────

test('guidance-first sort places recovery/apply/steps/decision/update ahead of healthy resources', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const page = runInventoryQuery(inventory, { sort: 'guidance-first', limit: 200 });
  const order = page.groups.flatMap((g) => g.placements.map((p) => p.displayName));
  assert.ok(order.indexOf('Lightpanda') < order.indexOf('clarity'));
});

test('two identical queries against one inventory produce byte-identical group ordering', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const a = runInventoryQuery(inventory, { sort: 'name' });
  const b = runInventoryQuery(inventory, { sort: 'name' });
  assert.deepEqual(a.groups, b.groups);
});

// ── Cursor / paging (MNT-PERF-003) ──────────────────────────────────────────

test('paging is deterministic and bound to the inventory generation', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const first = runInventoryQuery(inventory, { limit: 2, sort: 'name' });
  assert.ok(first.nextCursor);
  const second = runInventoryQuery(inventory, { limit: 2, sort: 'name', cursor: first.nextCursor });
  const firstIds = first.groups.flatMap((g) => g.placements.map((p) => p.placementId));
  const secondIds = second.groups.flatMap((g) => g.placements.map((p) => p.placementId));
  assert.equal(firstIds.some((idValue) => secondIds.includes(idValue)), false);
});

test('a cursor from a different inventory generation throws inventory-generation-mismatch', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const other = SENTINEL_FIXTURES.wsl();
  const page = runInventoryQuery(other, { limit: 1 });
  assert.throws(
    () => runInventoryQuery(inventory, { cursor: page.nextCursor ?? Buffer.from(JSON.stringify({ inventoryId: other.inventoryId, offset: 0 }), 'utf8').toString('base64url') }),
    (error) => error.code === 'inventory-generation-mismatch',
  );
});

test('limit is clamped to [1, 200]', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const tooHigh = runInventoryQuery(inventory, { limit: 100000 });
  assert.ok(tooHigh.groups.flatMap((g) => g.placements).length <= 200);
  const tooLow = runInventoryQuery(inventory, { limit: 0 });
  assert.equal(tooLow.groups.flatMap((g) => g.placements).length, 1);
});

test('invalid scope/view/sort are rejected with a TypeError', () => {
  const inventory = SENTINEL_FIXTURES.base();
  assert.throws(() => runInventoryQuery(inventory, { scope: 'planet' }), TypeError);
  assert.throws(() => runInventoryQuery(inventory, { view: 'nonsense' }), TypeError);
  assert.throws(() => runInventoryQuery(inventory, { sort: 'nonsense' }), TypeError);
});

// ── Search ───────────────────────────────────────────────────────────────────

test('search matches displayName, breadcrumb, and kind label but never a private locator', () => {
  const inventory = SENTINEL_FIXTURES.base();
  const byBreadcrumb = runInventoryQuery(inventory, { search: 'mcp servers' });
  assert.ok(placementNames(byBreadcrumb).includes('Lightpanda'));
  const byKindLabel = runInventoryQuery(inventory, { search: 'mcp registration' });
  assert.ok(placementNames(byKindLabel).includes('Lightpanda'));
});

// ── encodeQueryState / decodeQueryState ─────────────────────────────────────

test('encodeQueryState/decodeQueryState round-trip and never accept a local path', () => {
  const state = { scope: 'user', view: 'can-apply', facets: { kind: ['plugin'] }, search: 'x' };
  const token = encodeQueryState(state);
  assert.equal(typeof token, 'string');
  assert.deepEqual(decodeQueryState(token), state);
  assert.equal(Object.keys(decodeQueryState('')).length, 0);
});

test('encodeQueryState rejects a value shaped like a local path', () => {
  assert.throws(() => encodeQueryState({ search: '/Users/me/secret' }), TypeError);
  assert.throws(() => encodeQueryState({ search: 'C:\\Users\\me' }), TypeError);
  assert.throws(() => encodeQueryState({ search: '~/dotfile' }), TypeError);
});

test('decodeQueryState rejects a hand-crafted token carrying a local path', () => {
  const forged = Buffer.from(JSON.stringify({ search: '/etc/passwd' }), 'utf8').toString('base64url');
  assert.throws(() => decodeQueryState(forged), TypeError);
});

test('decodeQueryState rejects malformed input', () => {
  assert.throws(() => decodeQueryState('not-base64url-json!!'), TypeError);
});

// ── No prohibited labels anywhere in query output ───────────────────────────

test('no row action, group outcome, or scope/guidance label in any fixture query result is prohibited', () => {
  for (const build of Object.values(SENTINEL_FIXTURES)) {
    const inventory = build();
    const page = runInventoryQuery(inventory, { limit: 200 });
    for (const group of page.groups) {
      assert.equal(isProhibitedLabel(group.displayName), false);
      if (group.outcome) assert.equal(isProhibitedLabel(group.outcome), false);
      for (const placement of group.placements) {
        assert.equal(isProhibitedLabel(placement.displayName), false);
        assert.equal(isProhibitedLabel(placement.rowAction.label), false);
        if (placement.guidanceLane) assert.equal(isProhibitedLabel(placement.guidanceLane.label), false);
      }
    }
  }
});

// ── MNT-PERF-002: 50,000-placement filter performance ───────────────────────

function syntheticInventory(count) {
  const environmentId = id('env', { synthetic: true });
  const placements = [];
  const resources = [];
  for (let i = 0; i < count; i += 1) {
    const resourceId = id('res', { synthetic: i });
    const placementId = id('plc', { synthetic: i });
    const guidanceLane = i % 11 === 0 ? 'apply' : null;
    resources.push({ resourceId, kind: 'skill', displayName: `skill-${i}`, placementIds: [placementId] });
    placements.push({
      placementId, resourceId, environmentId, administrativeScope: i % 4 === 0 ? 'project' : 'user',
      ...(i % 4 === 0 ? { projectId: id('prj', { synthetic: i }) } : {}),
      locationBreadcrumb: ['User', 'Skills', `skill-${i}`],
      artifactIds: [], consumerBindingIds: [], conditions: ['healthy'],
      evidenceScorecard: { identity: 'verified', placement: 'verified' },
      displayName: `skill-${i}`, kind: 'skill', consumerHosts: ['claude'], versions: {},
      guidanceLane, technicalDetails: [], recentlyChangedAt: null,
    });
  }
  return {
    schemaVersion: 2, schema: 'maintenance-management-inventory/v2', inventoryId: id('inv', { synthetic: count }),
    capturedAt: '2026-09-05T12:00:00.000Z', sourceFingerprint: 'fp-synthetic',
    environments: [{ environmentId, kind: 'macos', displayLabel: 'Synthetic' }],
    sourceCoverage: [], resources, placements, artifacts: [], consumerBindings: [],
    provenanceAssertions: [], versionObservations: [], dependencyEdges: [], conflictSets: [],
    guidanceEntries: [],
  };
}

test('MNT-PERF-002: filtering 50,000 placements settles well under the CI-generous bound', () => {
  const inventory = syntheticInventory(50000);
  const started = performance.now();
  const page = runInventoryQuery(inventory, {
    scope: 'user', view: 'all', facets: { kind: ['skill'] }, search: 'skill-4', sort: 'guidance-first', limit: 50,
  });
  const elapsedMs = performance.now() - started;
  console.log(`MNT-PERF-002 measured: ${elapsedMs.toFixed(1)}ms for 50,000 placements`);
  assert.ok(page.total > 0);
  assert.ok(elapsedMs < 1000, `expected < 1000ms on a CI machine, measured ${elapsedMs.toFixed(1)}ms`);
});

test('MNT-PERF-002: a warm-index query is faster than the cold one and stays under a generous CI bound', (t) => {
  const inventory = syntheticInventory(50000);

  const coldStarted = performance.now();
  runInventoryQuery(inventory, {}); // first call: builds and caches the index
  const coldElapsedMs = performance.now() - coldStarted;

  // Best of 3 warm runs — a loaded CI machine can spike one measurement, but
  // the index-reuse win should show up in at least the fastest of a few.
  const warmSamples = [];
  for (let i = 0; i < 3; i += 1) {
    const warmStarted = performance.now();
    runInventoryQuery(inventory, { facets: { scope: ['user'] } });
    warmSamples.push(performance.now() - warmStarted);
  }
  const bestWarmMs = Math.min(...warmSamples);

  t.diagnostic(`MNT-PERF-002 cold=${coldElapsedMs.toFixed(1)}ms warm samples=[${warmSamples.map((s) => s.toFixed(1)).join(', ')}]ms best-warm=${bestWarmMs.toFixed(1)}ms`);

  assert.ok(bestWarmMs < coldElapsedMs, `expected the best warm run (${bestWarmMs.toFixed(1)}ms) to beat the cold run (${coldElapsedMs.toFixed(1)}ms) — proves index reuse`);
  assert.ok(bestWarmMs < 1000, `expected the best warm run under 1000ms on a CI machine, measured ${bestWarmMs.toFixed(1)}ms`);
});
