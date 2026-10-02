// #309 (prerequisite C): a hook's Maintenance scope comes from where its host reads it. These tests run
// the real, read-only hook audit over a fixture home and a fixture repository, hand its output to the
// hook-evidence module, and project the result into the inventory, so the scope, the repository and the
// "no path leaves the server" guarantee are proved from real records, not from hand-built read models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { auditHooks } from '../../src/lib/hook-audit/orchestrator.mjs';
import { UPSTREAM_REGISTRY_FILE } from '../../src/lib/hook-audit/upstream.mjs';
import { buildHookDashboardReadModel } from '../../src/lib/hook-read-model.mjs';
import { buildHookPlacementContext, collectHookEvidence } from '../../src/lib/maintenance/management/hook-evidence.mjs';
import { hookProjectRoots, hookScopeForKind, isProjectHookKind } from '../../src/lib/maintenance/management/hook-scope.mjs';
import { buildManagementInventory } from '../../src/lib/maintenance/management/projection.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

const KEY = 'test-installation-key-0123456789abcdef';
const NOW = () => Date.parse('2026-10-02T12:00:00.000Z');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

const stopHook = (command) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: 3000 }] }] } });

/** A user's Claude home, an administrator's managed settings, and one repository carrying a Claude, a
 *  Codex and an OpenCode hook source. */
function fixture(t) {
  const root = tempDir('ak-hook-scope', t);
  const project = path.join(root, 'work', 'app');
  const claude = path.join(root, 'claude');
  const managed = path.join(root, 'etc', 'managed-settings.json');
  const codex = path.join(root, 'codex');
  const opencode = path.join(root, 'opencode');
  write(path.join(claude, 'settings.json'), stopHook('node user-stop.cjs'));
  write(managed, stopHook('node managed-stop.cjs'));
  write(path.join(project, '.claude', 'settings.json'), stopHook('node project-stop.cjs'));
  write(path.join(project, '.codex', 'hooks.json'), stopHook('node codex-project-stop.cjs'));
  write(path.join(project, 'opencode.json'), { plugin: ['project-plugin@1.0.0'] });
  write(path.join(opencode, 'opencode.json'), { plugin: ['user-plugin@1.0.0'] });
  return { root, project, claude, managed, codex, opencode };
}

const auditOf = (fx) => auditHooks({
  hosts: ['claude', 'codex', 'opencode'], projectRoots: [fx.project],
  versions: { codex: '0.151.0', claude: '2.1.258', opencode: '1.18.25' },
  codex: { codexHome: fx.codex, pluginCacheDir: path.join(fx.codex, 'plugins', 'cache') },
  claude: { claudeRoot: fx.claude, managedSettingsFile: fx.managed },
  opencode: { opencodeRoot: fx.opencode },
  // The registry's own last state re-read, so re-checking it never breaks this test.
  upstream: { now: () => new Date(`${JSON.parse(fs.readFileSync(UPSTREAM_REGISTRY_FILE, 'utf8')).lastCheckedAt}T12:00:00Z`) },
});

const recordsOf = (audit) => Object.values(audit.reports).flatMap((report) => /** @type {any} */ (report).records);

// ── hook-scope.mjs ────────────────────────────────────────────────────────

test('hookScopeForKind maps every source kind the audit emits, and anything unknown to user scope', () => {
  const expected = {
    global: 'user', 'global-inline': 'user', 'global-plugin': 'user',
    'plugin-cache': 'user', 'plugin-cache-inline': 'user', 'external-adapter-manifest': 'user',
    managed: 'system',
    project: 'project', 'project-inline': 'project', 'project-plugin': 'project',
  };
  for (const [kind, scope] of Object.entries(expected)) assert.equal(hookScopeForKind(kind), scope, kind);
  for (const kind of [undefined, null, '', 'something-new', 42]) assert.equal(hookScopeForKind(kind), 'user', String(kind));
  assert.deepEqual(Object.keys(expected).filter(isProjectHookKind), ['project', 'project-inline', 'project-plugin']);
});

test('hookProjectRoots lists the distinct roots the context knows for project-kind placements only', () => {
  const model = {
    definitionGroups: [{ placements: [
      { occurrenceId: 'a', source: { kind: 'project' } }, { occurrenceId: 'b', source: { kind: 'project-inline' } },
      { occurrenceId: 'c', source: { kind: 'project' } }, { occurrenceId: 'd', source: { kind: 'global' } },
      { occurrenceId: 'e', source: { kind: 'project' } },
    ] }],
  };
  const context = (id) => ({ a: { projectRoot: '/work/one' }, b: { projectRoot: '/work/one' }, c: { projectRoot: '/work/two' },
    d: { projectRoot: '/work/never-listed' } }[id] ?? null);
  assert.deepEqual(hookProjectRoots(model, context).sort(), ['/work/one', '/work/two']);
  assert.deepEqual(hookProjectRoots(model, null), []);
  assert.deepEqual(hookProjectRoots(null, context), []);
});

// ── hook-evidence.mjs, over the real audit ───────────────────────────────

test('the placement context knows the repository of each project-kind record, and only those', (t) => {
  const fx = fixture(t);
  const audit = auditOf(fx);
  const records = recordsOf(audit);
  const context = buildHookPlacementContext(audit);
  const byKind = (kind) => records.filter((record) => record.source.sourceKind === kind);
  assert.ok(byKind('project').length >= 2, 'a Claude and a Codex project hook were audited');
  assert.ok(byKind('managed').length === 1 && byKind('global').length >= 1);
  for (const record of records) {
    const known = context(record.occurrenceId);
    if (isProjectHookKind(record.source.sourceKind)) assert.deepEqual(known, { projectRoot: fx.project }, record.source.sourceKind);
    else assert.equal(known, null, `${record.source.sourceKind} has no repository`);
  }
  assert.equal(context('not-an-occurrence'), null);
  assert.equal(buildHookPlacementContext(null)('x'), null);
});

test('a record whose project root is missing or not absolute gets no context, so it cannot be filed in a repository', () => {
  const audit = { reports: { claude: { records: [
    { occurrenceId: 'ok', source: { sourceKind: 'project', baseDir: '/work/app' } },
    { occurrenceId: 'relative', source: { sourceKind: 'project', baseDir: 'work/app' } },
    { occurrenceId: 'none', source: { sourceKind: 'project' } },
    { occurrenceId: 'codex', scope: { projectPath: '/work/codex' }, source: { sourceKind: 'project-inline', baseDir: '/elsewhere' } },
  ] } } };
  const context = buildHookPlacementContext(audit);
  assert.deepEqual(context('ok'), { projectRoot: '/work/app' });
  assert.equal(context('relative'), null);
  assert.equal(context('none'), null);
  assert.deepEqual(context('codex'), { projectRoot: '/work/codex' }, 'a Codex record names its project path first');
});

test('collectHookEvidence runs the audit once and returns a path-free read model beside the private context', async (t) => {
  const fx = fixture(t);
  let runs = 0;
  const evidence = await collectHookEvidence({ audit: () => { runs++; return auditOf(fx); } });
  assert.equal(runs, 1);
  assert.equal(evidence.hookReadModel.schemaVersion, 3);
  assert.equal(typeof evidence.hookPlacementContext, 'function');
  const serialized = JSON.stringify(evidence.hookReadModel);
  for (const secret of [fx.root, fx.project, fx.claude, fx.managed]) assert.ok(!serialized.includes(secret), `the read model leaks ${secret}`);
});

// ── projection, over the real audit ──────────────────────────────────────

test('the inventory files each real hook where its host reads it: system, user, and inside its repository', async (t) => {
  const fx = fixture(t);
  const audit = auditOf(fx);
  const { hookReadModel, hookPlacementContext } = await collectHookEvidence({ audit: () => audit });
  const { inventory } = buildManagementInventory({
    footprint: {}, hookReadModel, hookPlacementContext, installationKey: KEY, now: NOW, environment: { platform: 'darwin' },
  });

  const records = recordsOf(audit);
  const expectedByKind = (kind) => records.filter((record) => record.source.sourceKind === kind).length;
  const placementsIn = (scope) => inventory.placements.filter((p) => p.kind === 'hook' && p.administrativeScope === scope);
  assert.equal(placementsIn('system').length, expectedByKind('managed'), 'the administrator-managed hook is system scope');
  const project = placementsIn('project');
  assert.equal(project.length, expectedByKind('project') + expectedByKind('project-inline') + expectedByKind('project-plugin'));
  assert.ok(project.length >= 3, 'the Claude, Codex and OpenCode project sources all produced a placement');
  assert.equal(placementsIn('user').length, records.length - project.length - placementsIn('system').length);
  assert.ok(placementsIn('user').length >= 2, 'the user\'s own Claude and OpenCode sources stay user scope');

  // Every project hook names the one repository, and sits under it beside its host's Hooks.
  assert.equal(new Set(project.map((p) => p.projectId)).size, 1);
  assert.ok(project.every((p) => p.projectId && p.locationBreadcrumb.at(-1) === 'Hooks'));
  assert.ok(project.every((p) => p.locationBreadcrumb.length > 2), 'the repository is part of the breadcrumb');
  assert.ok(inventory.placements.filter((p) => p.kind === 'hook').every((p) => !p.conditions.includes('project-root-unavailable')));

  // No local path reaches the inventory, which is what the browser receives.
  const serialized = JSON.stringify(inventory);
  for (const secret of [fx.root, fx.project, fx.claude, fx.managed, path.basename(fx.root)]) {
    assert.ok(!serialized.includes(secret), `the inventory leaks ${secret}`);
  }
});

test('the same audit without a context is the old behaviour plus a visible condition: every hook user scope', async (t) => {
  const fx = fixture(t);
  const hookReadModel = buildHookDashboardReadModel({ audit: auditOf(fx), receipts: [], healingPlan: null });
  const { inventory } = buildManagementInventory({
    footprint: {}, hookReadModel, installationKey: KEY, now: NOW, environment: { platform: 'darwin' },
  });
  const hooks = inventory.placements.filter((p) => p.kind === 'hook');
  assert.ok(hooks.length > 0);
  // The managed hook is still system: its scope needs no repository.
  assert.deepEqual([...new Set(hooks.map((p) => p.administrativeScope))].sort(), ['system', 'user']);
  assert.ok(hooks.filter((p) => p.administrativeScope === 'user' && p.conditions.includes('project-root-unavailable')).length >= 3);
});
