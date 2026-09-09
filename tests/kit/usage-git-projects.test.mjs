import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildUsageGitProjects } from '../../src/lib/usage-project-groups.mjs';
import { observeUsageProject } from '../../src/lib/usage-project-evidence.mjs';
import { aggregate } from '../../src/lib/usage-aggregate.mjs';
import { blankSession, addUsage } from '../../src/lib/usage-parsers.mjs';

const id = (n) => `repository:${n.toString(16).padStart(20, '0')}`;
function record(n, cost, extra = {}) {
  return { id: `session-${n}`, cost, minutes: 2, tokens: 100, project: `legacy-${n}`,
    projectEvidence: { repositoryId: id(n), repositoryLabel: `Repo ${n}`, kind: 'git',
      parentRootExists: true, userLevel: false, evidence: 'git-directory', ...extra } };
}
test('should_rank_twelve_verified_git_projects_without_truncating_backend_candidates', () => {
  const rows = buildUsageGitProjects(Array.from({ length: 12 }, (_, i) => record(i, i + 1)));
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.map((row) => row.cost), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['key', 'label', 'cost', 'sessions', 'minutes', 'tokens'].sort());
});
test('should_fold_verified_worktree_usage_into_its_real_parent_once', () => {
  const sessions = [record(1, 3), record(1, 5, { kind: 'worktree', evidence: 'git-common-directory-and-backlink' })];
  const before = structuredClone(sessions);
  assert.deepEqual(buildUsageGitProjects(sessions), [{ key: id(1), label: 'Repo 1', cost: 8, sessions: 2, minutes: 4, tokens: 200 }]);
  assert.deepEqual(sessions, before);
});
test('should_exclude_missing_unknown_user_and_parentless_worktree_evidence_without_name_heuristics', () => {
  const sessions = [record(1, 1, { parentRootExists: false }), record(2, 2, { userLevel: true }),
    record(3, 3, { kind: 'worktree', parentRootExists: false }), record(4, 4, { parentRootExists: undefined }),
    record(5, 5, { kind: 'unknown' }), { id: 'legacy', cost: 6, project: 'real-looking-repo' },
    record(6, 7, { repositoryLabel: 'agent-real-repository' })];
  assert.deepEqual(buildUsageGitProjects(sessions).map((row) => row.label), ['agent-real-repository']);
});
test('should_observe_a_real_parent_root_and_exclude_only_exact_canonical_user_roots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-usage-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, 'parent'), tree = path.join(root, 'agent-123'), user = path.join(root, 'user');
  for (const dir of [parent, user]) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  }
  const target = path.join(parent, '.git', 'worktrees', 'agent-123');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${target}\n`);
  fs.writeFileSync(path.join(target, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(target, 'gitdir'), path.join(tree, '.git'));
  const alias = path.join(root, 'user-alias');
  fs.symlinkSync(user, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const options = { observedAt: 17, cache: new Map(), userRoots: [alias] };
  const main = observeUsageProject(parent, options), linked = observeUsageProject(tree, options);
  assert.equal(main.parentRootExists, true);
  assert.equal(linked.parentRootExists, true);
  assert.equal(main.repositoryId, linked.repositoryId);
  assert.equal(main.userLevel, false);
  assert.equal(observeUsageProject(user, options).userLevel, true);
  fs.mkdirSync(path.join(root, 'incomplete', '.git'), { recursive: true });
  assert.equal(observeUsageProject(path.join(root, 'incomplete'), options).parentRootExists, false);
});
test('should_limit_git_ranking_to_active_window_sessions_while_preserving_overall_non_git_usage', () => {
  const now = Date.parse('2026-09-09T00:00:00Z'), day = 86400000;
  const make = (name, age, evidence) => {
    const rec = blankSession(name, 'claude');
    Object.assign(rec, { project: name, responses: 1, start: now - age - 60000, end: now - age, projectEvidence: evidence });
    addUsage(rec, '2026-09-08', 'model', { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, responses: 1 });
    return rec;
  };
  const evidence = record(1, 1).projectEvidence;
  const projection = aggregate([make('current-git', day, evidence), make('older-git', 30 * day, evidence), make('current-folder', day, null)],
    { days: 7, now, cutoff: now - 7 * day, deps: { pricesAsOf: null, costOf: () => 2,
      classify: () => ({ category: 'Build', confidence: 1 }), detectInsights: () => [] } });
  assert.equal(projection.totals.cost, 4);
  assert.equal(projection.totals.sessions, 2);
  assert.deepEqual(projection.gitProjects, [{ key: id(1), label: 'Repo 1', cost: 2, sessions: 1, minutes: 1, tokens: 120 }]);
  assert.equal(projection.byProject['current-folder'].cost, 2);
});
