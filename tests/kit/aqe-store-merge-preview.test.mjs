// Preview and refusal contracts for AQE stray-store merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './helpers/temp-dir.mjs';
import { withDb } from '../../src/lib/sqlite.mjs';
import { mergeAqeStores, archiveSlug } from '../../src/lib/aqe-store-merge.mjs';
import { buildStore, fakeAqe, project, snapshot, noHolders, sequence, held, base, names } from './helpers/aqe-store-merge-harness.mjs';

test('the archive slug never names a folder .agentic-qe and keeps dot folders apart from plain ones', () => {
  assert.equal(archiveSlug('docs/.agentic-qe'), 'docs');
  assert.equal(archiveSlug('.agentic-qe/.agentic-qe'), 'dot-agentic-qe');
  assert.equal(archiveSlug('.claude/.agentic-qe'), 'dot-claude');
  assert.equal(archiveSlug('claude/.agentic-qe'), 'claude');
  assert.equal(archiveSlug('docs/research/v5/.agentic-qe'), 'docs--research--v5');
});

test('dry run: previews from copies, opens no real store, writes nothing outside its scratch and leaves none', async (t) => {
  const p = project(t);
  const before = snapshot(p.root);
  const opened = [];
  const openDb = (file, fn, options) => { opened.push(file); return withDb(file, fn, options); };
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: false, runner, holders: noHolders, openDb }));
  assert.equal(result.status, 'preview');
  assert.deepEqual(snapshot(p.root), before, 'the project is untouched');
  assert.equal(calls.filter((c) => c.args[0] === 'brain').length, 0, 'no aqe export or import in a dry run');
  assert.ok(opened.length >= 3);
  const runDir = path.join(p.mergeDir, result.runId);
  assert.ok(opened.every((file) => file.startsWith(path.join(runDir, 'scratch') + path.sep)), JSON.stringify(opened));
  assert.equal(fs.existsSync(runDir), false, 'the preview removes its own scratch copies');
  assert.deepEqual(result.rootStore.patterns, 2);
  const docs = result.strays.find((s) => s.path === 'docs/.agentic-qe');
  assert.deepEqual([docs.patterns, docs.experiences, docs.alreadyInRoot, docs.witnessRows], [2, 1, 1, 3]);
  const nested = result.strays.find((s) => s.path === '.agentic-qe/.agentic-qe');
  assert.deepEqual([nested.patterns, nested.experiences, nested.alreadyInRoot], [2, 0, 0]);
  assert.deepEqual(result.expected, { patterns: 4, experiences: 2 });
  assert.deepEqual(result.skipped, [{ path: 'docker/.agentic-qe', reason: 'no memory.db' }]);
});

test('no stray store: nothing to do, and no run folder is created', async (t) => {
  const baseDir = tempDir('ak-aqe-merge-none', t);
  const root = path.join(baseDir, 'proj');
  buildStore(path.join(root, '.agentic-qe'), { patterns: ['A'] });
  const mergeDir = path.join(baseDir, 'state', 'aqe-store-merge');
  const result = await mergeAqeStores(root, { mergeDir, apply: true, runner: fakeAqe().runner, holders: noHolders, aqeVersion: '3.14.4' });
  assert.equal(result.status, 'nothing');
  assert.equal(fs.existsSync(mergeDir), false);
});

test('a holder at the first check refuses before any backup and lists it', async (t) => {
  const p = project(t);
  const before = snapshot(p.root);
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner, holders: sequence(held) }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /4242/);
  assert.match(result.reason, /npm exec agentic-qe mcp/);
  assert.match(result.reason, /Claude Code, Codex and OpenCode/);
  assert.equal(calls.filter((c) => c.args[0] === 'brain').length, 0);
  assert.equal(result.backup, null);
  assert.deepEqual(snapshot(p.root), before);
  assert.equal(fs.existsSync(path.join(p.mergeDir, result.runId)), false);
});

test('incomplete detection on macOS or Linux refuses; there is no force', async (t) => {
  const p = project(t);
  const result = await mergeAqeStores(p.root, base(p, {
    apply: true, runner: fakeAqe().runner, holders: async () => ({ holders: [], method: 'lsof', complete: false, error: 'spawn lsof ENOENT' }),
  }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /could not check/);
});

test('an AQE older than 3.14.4 refuses', async (t) => {
  const p = project(t);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders, aqeVersion: '3.14.3' }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /3\.14\.4/);
});

test('the AQE version comes from the aqe the merge runs, not from npm\'s global tree', async (t) => {
  const p = project(t);
  const { runner } = fakeAqe({ version: '3.14.3' });
  const options = base(p, { apply: true, runner, holders: noHolders });
  delete options.aqeVersion;
  const result = await mergeAqeStores(p.root, options);
  assert.equal(result.aqeVersion, '3.14.3');
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /3\.14\.3 is older than 3\.14\.4/);
});

test('a stray copy that cannot be read is reported in the preview and refuses the merge', async (t) => {
  const p = project(t);
  fs.writeFileSync(path.join(p.root, 'docs', '.agentic-qe', 'memory.db'), 'not a database, as a copy torn by a live writer can be');
  const preview = await mergeAqeStores(p.root, base(p, { apply: false, runner: fakeAqe().runner, holders: noHolders }));
  const docs = preview.strays.find((s) => s.path === 'docs/.agentic-qe');
  assert.equal(docs.readable, false);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders, now: Date.UTC(2026, 8, 27, 14) }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /docs\/\.agentic-qe/);
});

test('no project store at the root refuses and says how to create one', async (t) => {
  const p = project(t);
  const moved = path.join(p.base, 'root-store-elsewhere');
  fs.renameSync(path.join(p.root, '.agentic-qe', 'memory.db'), moved);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /no project store/);
});

test('a nested repository\'s or in-checkout worktree\'s own store is never merged or moved (review M3)', async (t) => {
  const p = project(t);
  buildStore(path.join(p.root, 'packages', 'api', '.agentic-qe'), { patterns: ['N'], experiences: ['n1'] });
  fs.mkdirSync(path.join(p.root, 'packages', 'api', '.git'));
  buildStore(path.join(p.root, 'wt', 'feature', '.agentic-qe'), { patterns: ['W'] });
  fs.writeFileSync(path.join(p.root, 'wt', 'feature', '.git'), 'gitdir: ../../.git/worktrees/feature\n');
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  assert.deepEqual(result.strays.map((s) => s.path), ['.agentic-qe/.agentic-qe', 'docs/.agentic-qe']);
  assert.deepEqual(names(p.rootDb), ['A', 'B', 'C', 'D']);
  for (const own of ['packages/api/.agentic-qe/memory.db', 'wt/feature/.agentic-qe/memory.db']) {
    assert.ok(fs.existsSync(path.join(p.root, own)), `${own} stays where its repository keeps it`);
  }
  assert.deepEqual(result.skipped.filter((s) => /own repository/.test(s.reason)).map((s) => s.path), ['packages/api', 'wt/feature']);
});

test('a root that already fails a check refuses before anything is written, naming the check (review minor 7)', async (t) => {
  const p = project(t);
  const db = new DatabaseSync(p.rootDb);
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('INSERT INTO qe_pattern_nulls (id, pattern_id, context_fingerprint, failure_mode) VALUES (?, ?, ?, ?)').run('orphan', 'no-such-pattern', 'fp', 'none');
  db.close();
  const before = snapshot(p.root);
  const preview = await mergeAqeStores(p.root, base(p, { apply: false, runner: fakeAqe().runner, holders: noHolders }));
  assert.match(preview.refusal, /foreign_key_check/);
  assert.match(preview.refusal, /project store/);
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner, holders: noHolders, now: Date.UTC(2026, 8, 27, 16) }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /foreign_key_check: 1 violation/);
  assert.equal(result.backup, null, 'no backup piles up');
  assert.equal(fs.existsSync(path.join(p.mergeDir, result.runId)), false, 'nothing written in state');
  assert.equal(calls.filter((c) => c.args[0] === 'brain').length, 0);
  assert.deepEqual(snapshot(p.root), before);
});
