import assert from 'node:assert/strict';
import test from 'node:test';
import { runInventoryQuery } from '../../src/lib/maintenance/management/query.mjs';
import { publicInventoryPage } from '../../src/lib/dashboard/maintenance-api.mjs';
import { validateMaintenanceV2Query } from '../../src/lib/dashboard/maintenance-security.mjs';
import { baseInventory, id } from '../fixtures/maintenance/management-fixtures.mjs';

function fixture(count = 75) {
  const inventory = structuredClone(baseInventory());
  const template = inventory.placements.find((row) => row.kind === 'skill' && row.administrativeScope === 'user');
  inventory.placements = []; inventory.resources = []; inventory.guidanceEntries = [];
  for (let i = 0; i < count; i++) {
    const familyId = id('res', { family: i });
    for (const host of ['claude', 'codex']) {
      const resourceId = id('res', { family: i, host });
      const placementId = id('plc', { i, host });
      inventory.resources.push({ resourceId, presentationFamilyId: familyId, displayName: `Skill ${String(i).padStart(3, '0')}`, kind: 'skill', placementIds: [placementId] });
      inventory.placements.push({ ...template, placementId, resourceId, displayName: `Skill ${String(i).padStart(3, '0')}`, consumerHosts: [host], guidanceLane: null });
    }
  }
  return inventory;
}

test('focus roots summarize every matching installation before paging, including empty default scopes', () => {
  const inventory = fixture();
  const page = runInventoryQuery(inventory, { presentation: 'focus', limit: 2 });
  assert.deepEqual(page.navigation.nodes.map((row) => [row.value, row.count]), [['system', 0], ['machine', 0]]);
  const next = runInventoryQuery(inventory, { presentation: 'focus', limit: 2, cursor: page.nextCursor });
  assert.deepEqual(next.navigation.nodes.map((row) => [row.value, row.count]), [['user', 150], ['project', 0]]);
  assert.equal(next.nextCursor, undefined);
  assert.equal(next.total, 150);
  assert.deepEqual(next.groups, []);
});

test('focus resource paging uses family nodes and exact counts beyond the first 50 placements', () => {
  const inventory = fixture();
  const params = { presentation: 'focus', scope: 'user', facets: { kind: ['skill'] } };
  const page = runInventoryQuery(inventory, params);
  assert.equal(page.navigation.level, 'resource');
  assert.equal(page.navigation.nodes.length, 50);
  assert.ok(page.navigation.nodes.every((row) => row.count === 2));
  const second = runInventoryQuery(inventory, { ...params, cursor: page.nextCursor });
  assert.equal(second.navigation.nodes.length, 25);
  assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...page.navigation.nodes, ...second.navigation.nodes].map((row) => row.value)).size, 75);
  const leaf = runInventoryQuery(inventory, { ...params, facets: { ...params.facets, family: [second.navigation.nodes[0].value] } });
  assert.equal(leaf.navigation.level, 'installation');
  assert.equal(leaf.total, 2);
  assert.equal(leaf.groups.flatMap((row) => row.placements).length, 2);
  assert.equal(leaf.facetLabels.family[second.navigation.nodes[0].value], second.navigation.nodes[0].label);
});

test('focus counts reflect host and search filters and selected facets skip levels', () => {
  const inventory = fixture();
  const page = runInventoryQuery(inventory, { presentation: 'focus', scope: 'user', search: 'Skill 00', facets: { kind: ['skill'], consumer: ['codex'] } });
  assert.equal(page.total, 10);
  assert.equal(page.navigation.nodes.length, 10);
  assert.ok(page.navigation.nodes.every((row) => row.count === 1));
  const kindPage = runInventoryQuery(inventory, { presentation: 'focus', facets: { scope: ['user'] } });
  assert.equal(kindPage.navigation.level, 'kind');
  assert.equal(kindPage.navigation.nodes[0].count, 150);
});

test('project focus hides unselected worktree nodes before paging without changing totals or leaves', () => {
  const inventory = fixture(3);
  inventory.placements.forEach((row, i) => {
    row.administrativeScope = 'project'; row.projectId = id('prj', { project: Math.floor(i / 2) });
    row.projectKind = i < 2 ? 'worktree' : 'git'; row.projectBreadcrumb = [`Repo ${Math.floor(i / 2)}`];
  });
  const params = { presentation: 'focus', scope: 'project', limit: 1 };
  const page = runInventoryQuery(inventory, params);
  assert.equal(page.navigation.level, 'project');
  assert.equal(page.navigation.nodes[0].projectKind, 'git');
  assert.equal(page.total, 6);
  const next = runInventoryQuery(inventory, { ...params, cursor: page.nextCursor });
  assert.equal(next.nextCursor, undefined);
  const all = runInventoryQuery(inventory, { ...params, includeWorktrees: true, limit: 50 });
  assert.equal(all.navigation.nodes.length, 3);
  const selected = runInventoryQuery(inventory, { ...params, facets: { project: [inventory.placements[0].projectId] } });
  assert.equal(selected.navigation.level, 'kind');
  assert.equal(selected.total, 2);
});

test('flat query stays unchanged and API validates focus options and allowlists navigation', () => {
  const inventory = fixture(2);
  assert.equal(runInventoryQuery(inventory).navigation, undefined);
  assert.throws(() => runInventoryQuery(inventory, { presentation: 'tree' }), /presentation/);
  const query = validateMaintenanceV2Query('inventory', new URLSearchParams('presentation=focus&includeWorktrees=false'));
  assert.deepEqual(query, { presentation: 'focus', includeWorktrees: false, facets: {} });
  assert.throws(() => validateMaintenanceV2Query('inventory', new URLSearchParams('includeWorktrees=1')));
  const result = publicInventoryPage({ ...runInventoryQuery(inventory, query), ignoredPrivateField: '/private/secret' });
  assert.equal(result.navigation.level, 'scope');
  assert.equal(result.navigation.nodes.length, 4);
  assert.equal(result.ignoredPrivateField, undefined);
});


test('selected family breadcrumb label survives bounded API maps beyond 500 families', () => {
  const inventory = fixture(510);
  const family = inventory.resources.at(-1).presentationFamilyId;
  const page = publicInventoryPage(runInventoryQuery(inventory, { presentation: 'focus', facets: { family: [family] } }));
  assert.equal(page.navigation.level, 'installation');
  assert.equal(page.facetLabels.family[family], 'Skill 509');
});

test('focus labels retain distinct sources and omit conflicting family descriptions', () => {
  const inventory = fixture(1);
  for (const resource of inventory.resources) Object.assign(resource, { capabilityLabel: 'research', installationSource: 'Provided by research-plugin', descriptionSource: 'Description frontmatter' });
  inventory.placements[0].description = 'Researches documents';
  inventory.placements[1].description = 'Researches code';
  const params = { presentation: 'focus', scope: 'user', facets: { kind: ['skill'] } };
  const page = publicInventoryPage(runInventoryQuery(inventory, params));
  assert.equal(page.navigation.nodes[0].label, 'research');
  assert.equal(page.navigation.nodes[0].installationSource, 'Provided by research-plugin');
  assert.equal(page.navigation.nodes[0].description, null);
  const leaf = publicInventoryPage(runInventoryQuery(inventory, { ...params, facets: { ...params.facets, family: [page.navigation.nodes[0].value] } }));
  assert.deepEqual(new Set(leaf.groups.flatMap(g => g.placements.map(p => p.description))), new Set(['Researches documents', 'Researches code']));
});
test('project language evidence survives focus aggregation and the public DTO', () => {
  const inventory=fixture(1);
  for (const placement of inventory.placements) Object.assign(placement, { administrativeScope:'project', projectId:id('prj',{name:'polyglot'}), projectLanguages:[{id:'java',name:'Java',icon:'Jv',evidence:'source'},{id:'scratch',name:'Scratch',icon:'Scr',evidence:'artifact'}] });
  const page=publicInventoryPage(runInventoryQuery(inventory,{presentation:'focus',scope:'project'}));
  assert.deepEqual(page.navigation.nodes[0].languages.map(row=>row.id),['java','scratch']);
  assert.equal(page.navigation.nodes[0].languages[1].evidence,'artifact');
});
