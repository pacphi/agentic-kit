import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildUsageProjectGroups } from '../../src/lib/usage-project-groups.mjs';
import { observeUsageProject } from '../../src/lib/usage-project-evidence.mjs';
import { parseClaude, parseCodex, blankSession, addUsage } from '../../src/lib/usage-parsers.mjs';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';

const repositoryId = 'repository:0123456789abcdef0123';
function session(id, cost, evidence, origin = 'unknown') {
  return { id, host: origin === 'codex-desktop' ? 'codex' : 'claude', project: 'same-name', cost, minutes: 2, tokens: 100,
    projectEvidence: evidence, sessionOrigin: { origin } };
}
test('should_group_verified_worktrees_and_preserve_independent_desktop_memberships_without_double_counting', () => {
  const input = [session('a', 2, { key: 'path:a', label: 'main', repositoryId, repositoryLabel: 'Repo', kind: 'git' }, 'claude-desktop'),
    session('b', 3, { key: 'path:b', label: 'feature', repositoryId, repositoryLabel: 'Repo', kind: 'worktree' }, 'codex-desktop'),
    session('c', 5, { key: 'path:c', label: 'same-name', kind: 'folder' })];
  const groups = buildUsageProjectGroups(input);
  assert.equal(groups.length, 2);
  assert.equal(groups.reduce((sum, group) => sum + group.cost, 0), 10);
  assert.equal(groups.reduce((sum, group) => sum + group.sessions, 0), 3);
  const repo = groups.find((group) => group.key === repositoryId);
  assert.equal(repo.members.length, 2);
  assert.deepEqual(repo.origins, ['claude-desktop', 'codex-desktop']);
  assert.equal(repo.members.reduce((sum, member) => sum + member.tokens, 0), repo.tokens);
});
test('should_preserve_existing_totals_and_byProject_while_grouping_only_the_filtered_window', () => {
  const now = Date.parse('2026-09-09T00:00:00Z'), day = 86400000;
  const make = (id, age) => {
    const rec = blankSession(id, 'claude');
    Object.assign(rec, { project: 'legacy-label', responses: 1, start: now - age - 60000, end: now - age });
    addUsage(rec, '2026-09-08', 'model', { input: 100, output: 20, responses: 1 });
    return rec;
  };
  const records = [make('current', day), make('old', 30 * day)];
  const opts = { days: 7, now, cutoff: now - 7 * day, deps: { pricesAsOf: null, costOf: () => 2,
    classify: () => ({ category: 'Build', confidence: 1 }), detectInsights: () => [] } };
  const before = aggregate(records, opts);
  records[0].projectEvidence = { key: 'working:a', label: 'repo', repositoryId, repositoryLabel: 'Repository', kind: 'git' };
  const after = aggregate(records, opts);
  assert.deepEqual(after.totals, before.totals);
  assert.deepEqual(after.byProject, before.byProject);
  assert.equal(after.projectGroups[0].sessions, 1);
  assert.equal(after.projectGroups[0].cost, after.totals.cost);
  assert.deepEqual(after.projectGroups[0].members[0].sessionRefs.map((ref) => ref.id), ['current']);
  after.sessions[0].projectEvidence.label = 'changed';
  assert.equal(records[0].projectEvidence.label, 'repo');
});
test('should_render_top_eight_groups_show_all_and_escape_session_link_identity', () => {
  const elements = { 'u-projects': {}, 'u-projects-note': {} };
  const source = fs.readFileSync(new URL('../../src/lib/dashboard/client/usage.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/\bexport /g, '');
  const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const context = vm.createContext({ window: {}, document: { getElementById: (id) => elements[id] }, esc, formatLocalDateTime: () => null });
  vm.runInContext(`${source}\nglobalThis.renderProjects=renderScoreProjects;`, context);
  const groups = buildUsageProjectGroups(Array.from({ length: 10 }, (_, i) => session(`id-${i}"><img>`, i + 1,
    { key: `working:${i}`, label: `Repo ${i}`, kind: 'folder' }, 'claude-desktop')));
  context.renderProjects({ projectGroups: groups });
  assert.match(elements['u-projects-note'].textContent, /top 8 of 10 groups/);
  assert.match(elements['u-projects'].innerHTML, /Show all 10 groups/);
  assert.equal((elements['u-projects'].innerHTML.match(/data-project-group=/g) || []).length, 10);
  assert.ok(elements['u-projects'].innerHTML.includes('Claude Desktop'));
  assert.ok(!elements['u-projects'].innerHTML.includes('<img>'));
});
test('should_keep_same_named_paths_separate_and_retain_every_legacy_session_in_unclassified_group', () => {
  const groups = buildUsageProjectGroups([session('one', 1, { key: 'path:a', label: 'same', kind: 'folder' }),
    session('two', 2, { key: 'path:b', label: 'same', kind: 'folder' }), session('legacy-a', 3), session('legacy-b', 4)]);
  assert.equal(groups.length, 3);
  assert.equal(groups.find((group) => group.kind === 'unknown').sessions, 2);
  assert.equal(groups.reduce((sum, group) => sum + group.cost, 0), 10);
});
test('should_aggregate_only_supplied_window_sessions_without_mutating_them', () => {
  const input = [session('current', 5, { key: 'path:a', label: 'repo', kind: 'folder' })];
  const before = structuredClone(input);
  assert.equal(buildUsageProjectGroups(input)[0].sessions, 1);
  assert.deepEqual(input, before);
  assert.deepEqual(buildUsageProjectGroups([]), []);
});
test('should_record_opaque_current_filesystem_evidence_and_explicit_origin_without_exposing_cwd', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-usage-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  const evidence = observeUsageProject(root, { observedAt: 17, cache: new Map() });
  assert.equal(evidence.kind, 'git');
  assert.equal(evidence.observedAt, 17);
  assert.equal(JSON.stringify(evidence).includes(root), false);
  const claude = parseClaude(JSON.stringify({ type: 'user', cwd: root, entrypoint: 'claude-desktop', timestamp: '2026-09-09T00:00:00Z' }), { id: 'a' }).session;
  const codex = parseCodex(JSON.stringify({ type: 'session_meta', payload: { id: 'b', cwd: root, originator: 'Codex Desktop' } }), { id: 'b' }).session;
  assert.equal(claude.sessionOrigin.origin, 'claude-desktop');
  assert.equal(codex.sessionOrigin.origin, 'codex-desktop');
  assert.equal(claude.projectEvidence.repositoryId, codex.projectEvidence.repositoryId);
});
