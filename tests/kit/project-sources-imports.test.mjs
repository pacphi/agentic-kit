// Imported Codex rollouts (the ChatGPT desktop app's "Import from another
// agent" copies of Claude Code transcripts, turn ids `external-import-turn-N`)
// are not Codex activity: they give a folder no Codex host, no Desktop origin
// and no project, and every scan counts them. ADR-0052 §3, ADR-0060 §3.
// Fixtures live in a temporary folder; nothing reads ~/.codex or ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Rollout } from './helpers/codex-rollout.mjs';
import { CODEX_IMPORT_TURN_PREFIX, isCodexImportedLine, isImportedCodexRollout } from '../../src/lib/codex-import-marker.mjs';
import { scanTranscriptCwds, discoverProjectSources } from '../../src/lib/footprint/project-sources.mjs';
import { collectProjects } from '../../src/lib/footprint/projects.mjs';
import { usageSessionOrigin } from '../../src/lib/usage-project-evidence.mjs';
import { parseCodex } from '../../src/lib/usage-parsers.mjs';

const realpath = (file) => (fs.realpathSync.native ?? fs.realpathSync)(file);

function fixture(t) {
  const root = realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'ak-imported-rollouts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function importedRollout(id, cwd) {
  return new Rollout({ id })
    .meta({ cwd, originator: 'Codex Desktop', source: 'vscode', thread_source: undefined })
    .taskStarted(`${CODEX_IMPORT_TURN_PREFIX}-1`).user('imported prompt').agent('imported answer')
    .lines;
}

function nativeRollout(id, cwd, { originator = 'codex_work_desktop', prompt = 'do the thing' } = {}) {
  return new Rollout({ id }).meta({ cwd, originator }).turn('gpt-5.6', { cwd })
    .taskStarted('t1').user(prompt).agent('done').lines;
}

function writeRollout(dir, name, lines) {
  const file = path.join(dir, '2026', '09', '27', `rollout-${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('the rollout predicate reads only a string payload.turn_id with the import prefix', () => {
  assert.equal(isCodexImportedLine({ payload: { turn_id: 'external-import-turn-3' } }), true);
  assert.equal(isCodexImportedLine({ payload: { turn_id: 't1' } }), false);
  assert.equal(isCodexImportedLine({ payload: { turn_id: 7 } }), false);
  assert.equal(isCodexImportedLine(null), false);
  assert.equal(isImportedCodexRollout(importedRollout('a', '/p')), true);
  assert.equal(isImportedCodexRollout(nativeRollout('b', '/p')), false);
  assert.equal(isImportedCodexRollout(['{not json external-import-turn-1', 42, null]), false);
  assert.equal(isImportedCodexRollout(null), false);
});

test('native rollout that quotes the marker text still counts', () => {
  const lines = nativeRollout('c', '/p', { prompt: 'why is my turn id external-import-turn-1?' });
  assert.equal(isImportedCodexRollout(lines), false);
});

test('an imported rollout contributes no sighting and is counted; a native Desktop one still is', (t) => {
  const root = fixture(t);
  const importedDir = path.join(root, 'imported-project'), nativeDir = path.join(root, 'native-project');
  fs.mkdirSync(importedDir); fs.mkdirSync(nativeDir);
  const sessions = path.join(root, 'sessions');
  writeRollout(sessions, 'imported', importedRollout('imp', importedDir));
  writeRollout(sessions, 'native', nativeRollout('nat', nativeDir));
  const scan = scanTranscriptCwds(sessions, 'codex');
  assert.deepEqual(scan.sightings.map(({ cwd, sessionOrigin }) => [cwd, sessionOrigin.origin]),
    [[nativeDir, 'codex-desktop']]);
  assert.equal(scan.importedExcluded, 1);
  assert.equal(scan.complete, true, 'setting an import aside is not a gap in the census');
});

test('the counts partition every file', (t) => {
  const root = fixture(t), sessions = path.join(root, 'sessions');
  writeRollout(sessions, 'imported', importedRollout('imp', root));
  writeRollout(sessions, 'imported-no-cwd', importedRollout('imp2', undefined));
  writeRollout(sessions, 'native', nativeRollout('nat', root));
  writeRollout(sessions, 'native-no-cwd', new Rollout({ id: 'x' }).raw('event_msg', { type: 'task_started', turn_id: 't1' }).lines);
  fs.writeFileSync(path.join(sessions, 'empty.jsonl'), '');
  const scan = scanTranscriptCwds(sessions, 'codex');
  assert.equal(scan.importedExcluded, 2, 'an import without a cwd is still an import');
  assert.equal(scan.withoutCwd, 1);
  assert.equal(scan.files, scan.withCwd + scan.withoutCwd + scan.empty + scan.unreadable + scan.importedExcluded);
});

test('the Codex marker is never applied to Claude transcripts', (t) => {
  const root = fixture(t), projects = path.join(root, 'projects', '-encoded');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 's.jsonl'), `${JSON.stringify({
    cwd: root, sessionId: 's', entrypoint: 'cli', payload: { turn_id: 'external-import-turn-1' },
  })}\n`);
  const scan = scanTranscriptCwds(path.join(root, 'projects'), 'claude');
  assert.equal(scan.sightings.length, 1);
  assert.equal(scan.importedExcluded, 0);
});

function discover(root, { claudeCwd = null } = {}) {
  const claudeRoot = path.join(root, 'claude-projects');
  fs.mkdirSync(path.join(claudeRoot, '-encoded'), { recursive: true });
  if (claudeCwd) {
    fs.writeFileSync(path.join(claudeRoot, '-encoded', 's.jsonl'),
      `${JSON.stringify({ cwd: claudeCwd, sessionId: 's', entrypoint: 'cli', timestamp: '2026-09-27T00:00:00Z' })}\n`);
  }
  return discoverProjectSources({
    claudeRoot, codexRoot: path.join(root, 'sessions'), opencodeDbFile: path.join(root, 'absent.db'),
    decodeEncodedDirs: false, resolveLabel: (p) => path.basename(p),
  });
}

test('discovery keeps a folder a Claude transcript names, without a Codex host or Desktop origin', (t) => {
  const root = fixture(t), shared = path.join(root, 'shared');
  fs.mkdirSync(shared);
  writeRollout(path.join(root, 'sessions'), 'imported', importedRollout('imp', shared));
  const payload = discover(root, { claudeCwd: shared });
  const row = payload.projects.find((p) => p.path === shared);
  assert.deepEqual(row.hosts, ['claude']);
  assert.deepEqual(row.sessionOrigins.map((o) => o.origin), ['unknown']);
  assert.equal(payload.importedExcluded, 1);
  assert.equal(payload.complete, true);
});

test('an import-only folder is not a project', (t) => {
  const root = fixture(t), only = path.join(root, 'only-imported');
  fs.mkdirSync(only);
  writeRollout(path.join(root, 'sessions'), 'imported', importedRollout('imp', only));
  const payload = discover(root);
  assert.equal(payload.projects.some((p) => p.path === only), false);
  assert.equal(payload.everSeen, 0);
  assert.equal(payload.importedExcluded, 1);
});

test('the Projects section carries the discovery count', () => {
  const section = collectProjects({
    sources: { projects: [], everSeen: 0, onDisk: 0, gitRepos: 0, unresolved: 0, importedExcluded: 3, complete: true, method: 'm', sources: {} },
    loc: false, now: () => 1,
  });
  assert.equal(section.importedExcluded, 3);
  assert.equal(collectProjects({ projects: [], loc: false, now: () => 1 }).importedExcluded, 0);
});

test('the usage origin of an imported head is unknown and says why', () => {
  const imported = importedRollout('imp', '/p').join('\n');
  assert.deepEqual(usageSessionOrigin(imported, 'codex'), { origin: 'unknown', evidence: 'imported-copy' });
  assert.equal(usageSessionOrigin(nativeRollout('n', '/p').join('\n'), 'codex').origin, 'codex-desktop');
  const parsed = parseCodex(imported, { id: 'imp' });
  assert.equal(parsed.session.imported, true);
  assert.equal(parsed.session.sessionOrigin.origin, 'unknown');
});

test('the usage origin never applies the Codex marker to a Claude transcript', () => {
  const claudeHead = JSON.stringify({
    cwd: '/p', sessionId: 's', entrypoint: 'claude-desktop', payload: { turn_id: 'external-import-turn-1' },
  });
  assert.deepEqual(usageSessionOrigin(claudeHead, 'claude'), { origin: 'claude-desktop', evidence: 'entrypoint:claude-desktop' });
});
