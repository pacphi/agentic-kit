import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { projectCensus, projectsInScope } from '../../src/lib/project-census.mjs';

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function picker() {
  const elements = { 'intel-project-select': {}, 'history-project-name': {} };
  const source = fs.readFileSync(new URL('../../src/lib/dashboard/client/intelligence.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({ document: { getElementById: (id) => elements[id] }, esc,
    intelProjects: [], selectedProjectKey: null, selectedProjectLabel: null });
  vm.runInContext(`${source}\nglobalThis.renderPicker=renderProjectPicker;`, context);
  return { elements, render: context.renderPicker, context };
}

test('should_segment_and_alphabetize_picker_options_without_changing_selection_keys', () => {
  const { elements, render } = picker();
  render({ selectedProjectKey: 'z', selectedProjectLabel: 'Zulu', projects: [
    { key: 'z', label: 'Zulu', learningScope: 'repository', learningOrigins: ['codex-desktop'] },
    { key: 'a', label: 'alpha', learningScope: 'repository', learningOrigins: ['claude-desktop'] },
    { key: 'u', label: 'Settings', learningScope: 'user' },
    { key: 'w', label: 'Feature', learningScope: 'worktree' },
    { key: 'x', label: 'uuid-looking-123', learningScope: 'unknown' },
  ] });
  const html = elements['intel-project-select'].innerHTML;
  for (const label of ['Git repositories', 'Git worktrees', 'User-level learning', 'Other / unclassified']) {
    assert.ok(html.includes(`<optgroup label="${label}">`));
  }
  assert.ok(html.indexOf('value="a"') < html.indexOf('value="z"'));
  assert.match(html, /value="z" selected>Zulu</);
  assert.doesNotMatch(html, /Claude Desktop|Codex Desktop/);
  assert.equal(elements['history-project-name'].textContent, 'Zulu');
});
test('should_keep_empty_picker_disabled_and_escape_untrusted_option_labels', () => {
  const { elements, render } = picker();
  render({ projects: [], selectedProjectKey: null });
  assert.equal(elements['intel-project-select'].disabled, true);
  render({ projects: [{ key: 'x', label: '<img onerror=x>', learningScope: 'unknown' }], selectedProjectKey: 'x' });
  assert.equal(elements['intel-project-select'].disabled, false);
  assert.ok(!elements['intel-project-select'].innerHTML.includes('<img'));
});
test('should_classify_only_exact_canonical_user_roots_and_keep_declared_desktop_membership', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-intel-groups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const user = path.join(root, 'user'), nested = path.join(user, 'child'), repo = path.join(root, 'repo');
  for (const dir of [user, nested, repo]) fs.mkdirSync(path.join(dir, '.claude-flow'), { recursive: true });
  const alias = path.join(root, 'user-alias');
  fs.symlinkSync(user, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const projects = [user, nested, repo].map((dir) => ({ path: dir, label: path.basename(dir), exists: true,
    repository: dir === repo ? { kind: 'git', evidence: 'git-directory' } : { kind: 'folder', evidence: 'no-git-boundary' },
    sessionOrigins: dir === repo ? [{ origin: 'claude-desktop', sessions: 1 }, { origin: 'codex-desktop', sessions: 1 }] : [],
  }));
  const census = projectCensus({ userRoots: [alias], discover: () => ({ projects, asOf: 17 }) });
  assert.deepEqual(census.projects.map((entry) => entry.learningScope), ['user', 'unknown', 'repository']);
  assert.deepEqual(census.projects[2].learningOrigins, ['claude-desktop', 'codex-desktop']);
  assert.equal(projectsInScope(census, 'learning').length, 3);
});
test('should_preserve_merged_learning_anchor_and_origin_memberships_from_each_working_path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-intel-anchor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'src');
  fs.mkdirSync(path.join(root, '.git'));
  for (const dir of [root, nested]) fs.mkdirSync(path.join(dir, '.claude-flow'), { recursive: true });
  const repository = { kind: 'git', evidence: 'git-directory' };
  const census = projectCensus({ userRoots: [], discover: () => ({ asOf: 17, projects: [
    { path: nested, label: 'src', exists: true, repository, sessions: 1,
      sessionOrigins: [{ origin: 'claude-desktop', sessions: 1 }] },
    { path: root, label: 'repo', exists: true, repository, sessions: 1,
      sessionOrigins: [{ origin: 'codex-desktop', sessions: 1 }] },
  ] }) });
  const [merged] = projectsInScope(census, 'learning');
  assert.equal(merged.path, root);
  assert.deepEqual(merged.learningOrigins, ['claude-desktop', 'codex-desktop']);
  assert.equal(merged.sessions, 2);
  assert.equal(census.learning, 1);
});
