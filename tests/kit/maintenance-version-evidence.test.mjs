import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitGuidance } from '../../src/lib/maintenance/management/guidance.mjs';
import { catalogVersions } from '../../src/lib/maintenance/management/catalog-versions.mjs';
import { buildManagementInventory } from '../../src/lib/maintenance/management/projection.mjs';
import { runInventoryQuery } from '../../src/lib/maintenance/management/query.mjs';
import { publicInventoryPage } from '../../src/lib/dashboard/maintenance-api.mjs';

const facts = { status: 'available', complete: true, asOf: '2026-09-08T12:00:00.000Z', plugins: [{ ref: 'aqe@market', version: '1.0.0', scope: 'user', candidateStatus: 'exact', availableVersion: '2.0.0' }] };
function versions(overrides = {}) {
  return catalogVersions({ item: { kind: 'plugin', name: 'aqe@market' }, first: { host: 'claude' }, group: { scope: 'user' }, pluginEvidence: { claude: facts }, now: Date.now, ...overrides });
}
test('native release evidence retains installed, candidate, source and unknown compatibility', () => {
  const v = versions();
  assert.equal(v.installed, '1.0.0');assert.equal(v.candidate, '2.0.0');
  assert.equal(v.compatibility, 'Not verified');assert.equal(v.checkedAt, facts.asOf);
});
test('bundled skills inherit plugin versions without claiming their own release version', () => {
  const v = versions({ item: { kind: 'skill', pluginRef: 'aqe@market' } });
  assert.equal(v.installed, undefined);assert.equal(v.producer, '1.0.0');assert.equal(v.providedBy, 'aqe@market');
});
test('different host or scope does not borrow release evidence', () => {
  assert.equal(versions({ group: { scope: 'project' } }).installed, undefined);
  assert.equal(versions({ first: { host: 'codex' } }).installed, undefined);
});
test('cache generations and MCP configuration are never installed package versions', () => {
  const v = versions({ item: { kind: 'skill' }, first: { host: 'codex', provider: { ref: 'aqe@market', version: null, cacheGeneration: '9.0.0' } } });
  assert.equal(v.installed, undefined);assert.equal(v.producer, undefined);assert.equal(v.cacheGeneration, '9.0.0');
  assert.equal(versions({ item: { kind: 'mcpServer', name: 'aqe' } }).updateStatus, 'No update source');
});
test('ambiguous or older candidates are not advertised as upgrades', () => {
  assert.equal(versions({ pluginEvidence: { claude: { ...facts, plugins: [{ ...facts.plugins[0], candidateStatus: 'ambiguous' }] } } }).candidate, undefined);
  assert.equal(versions({ pluginEvidence: { claude: { ...facts, plugins: [{ ...facts.plugins[0], availableVersion: '0.9.0' }] } } }).candidate, undefined);
});
test('family grouping preserves differing identities and bounded pagination without dropping installations', () => {
  const presence = Array.from({ length: 205 }, (_, i) => ({ host: i % 2 ? 'claude' : 'codex', scope: 'user', artifactId: 'a'+i, digest: { status: 'measured', value: 'digest'+i }, consumer: { enabled: true } }));
  const { inventory } = buildManagementInventory({ environment: { platform: 'darwin' }, installationKey: 'test-key-0123456789abcdef', footprint: { catalog: { items: [{ canonicalId: 'mcpServer::aqe', kind: 'mcpServer', name: 'aqe', presence }] } } });
  assert.equal(new Set(inventory.placements.map((p) => p.resourceId)).size, 205);
  let cursor, family;const seen = [];
  do {
    const page = publicInventoryPage(runInventoryQuery(inventory, { limit: 200, cursor }));
    assert.equal(page.groups.length, 1);
    family ??= page.groups[0].presentationKey;
    assert.equal(page.groups[0].presentationKey, family);
    assert.equal(page.groups[0].knownPlacementCount, 205);
    assert.deepEqual(new Set(page.groups[0].knownHosts), new Set(['claude', 'codex']));
    seen.push(...page.groups[0].placements.map((p) => p.placementId));cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 205);assert.equal(seen.length, 205);
});

test('numeric prerelease identifiers compare correctly without treating tags as versions', () => {
  const withRelease = (installed, available) => versions({ pluginEvidence: { claude: { ...facts, plugins: [{ ...facts.plugins[0], version: installed, availableVersion: available }] } } });
  assert.equal(withRelease('1.0.0-alpha.9', '1.0.0-alpha.10').updateStatus, 'Update available');
  assert.equal(withRelease('1.0.0', '1.0.0-alpha.10').candidate, undefined);
  assert.equal(withRelease('stable', 'next').updateStatus, 'Different release reported');
});

test('observed upgrade candidates appear in Updates without gaining an apply action', () => {
  const installationKey = 'test-key-0123456789abcdef';
  const { inventory } = buildManagementInventory({ environment: { platform: 'darwin' }, installationKey, footprint: { catalog: { items: [{ canonicalId: 'plugin::aqe@market', name: 'aqe@market', kind: 'plugin', presence: [{ host: 'claude', scope: 'user', artifactId: 'plugin', plugin: { ref: 'aqe@market', scope: 'user', version: '1.0.0' } }] }] } }, discovery: { pluginEvidence: { claude: facts } } });
  const admitted = admitGuidance({ inventory, installationKey }).inventory;
  const page = runInventoryQuery(admitted, { view: 'updates' });
  assert.equal(page.total, 1);
  assert.equal(page.groups[0].placements[0].versions.candidate, '2.0.0');
  assert.equal(admitted.guidanceEntries.some((g) => g.lane === 'apply'), false);
  assert.notEqual(admitted.placements[0].evidenceScorecard.compatibility, 'verified');
});
