import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManagementInventory } from '../../src/lib/maintenance/management/projection.mjs';
import { runInventoryQuery } from '../../src/lib/maintenance/management/query.mjs';
import { publicInventoryPage } from '../../src/lib/dashboard/maintenance-api.mjs';
import { validateMaintenanceV2Query } from '../../src/lib/dashboard/maintenance-security.mjs';

const options = { installationKey: 'maintenance-grouping-fixture-key', environment: { platform: 'darwin' }, now: () => 1700000000000 };
const repository = { kind: 'git', repositoryId: 'repository:0123456789abcdef0123', root: '/work/repo',
  commonDir: '/work/repo/.git', evidence: 'git-directory', observedAt: 1700000000000 };
function catalog(paths) {
  return { items: paths.map((project, index) => ({
    canonicalId: `skill::skill-${index}`, kind: 'skill', name: `skill-${index}`, capabilityName: `skill-${index}`,
    presence: [{ host: 'claude', scope: 'project', project, artifactId: `artifact-${index}`,
      consumer: { mechanism: 'claude-project-skill', enabled: true, configScope: 'project' } }],
  })) };
}
function build(projects, paths) {
  return buildManagementInventory({ ...options, footprint: { projects, catalog: catalog(paths) } }).inventory;
}
test('should_enrich_existing_fallback_identities_without_changing_installation_totals', () => {
  const paths = ['/work/repo', '/work/checkout', '/work/unknown'];
  const before = build({ projects: [] }, paths);
  const after = build({ projects: [], discoveryProjects: [
    { path: paths[0], repository, sessionOrigins: [{ origin: 'claude-desktop', sessions: 2 }, { origin: 'codex-desktop', sessions: 3 }] },
    { path: paths[1], repository: { ...repository, kind: 'worktree', evidence: 'git-common-directory-and-backlink' }, sessionOrigins: [{ origin: 'unknown', sessions: 1 }] },
  ] }, paths);
  assert.deepEqual(after.placements.map((row) => row.placementId), before.placements.map((row) => row.placementId));
  const page = publicInventoryPage(runInventoryQuery(after, { scope: 'project', presentation: 'focus', includeWorktrees: true }));
  assert.equal(page.total, 3);
  assert.equal(page.navigation.nodes.length, 3);
  const grouped = page.navigation.nodes.filter((node) => node.repositoryId);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].repositoryId, grouped[1].repositoryId);
  assert.equal(grouped[0].repositoryLabel, 'repo');
  assert.equal(grouped[0].repositoryObservedAt, 1700000000000);
  assert.equal(JSON.stringify(page).includes('/work/'), false);
});
test('should_never_associate_independent_clones_only_because_remotes_match', () => {
  const projects = ['/clone/one', '/clone/two'].map((path) => ({ path, label: 'clone', hosts: ['claude'],
    remote: { status: 'linked', webUrl: 'https://github.com/example/repo' } }));
  const inventory = build({ projects }, projects.map((row) => row.path));
  assert.ok(inventory.placements.every((row) => !row.repositoryId));
});
test('should_filter_origin_memberships_as_overlapping_facets_without_duplicate_placements', () => {
  const paths = ['/one', '/two'];
  const inventory = build({ projects: [], discoveryProjects: [{ path: paths[0], repository,
    sessionOrigins: [{ origin: 'claude-desktop', sessions: 2 }, { origin: 'codex-desktop', sessions: 3 }] }] }, paths);
  const query = validateMaintenanceV2Query('inventory', new URLSearchParams('scope=project&presentation=focus&facet.sessionOrigin=claude-desktop'));
  const claude = publicInventoryPage(runInventoryQuery(inventory, query));
  assert.equal(claude.total, 1);
  assert.deepEqual(claude.navigation.nodes[0].sessionOrigins,
    [{ origin: 'claude-desktop', sessions: 2 }, { origin: 'codex-desktop', sessions: 3 }]);
  const either = runInventoryQuery(inventory, { scope: 'project', facets: { sessionOrigin: ['claude-desktop', 'codex-desktop'] } });
  assert.equal(either.total, 1);
  assert.equal(runInventoryQuery(inventory, { scope: 'project', facets: { sessionOrigin: ['unknown'] } }).total, 1);
});
test('should_report_session_counts_once_per_project_despite_multiple_installed_resources', () => {
  const inventory = build({ projects: [], discoveryProjects: [{ path: '/project', repository,
    sessionOrigins: [{ origin: 'codex-desktop', sessions: 7 }] }] }, ['/project', '/project']);
  const page = publicInventoryPage(runInventoryQuery(inventory, { scope: 'project', presentation: 'focus' }));
  assert.equal(page.navigation.nodes[0].count, 2);
  assert.equal(page.navigation.nodes[0].sessionOrigins[0].sessions, 7);
});
