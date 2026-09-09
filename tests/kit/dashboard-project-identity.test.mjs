import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectProjectIdentity } from '../../src/lib/footprint/project-identity.mjs';
import { transcriptSessionOrigin } from '../../src/lib/footprint/session-origin.mjs';
import { discoverProjectSources, scanTranscriptCwds } from '../../src/lib/footprint/project-sources.mjs';
import { collectProjects } from '../../src/lib/footprint/projects.mjs';

// Native realpath expands Windows 8.3 temp paths (RUNNER~1), matching the
// collector's canonical identity. The JavaScript variant may retain them.
const realpath = (file) => (fs.realpathSync.native ?? fs.realpathSync)(file);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-dashboard-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function worktree(root, { bare = false } = {}) {
  const main = path.join(root, bare ? 'bare.git' : 'main');
  const common = bare ? main : path.join(main, '.git');
  const linked = path.join(root, 'unrelated-name');
  const metadata = path.join(common, 'worktrees', 'checkout');
  fs.mkdirSync(metadata, { recursive: true });
  fs.mkdirSync(path.join(linked, 'src'), { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${metadata}\n`);
  fs.writeFileSync(path.join(metadata, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(metadata, 'gitdir'), `${path.join(linked, '.git')}\n`);
  return { main, common, linked, metadata };
}
function lines(...records) { return records.map((record) => JSON.stringify(record)); }

test('should_group_nested_worktree_paths_by_verified_common_directory', (t) => {
  const { main, linked, common } = worktree(fixture(t));
  const primary = inspectProjectIdentity(main, { observedAt: 17 });
  const nested = inspectProjectIdentity(path.join(linked, 'src'), { observedAt: 17 });
  assert.deepEqual({ kind: nested.kind, id: nested.repositoryId, root: nested.root,
    checkout: nested.worktreeRoot, common: nested.commonDir, observedAt: nested.observedAt },
  { kind: 'worktree', id: primary.repositoryId, root: realpath(main),
    checkout: realpath(linked), common: realpath(common), observedAt: 17 });
});
test('should_group_bare_worktrees_without_inventing_a_main_checkout', (t) => {
  const { linked, common } = worktree(fixture(t), { bare: true });
  const identity = inspectProjectIdentity(linked);
  assert.deepEqual({ kind: identity.kind, root: identity.root, common: identity.commonDir },
    { kind: 'worktree', root: null, common: realpath(common) });
});
test('should_keep_submodule_git_directories_distinct_from_parent_repository', (t) => {
  const root = fixture(t), main = path.join(root, 'main'), sub = path.join(main, 'sub');
  fs.mkdirSync(path.join(main, '.git', 'modules', 'sub'), { recursive: true });
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
  const identity = inspectProjectIdentity(sub);
  assert.equal(identity.kind, 'git');
  assert.notEqual(identity.repositoryId, inspectProjectIdentity(main).repositoryId);
});
test('should_reject_worktree_association_when_backlink_is_mismatched', (t) => {
  const { linked, metadata, main } = worktree(fixture(t));
  fs.writeFileSync(path.join(metadata, 'gitdir'), path.join(main, '.git'));
  const identity = inspectProjectIdentity(linked);
  assert.deepEqual([identity.kind, identity.repositoryId], ['unknown', null]);
});
test('should_preserve_unknown_for_missing_named_worktrees_and_unreadable_markers', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.git'));
  const missing = inspectProjectIdentity(path.join(root, '.worktrees', 'missing'));
  assert.equal(missing.repositoryId, null);
  const denied = Object.assign(Object.create(fs), {
    lstatSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  assert.equal(inspectProjectIdentity(root, { fsImpl: denied }).kind, 'unknown');
});
test('should_canonicalize_symlink_aliases_without_merging_same_named_repositories', (t) => {
  const root = fixture(t), first = path.join(root, 'a', 'same'), second = path.join(root, 'b', 'same');
  fs.mkdirSync(path.join(first, '.git'), { recursive: true });
  fs.mkdirSync(path.join(second, '.git'), { recursive: true });
  fs.symlinkSync(first, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(inspectProjectIdentity(first).repositoryId, inspectProjectIdentity(path.join(root, 'alias')).repositoryId);
  assert.notEqual(inspectProjectIdentity(first).repositoryId, inspectProjectIdentity(second).repositoryId);
});
test('should_attribute_only_explicit_desktop_metadata_and_ignore_names_and_ambiguous_sources', () => {
  for (const entrypoint of ['claude-desktop', 'claude-desktop-3p', 'remote_desktop']) {
    assert.equal(transcriptSessionOrigin(lines({ entrypoint }), 'claude').origin, 'claude-desktop');
  }
  for (const originator of ['Codex Desktop', 'codex_work_desktop']) {
    assert.equal(transcriptSessionOrigin(lines({ type: 'session_meta', payload: { originator } }), 'codex').origin, 'codex-desktop');
  }
  for (const entrypoint of ['sdk-cli', 'sdk-py', 'cli', 'local-agent', 'desktop-like']) {
    assert.equal(transcriptSessionOrigin(lines({ entrypoint, cwd: '/Claude Desktop/project' }), 'claude').origin, 'unknown');
  }
  assert.equal(transcriptSessionOrigin(lines({ type: 'session_meta', payload: { source: 'vscode' } }), 'codex').origin, 'unknown');
});
test('should_latch_first_declared_origin_and_not_promote_later_resumed_metadata', () => {
  assert.equal(transcriptSessionOrigin(lines(
    { type: 'session_meta', payload: { originator: 'codex-tui' } },
    { type: 'session_meta', payload: { originator: 'Codex Desktop' } },
  ), 'codex').origin, 'unknown');
});
test('should_read_origin_from_the_same_bounded_head_without_searching_later_records', (t) => {
  const root = fixture(t), file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, lines(
    { type: 'session_meta', payload: { cwd: root, originator: 'Codex Desktop' } },
    { type: 'session_meta', payload: { cwd: '/other', originator: 'codex-tui' } },
  ).join('\n'));
  const scan = scanTranscriptCwds(root, 'codex', { maxLines: 1 });
  assert.deepEqual(scan.sightings.map(({ cwd, sessionOrigin }) => [cwd, sessionOrigin.origin]), [[root, 'codex-desktop']]);
  fs.writeFileSync(file, lines(
    { type: 'turn_context', payload: { cwd: root } },
    { type: 'session_meta', payload: { cwd: root, originator: 'Codex Desktop' } },
  ).join('\n'));
  assert.equal(scanTranscriptCwds(root, 'codex', { maxLines: 1 }).sightings[0].sessionOrigin.origin, 'unknown');
});
test('should_preserve_path_totals_while_partitioning_overlapping_host_origins', (t) => {
  const root = fixture(t), { main, linked } = worktree(root);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(main, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const records = {
    claude: [
      { cwd: main, origin: 'cwd', sessionOrigin: { origin: 'claude-desktop', evidence: 'entrypoint:claude-desktop' } },
      { cwd: linked, origin: 'cwd' },
    ],
    codex: [{ cwd: alias, origin: 'cwd', sessionOrigin: { origin: 'codex-desktop', evidence: 'session_meta.originator:Codex Desktop' } }],
  };
  const result = discoverProjectSources({
    scanTranscripts: (_root, host) => ({ sightings: records[host], complete: true }),
    scanOpencode: () => ({ sightings: [{ cwd: main, weight: 4 }], complete: true }),
  });
  const primary = result.projects.find((row) => row.path === realpath(main));
  assert.equal(result.everSeen, 2);
  assert.equal(primary.sessions, 6);
  assert.deepEqual(primary.sessionOrigins.map(({ origin, sessions }) => [origin, sessions]),
    [['claude-desktop', 1], ['codex-desktop', 1], ['unknown', 4]]);
  assert.equal(primary.repository.repositoryId, result.projects.find((row) => row !== primary).repository.repositoryId);
  assert.equal(result.projects.reduce((sum, row) => sum + row.sessions, 0),
    result.projects.flatMap((row) => row.sessionOrigins).reduce((sum, origin) => sum + origin.sessions, 0));
});
test('should_expose_missing_and_unmeasured_catalog_without_changing_measurement_population', (t) => {
  const root = fixture(t), missing = path.join(root, 'gone');
  const catalog = [{ path: root, label: 'folder', exists: true, hosts: ['claude'] },
    { path: missing, label: 'gone', exists: false, hosts: ['codex'] }];
  const result = collectProjects({ sources: { projects: catalog, everSeen: 2, onDisk: 1, gitRepos: 0, complete: true } });
  assert.deepEqual(result.discoveryProjects, catalog);
  assert.deepEqual([result.everSeen.value, result.onDisk.value, result.projects.length, result.population.excluded.total], [2, 1, 0, 1]);
});
test('should_qualify_encoded_directory_recovery_as_a_sighting_instead_of_a_verified_session', (t) => {
  const root = fixture(t);
  const result = discoverProjectSources({ scanTranscripts: (_root, host) => ({
    complete: true, sightings: host === 'claude' ? [{ cwd: root, origin: 'encoded-dir' }] : [],
  }), scanOpencode: () => ({ complete: true, sightings: [] }) });
  assert.deepEqual({ sessions: result.projects[0].sessions, origin: result.projects[0].sessionOrigins[0].origin,
    countBasis: result.projects[0].sessionOrigins[0].countBasis },
  { sessions: 1, origin: 'unknown', countBasis: 'recovered-project-sighting' });
});
