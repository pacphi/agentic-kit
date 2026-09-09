import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectorFor } from '../../src/lib/maintenance/management/guidance.mjs';
import { publicInspector } from '../../src/lib/dashboard/maintenance-api.mjs';
import { baseInventory, id } from '../fixtures/maintenance/management-fixtures.mjs';

function fixture() {
  const inventory = structuredClone(baseInventory());
  const skill = inventory.placements.find((row) => row.kind === 'skill' && row.administrativeScope === 'user');
  const plugin = inventory.placements.find((row) => row.kind === 'plugin');
  const pluginResource = inventory.resources.find((row) => row.resourceId === plugin.resourceId);
  const ref = `${plugin.displayName}@${pluginResource.namespace}`;
  inventory.resources.find((row) => row.resourceId === skill.resourceId).namespace = ref;
  inventory.provenanceAssertions.push({ subjectId: skill.placementId, field: 'provenance', grade: 'verified', freshness: 'fresh', completeness: 'complete', value: { kind: 'plugin-marketplace', label: ref } });
  return { inventory, skill, plugin };
}

const relationships = (inventory, placement) => inspectorFor(inventory, placement.placementId).relationships;

test('explicit verified plugin provenance links both directions to the unique installation', () => {
  const { inventory, skill, plugin } = fixture();
  assert.equal(relationships(inventory, skill).providedBy[0].placementId, plugin.placementId);
  assert.equal(relationships(inventory, plugin).includes[0].placementId, skill.placementId);
  assert.equal(relationships(inventory, skill).originStatus, 'recorded');
});

for (const reason of ['missing', 'inferred', 'stale', 'partial', 'wrong-scope', 'wrong-host', 'ambiguous']) {
  test(`plugin relationships do not guess a parent when evidence is ${reason}`, () => {
    const { inventory, skill, plugin } = fixture();
    const provenance = inventory.provenanceAssertions.at(-1);
    if (reason === 'missing') inventory.provenanceAssertions.pop();
    if (reason === 'inferred') provenance.grade = 'inferred';
    if (reason === 'stale') provenance.freshness = 'stale';
    if (reason === 'partial') provenance.completeness = 'partial';
    if (reason === 'wrong-scope') plugin.administrativeScope = 'project';
    if (reason === 'wrong-host') plugin.consumerHosts = ['unrelated-host'];
    if (reason === 'ambiguous') inventory.placements.push({ ...plugin, placementId: id('plc', 'second-plugin') });
    assert.deepEqual(relationships(inventory, skill).providedBy, []);
    assert.deepEqual(relationships(inventory, plugin).includes, []);
  });
}

test('dependencies link only exact verified placement targets; unresolved and logical targets never guess installations', () => {
  const { inventory, skill, plugin } = fixture();
  const exact = { edgeId: id('edg', 'exact'), fromPlacementId: skill.placementId, toId: plugin.placementId, kind: 'requires-provider', grade: 'verified', satisfied: true };
  inventory.dependencyEdges = [exact,
    { ...exact, edgeId: id('edg', 'resource'), toId: plugin.resourceId },
    { ...exact, edgeId: id('edg', 'inferred'), grade: 'inferred' },
    { ...exact, edgeId: id('edg', 'override'), kind: 'same-config-precedence' }];
  const forward = relationships(inventory, skill).dependencies;
  assert.equal(forward.length, 2);
  assert.equal(forward[0].target.placementId, plugin.placementId);
  assert.equal(forward[1].target, undefined);
  assert.equal(relationships(inventory, plugin).dependents[0].target.placementId, skill.placementId);
  assert.equal(relationships(inventory, skill).overrides, undefined);
});

test('same family links separate placements but same names and unknown provenance do not imply ownership', () => {
  const inventory = structuredClone(baseInventory());
  const skill = inventory.placements.find((row) => row.kind === 'skill' && row.administrativeScope === 'user');
  const other = inventory.placements.find((row) => row.kind === 'skill' && row.administrativeScope === 'project');
  assert.deepEqual(relationships(inventory, skill).otherInstallations, []);
  const family = id('res', 'recorded-family');
  for (const resource of inventory.resources.filter((row) => [skill.resourceId, other.resourceId].includes(row.resourceId))) resource.presentationFamilyId = family;
  assert.equal(relationships(inventory, skill).otherInstallations[0].placementId, other.placementId);
  assert.equal(relationships(inventory, skill).originStatus, 'not-established');
  assert.deepEqual(relationships(inventory, skill).providedBy, []);
});

test('relationship consumer evidence and API target projection remain bounded and path-free', () => {
  const { inventory, skill } = fixture();
  inventory.consumerBindings.find((row) => row.bindingId === skill.consumerBindingIds[0]).grade = 'inferred';
  const inspector = inspectorFor(inventory, skill.placementId);
  assert.equal(inspector.relationships.consumers.length, 1);
  inspector.relationships.providedBy[0].privatePath = '/private/secret';
  inspector.relationships.providedBy[0].displayName = '/private/secret';
  const projected = publicInspector(inspector);
  assert.equal(projected.relationships.providedBy[0].privatePath, undefined);
  assert.equal(JSON.stringify(projected).includes('/private/secret'), false);
});

// catalog.mjs pluginSurfaceSpecs records top-level plugin names as full refs
// and pluginRef:null; component specs record provider.ref as pluginRef.
// Also accept projected full-ref namespaces without appending the ref twice.
for (const form of ['catalog', 'full-ref-namespace', 'short-name-full-ref-namespace']) {
  test(`catalog projection resolves included skill parent with ${form}`, async () => {
    const { buildManagementInventory } = await import('../../src/lib/maintenance/management/projection.mjs');
    const ref = 'interface-toolkit@example-market';
    const pluginName = form === 'short-name-full-ref-namespace' ? 'interface-toolkit' : ref;
    const provider = { ref, name: 'interface-toolkit', marketplace: 'example-market', version: '1.0.0' };
    const presence = (artifactId, extra = {}) => ({ host: 'claude', scope: 'plugin', project: null,
      artifactId, consumer: { mechanism: 'plugin-installation', enabled: true, configScope: 'user' }, ...extra });
    const { inventory } = buildManagementInventory({
      installationKey: 'fixture-installation-key-0123456789abcdef', environment: { platform: 'darwin' },
      now: () => Date.parse('2026-09-05T12:00:00.000Z'),
      footprint: { catalog: { items: [
        { canonicalId: `plugin::${ref}`, kind: 'plugin', name: pluginName, capabilityName: pluginName,
          pluginRef: form === 'catalog' ? null : ref,
          presence: [presence('catalog-plugin', { plugin: { ...provider, scope: 'user' } })] },
        { canonicalId: `skill::plugin:${ref}:review`, kind: 'skill', name: 'interface-toolkit:review', capabilityName: 'review',
          pluginRef: ref, presence: [presence('catalog-skill', { provider })] },
      ] } },
    });
    const skill = inventory.placements.find((row) => row.kind === 'skill');
    const plugin = inventory.placements.find((row) => row.kind === 'plugin');
    assert.equal(relationships(inventory, skill).providedBy[0]?.placementId, plugin.placementId);
    assert.equal(relationships(inventory, plugin).includes[0]?.placementId, skill.placementId);
  });
}

test('full namespace reference naming another plugin cannot become a synthetic parent reference', () => {
  const { inventory, skill, plugin } = fixture();
  inventory.resources.find((row) => row.resourceId === plugin.resourceId).namespace = 'different-plugin@example-market';
  const inventedRef = `${plugin.displayName}@different-plugin@example-market`;
  inventory.resources.find((row) => row.resourceId === skill.resourceId).namespace = inventedRef;
  inventory.provenanceAssertions.at(-1).value.label = inventedRef;
  assert.deepEqual(relationships(inventory, skill).providedBy, []);
});
