// Apply, archive, and concurrent-writer contracts for AQE stray-store merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mergeAqeStores } from '../../src/lib/aqe-store-merge.mjs';
import { fakeAqe, project, noHolders, sequence, held, base, count,
  hooked, realImport, lastRehearsalImport, writeTo } from './helpers/aqe-store-merge-harness.mjs';

test('--yes merges, keeps the audit trail out, archives whole folders beside a backup and a receipt', async (t) => {
  const p = project(t);
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner, holders: noHolders }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  assert.equal(count(p.rootDb, 'qe_patterns'), 4);
  assert.equal(count(p.rootDb, 'captured_experiences'), 2);
  assert.equal(count(p.rootDb, 'witness_chain'), 2, 'no stray witness row reaches the root');
  const runDir = path.join(p.mergeDir, result.runId);
  for (const [stray, slug] of [['docs', 'docs'], ['.agentic-qe/.agentic-qe', 'dot-agentic-qe']]) {
    assert.equal(fs.existsSync(path.join(p.root, stray === 'docs' ? 'docs/.agentic-qe' : stray)), false, `${stray} moved`);
    assert.ok(fs.existsSync(path.join(runDir, 'archive', slug, '.agentic-qe', 'memory.db')), `${slug} archived`);
    assert.ok(fs.existsSync(path.join(runDir, 'archive', slug, '.agentic-qe', 'patterns.rvf')), 'the whole folder moves');
  }
  assert.equal(count(path.join(runDir, 'archive', 'docs', '.agentic-qe', 'memory.db'), 'witness_chain'), 3, 'the archive keeps its audit trail');
  assert.ok(fs.existsSync(path.join(p.root, 'docker', '.agentic-qe')), 'a folder without a store is left alone');
  assert.equal(result.backup, path.join(runDir, 'backup', 'root-memory.db'));
  assert.equal(count(result.backup, 'qe_patterns'), 2, 'the backup is the root before the merge');
  for (const file of [result.backup, result.receipt]) {
    assert.ok(!file.split(path.sep).includes('.agentic-qe'), `${file} lies outside every .agentic-qe`);
  }
  assert.equal(fs.existsSync(path.join(runDir, 'scratch')), false, 'scratch is removed after a merge');
  const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'));
  assert.equal(receipt.aqeVersion, '3.14.4');
  assert.equal(receipt.holderMethod, 'lsof');
  assert.deepEqual(receipt.before, { patterns: 2, experiences: 1 });
  assert.deepEqual(receipt.after, { patterns: 4, experiences: 2 });
  assert.deepEqual(receipt.strays.map((s) => [s.path, s.witnessRowsNotImported, s.prunedPatterns]),
    [['.agentic-qe/.agentic-qe', 1, 0], ['docs/.agentic-qe', 3, 0]]);
  const real = calls.filter((c) => c.args[1] === 'import' && c.args.includes(p.rootDb));
  assert.ok(real.length >= 2 && real.every((c) => c.cwd === p.root && c.env.AQE_PROJECT_ROOT === fs.realpathSync(p.root)));
  const scratch = calls.filter((c) => c.args[0] === 'brain' && !c.args.includes(p.rootDb));
  assert.ok(scratch.every((c) => !String(c.env.AQE_STORAGE_PATH).split(path.sep).includes('.agentic-qe')), 'AQE writes no .agentic-qe in ak state');
  const again = await mergeAqeStores(p.root, base(p, { apply: true, runner, holders: noHolders, now: Date.UTC(2026, 8, 27, 13) }));
  assert.equal(again.status, 'nothing');
  assert.deepEqual(fs.readdirSync(p.mergeDir), [result.runId], 'a second run writes no receipt');
});

test('a holder appearing between rehearsal and apply stops before the real import', async (t) => {
  const p = project(t);
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner, holders: sequence({ holders: [], method: 'lsof', complete: true }, held) }));
  assert.equal(result.status, 'refused');
  assert.ok(!calls.some((c) => c.args.includes(p.rootDb)), 'no import into the real root');
  assert.equal(count(p.rootDb, 'qe_patterns'), 2);
  assert.ok(fs.existsSync(path.join(p.root, 'docs', '.agentic-qe', 'memory.db')), 'the strays stay');
  assert.ok(fs.existsSync(result.backup), 'the backup is kept');
});

test('a count mismatch after the real import stops before archive, leaves the strays and names the backup', async (t) => {
  const p = project(t);
  const under = fakeAqe({ underImportInto: p.rootDb });
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: under.runner, holders: noHolders }));
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /count/);
  assert.ok(fs.existsSync(path.join(p.root, 'docs', '.agentic-qe', 'memory.db')));
  assert.ok(fs.existsSync(path.join(p.root, '.agentic-qe', '.agentic-qe', 'memory.db')));
  assert.equal(fs.existsSync(path.join(p.mergeDir, result.runId, 'archive')), false);
  assert.ok(result.restore.includes(result.backup), result.restore);
  // Review minor 9: the order, and what a restore discards.
  const order = ['close', 'delete', 'memory.db-wal', 'copy'].map((word) => result.restore.indexOf(word));
  assert.ok(order.every((at) => at >= 0) && order[0] < order[1] && order[1] < order[3] && order[2] < order[3], result.restore);
  assert.match(result.restore, /discards every write made to the project store after the backup/);
  assert.ok(fs.existsSync(result.receipt), 'a failed apply still leaves its receipt');
});

test('Windows: a rename that fails with EBUSY leaves that stray and reports it; the others move', async (t) => {
  const p = project(t);
  const rename = (from, to) => {
    if (from.includes(`${path.sep}docs${path.sep}`)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    fs.renameSync(from, to);
  };
  const result = await mergeAqeStores(p.root, base(p, {
    apply: true, platform: 'win32', runner: fakeAqe().runner, rename,
    holders: async () => ({ holders: [], method: 'census', complete: false }),
  }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  assert.deepEqual(result.leftInPlace.map((s) => [s.path, s.reason]), [['docs/.agentic-qe', 'EBUSY: a process still holds it']]);
  assert.ok(fs.existsSync(path.join(p.root, 'docs', '.agentic-qe', 'memory.db')));
  assert.deepEqual(result.archived.map((s) => s.path), ['.agentic-qe/.agentic-qe']);
});

test('a move across filesystems copies, checks every file and size, then removes the source', async (t) => {
  const p = project(t);
  const rename = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders, rename }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  const runDir = path.join(p.mergeDir, result.runId);
  assert.ok(fs.existsSync(path.join(runDir, 'archive', 'docs', '.agentic-qe', 'patterns.rvf')));
  assert.equal(fs.existsSync(path.join(p.root, 'docs', '.agentic-qe')), false);
});

test('a move across filesystems whose source removal fails part-way says what remains (review minor 10)', async (t) => {
  const p = project(t);
  const rename = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  const remove = (dir) => {
    if (dir.includes(`${path.sep}docs${path.sep}`)) {
      fs.unlinkSync(path.join(dir, 'patterns.rvf'));
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    }
    fs.rmSync(dir, { recursive: true });
  };
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders, rename, remove }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  const docs = result.leftInPlace.find((s) => s.path === 'docs/.agentic-qe');
  assert.ok(docs, JSON.stringify(result.leftInPlace));
  assert.match(docs.reason, /^partially moved: /);
  assert.match(docs.reason, /memory\.db/, 'names what remains');
  assert.doesNotMatch(docs.reason, /patterns\.rvf/, 'not what is gone');
  assert.match(docs.reason, /EBUSY/);
  assert.ok(docs.reason.includes(path.join(p.mergeDir, result.runId, 'archive', 'docs', '.agentic-qe')), 'names the complete archive copy');
});

test('a root written after the preview copied it stops before the real import (review M2)', async (t) => {
  const p = project(t);
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: true, holders: noHolders,
    runner: hooked(runner, lastRehearsalImport(p), writeTo(p.rootDb)) }));
  assert.equal(result.status, 'refused', JSON.stringify(result.reason));
  assert.match(result.reason, /project store changed since/);
  assert.ok(!calls.some((c) => c.args.includes(p.rootDb)), 'no import into the real root');
  assert.ok(fs.existsSync(path.join(p.root, 'docs', '.agentic-qe', 'memory.db')), 'the strays stay');
});

test('a stray written after the preview copied it stops before the real import and is named (review M2)', async (t) => {
  const p = project(t);
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: true, holders: noHolders,
    runner: hooked(runner, lastRehearsalImport(p), writeTo(path.join(p.root, 'docs', '.agentic-qe', 'memory.db'))) }));
  assert.equal(result.status, 'refused', JSON.stringify(result.reason));
  assert.match(result.reason, /docs\/\.agentic-qe changed since/);
  assert.ok(!calls.some((c) => c.args.includes(p.rootDb)), 'no import into the real root');
});

test('a stray written during the real import is left in place with its reason; the others move (review M2)', async (t) => {
  const p = project(t);
  const { runner } = fakeAqe();
  const docsDb = path.join(p.root, 'docs', '.agentic-qe', 'memory.db');
  const result = await mergeAqeStores(p.root, base(p, { apply: true, holders: noHolders,
    runner: hooked(runner, realImport(p), writeTo(docsDb)) }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  assert.deepEqual(result.archived.map((s) => s.path), ['.agentic-qe/.agentic-qe']);
  assert.equal(result.leftInPlace.length, 1);
  assert.equal(result.leftInPlace[0].path, 'docs/.agentic-qe');
  assert.match(result.leftInPlace[0].reason, /changed since it was copied/);
  assert.match(result.leftInPlace[0].reason, /newer than the copy/);
  assert.ok(fs.existsSync(docsDb), 'the changed stray stays where it is');
});

test('the backup\'s own read of the root is not mistaken for a writer (review M2)', async (t) => {
  const p = project(t);
  // No -wal or -shm beside the root yet: opening it for the backup creates both.
  for (const name of ['memory.db-wal', 'memory.db-shm']) assert.equal(fs.existsSync(path.join(p.root, '.agentic-qe', name)), false);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
});

test('a receipt marked applying exists before the real import, so an interrupted run is visible (review minor 8)', async (t) => {
  const p = project(t);
  const { runner } = fakeAqe();
  let during = null;
  const result = await mergeAqeStores(p.root, base(p, { apply: true, holders: noHolders,
    runner: hooked(runner, realImport(p), () => {
      const dir = fs.readdirSync(p.mergeDir)[0];
      during = JSON.parse(fs.readFileSync(path.join(p.mergeDir, dir, 'receipt.json'), 'utf8'));
    }) }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  assert.equal(during?.status, 'applying');
  assert.equal(during.backup, result.backup);
  assert.equal(JSON.parse(fs.readFileSync(result.receipt, 'utf8')).status, 'merged');
});

test('experiences whose id the root already holds are counted as skipped in the preview and receipt (review minor 6)', async (t) => {
  const p = project(t);
  const docs = new DatabaseSync(path.join(p.root, 'docs', '.agentic-qe', 'memory.db'));
  docs.prepare('INSERT INTO captured_experiences (id, task, agent) VALUES (?, ?, ?)').run('e1', 'a different task', 'agent');
  docs.close();
  const preview = await mergeAqeStores(p.root, base(p, { apply: false, runner: fakeAqe().runner, holders: noHolders }));
  const row = preview.strays.find((s) => s.path === 'docs/.agentic-qe');
  assert.deepEqual([row.experiences, row.experiencesInRoot, row.newExperiences], [2, 1, 1]);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders, now: Date.UTC(2026, 8, 27, 18) }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'));
  assert.equal(receipt.strays.find((s) => s.path === 'docs/.agentic-qe').experiencesInRoot, 1);
});
