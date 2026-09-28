// `ak x aqe-store merge` (decisions B5-D2..D4): stray AQE stores below the
// project root are merged into the root store with AQE's own brain
// export/import, then moved whole into ak's state folder. Fixture stores are
// built from AQE 3.14.4's captured schema; a fake `aqe` runner applies the
// JSONL export the way 3.14.4 did in the Slice 0 evidence (duplicates skipped
// by natural key or id, captured_experiences created on first import).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './helpers/temp-dir.mjs';
import { withDb } from '../../src/lib/sqlite.mjs';
import { mergeAqeStores, archiveSlug } from '../../src/lib/aqe-store-merge.mjs';

const SCHEMA = fs.readFileSync(new URL('../fixtures/aqe-store/schema-3.14.4.sql', import.meta.url), 'utf8');
// sqlite_sequence is reserved and FTS5 creates its own shadow tables.
const SHADOW = /^CREATE TABLE (sqlite_sequence|'qe_patterns_fts_(data|idx|docsize|config)')/;
const STATEMENTS = SCHEMA.split(/;\s*\n(?=CREATE)/).map((s) => s.trim().replace(/;$/, '')).filter((s) => s && !SHADOW.test(s));
const EXPERIENCE_DDL = STATEMENTS.filter((s) => /captured_experiences/.test(s));

/** A store as AQE 3.14.4 lays it out; `experiences: null` = no table yet (a fresh store). */
function buildStore(dir, { patterns = [], experiences = [], witness = 0 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'memory.db'));
  for (const s of STATEMENTS) if (experiences !== null || !/captured_experiences/.test(s)) db.exec(s);
  db.exec('PRAGMA journal_mode = WAL');
  const insertPattern = db.prepare('INSERT INTO qe_patterns (id, pattern_type, qe_domain, domain, name) VALUES (?, ?, ?, ?, ?)');
  for (const name of patterns) insertPattern.run(`${path.basename(path.dirname(dir))}-${name}`, 'workflow', 'test-generation', 'test', name);
  for (const id of experiences ?? []) db.prepare('INSERT INTO captured_experiences (id, task, agent) VALUES (?, ?, ?)').run(id, 'task', 'agent');
  const insertWitness = db.prepare('INSERT INTO witness_chain (prev_hash, action_hash, action_type, timestamp, actor) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < witness; i += 1) insertWitness.run(`p${i}`, `a${i}-${dir}`, 'PATTERN_CREATE', new Date(i * 1000).toISOString(), 'aqe');
  db.close();
  fs.writeFileSync(path.join(dir, 'patterns.rvf'), 'rvf');
}

const tables = (db) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The fake `aqe`: brain export/import over JSONL, recording each call. `init`
 *  lays out an empty store at AQE_MEMORY_PATH and `learning stats` seeds it
 *  with `seeds` the way AQE's reasoning bank does on its first start
 *  (AQE/dist/learning/qe-reasoning-bank.js:147-160). */
function fakeAqe({ underImportInto = null, version = '3.14.4', seeds = ['S1', 'S2'], initCode = 0 } = {}) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd, env: opts?.env });
    const flag = (name) => args[args.indexOf(name) + 1];
    if (args[0] === 'init') {
      if (initCode) return { code: initCode, stdout: '', stderr: 'init exploded' };
      buildStore(path.dirname(opts.env.AQE_MEMORY_PATH), { experiences: null });
      return { code: 0, stdout: 'AQE initialized\n', stderr: '' };
    }
    if (args[0] === 'learning' && args[1] === 'stats') {
      const db = new DatabaseSync(opts.env.AQE_MEMORY_PATH);
      for (const name of seeds) {
        db.prepare('INSERT INTO qe_patterns (id, pattern_type, qe_domain, domain, name) VALUES (?, ?, ?, ?, ?)').run(`seed-${name}`, 'workflow', 'test-generation', 'test', name);
      }
      db.close();
      return { code: 0, stdout: JSON.stringify({ totalPatterns: seeds.length }), stderr: '' };
    }
    if (args[0] === 'brain' && args[1] === 'export') {
      const out = flag('-o');
      fs.mkdirSync(out, { recursive: true });
      const db = new DatabaseSync(flag('--db'), { readOnly: true });
      const have = tables(db);
      const dump = (table, file) => fs.writeFileSync(path.join(out, file),
        have.has(table) ? db.prepare(`SELECT * FROM ${table}`).all().map((r) => JSON.stringify(r)).join('\n') : '');
      dump('qe_patterns', 'patterns.jsonl');
      dump('captured_experiences', 'captured-experiences.jsonl');
      dump('witness_chain', 'witness-chain.jsonl');
      db.close();
      fs.writeFileSync(path.join(out, 'manifest.json'), '{}');
      return { code: 0, stdout: 'Export complete.\n', stderr: '' };
    }
    if (args[0] === 'brain' && args[1] === 'import') {
      const target = flag('--db');
      const input = flag('-i');
      const dry = args.includes('--dry-run');
      const db = new DatabaseSync(target);
      let imported = 0; let skipped = 0;
      db.exec('BEGIN');
      if (!tables(db).has('captured_experiences')) for (const s of EXPERIENCE_DDL) db.exec(s);
      let patterns = readJsonl(path.join(input, 'patterns.jsonl'));
      if (underImportInto && target === underImportInto) patterns = patterns.slice(0, -1);
      for (const p of patterns) {
        const r = db.prepare('INSERT OR IGNORE INTO qe_patterns (id, pattern_type, qe_domain, domain, name) VALUES (?, ?, ?, ?, ?)')
          .run(p.id, p.pattern_type, p.qe_domain, p.domain, p.name);
        if (r.changes) imported += 1; else skipped += 1;
      }
      for (const e of readJsonl(path.join(input, 'captured-experiences.jsonl'))) {
        const r = db.prepare('INSERT OR IGNORE INTO captured_experiences (id, task, agent) VALUES (?, ?, ?)').run(e.id, e.task, e.agent);
        if (r.changes) imported += 1; else skipped += 1;
      }
      for (const w of readJsonl(path.join(input, 'witness-chain.jsonl'))) {
        db.prepare('INSERT INTO witness_chain (prev_hash, action_hash, action_type, timestamp, actor) VALUES (?, ?, ?, ?, ?)')
          .run(w.prev_hash, w.action_hash, w.action_type, w.timestamp, w.actor);
        imported += 1;
      }
      db.exec(dry ? 'ROLLBACK' : 'COMMIT');
      db.close();
      return { code: 0, stdout: `Import complete.\n  Imported:  ${imported}\n  Skipped:   ${skipped}\n  Conflicts: ${skipped}\n`, stderr: '' };
    }
    if (args[0] === '--version') return { code: 0, stdout: `${version}\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected aqe call ${args.join(' ')}` };
  };
  return { runner, calls };
}

const count = (file, table) => withDb(file, (db) => (tables(db).has(table) ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) : 0)).value;

/** Root with patterns A,B and experience e1; strays docs (B,C, e2, 3 witness rows),
 *  .agentic-qe/.agentic-qe (C,D, no experience table yet), and an empty docker/.agentic-qe. */
function project(t) {
  const base = tempDir('ak-aqe-merge', t);
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  buildStore(path.join(root, '.agentic-qe'), { patterns: ['A', 'B'], experiences: ['e1'], witness: 2 });
  buildStore(path.join(root, 'docs', '.agentic-qe'), { patterns: ['B', 'C'], experiences: ['e2'], witness: 3 });
  buildStore(path.join(root, '.agentic-qe', '.agentic-qe'), { patterns: ['C', 'D'], experiences: null, witness: 1 });
  fs.mkdirSync(path.join(root, 'docker', '.agentic-qe'), { recursive: true });
  const mergeDir = path.join(base, 'state', 'agentic-kit', 'aqe-store-merge');
  return { base, root, mergeDir, rootDb: path.join(root, '.agentic-qe', 'memory.db') };
}

/** Every file under `dir` with size and mtime, for "nothing changed" checks. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else { const st = fs.statSync(full); out[path.relative(dir, full)] = `${st.size}:${st.mtimeMs}`; }
    }
  };
  walk(dir);
  return out;
}

const noHolders = async () => ({ holders: [], method: 'lsof', complete: true });
const sequence = (...results) => { let i = 0; return async () => results[Math.min(i++, results.length - 1)]; };
const held = { holders: [{ pid: 4242, command: 'npm exec agentic-qe mcp', files: [] }], method: 'lsof', complete: true };
const base = (p, extra = {}) => ({ mergeDir: p.mergeDir, now: Date.UTC(2026, 8, 27, 12, 0, 0), aqeVersion: '3.14.4', platform: 'darwin', ...extra });

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

// ---- AQE's starter patterns (decision B5-D5) ---------------------------------

/** project() plus AQE starter patterns S1, S2 in the strays (the root has none of
 *  them, like the real root), rows that hard-reference S1 in docs (an embedding,
 *  a usage row, a null-result row), and the project's embedder endpoint. */
function projectWithSeeds(t, { embedder = 'settings' } = {}) {
  const p = project(t);
  const add = (dir, names) => {
    const db = new DatabaseSync(path.join(p.root, dir, 'memory.db'));
    for (const name of names) {
      db.prepare('INSERT INTO qe_patterns (id, pattern_type, qe_domain, domain, name) VALUES (?, ?, ?, ?, ?)').run(`${dir}-${name}`, 'workflow', 'test-generation', 'test', name);
    }
    return db;
  };
  const docs = add('docs/.agentic-qe', ['S1', 'S2']);
  docs.prepare('INSERT INTO qe_pattern_embeddings (pattern_id, embedding, dimension) VALUES (?, ?, ?)').run('docs/.agentic-qe-S1', Buffer.alloc(4), 1);
  docs.prepare('INSERT INTO qe_pattern_usage (pattern_id, success) VALUES (?, ?)').run('docs/.agentic-qe-S1', 1);
  docs.prepare('INSERT INTO qe_pattern_nulls (id, pattern_id, context_fingerprint, failure_mode) VALUES (?, ?, ?, ?)').run('n1', 'docs/.agentic-qe-S1', 'fp', 'none');
  docs.close();
  add('.agentic-qe/.agentic-qe', ['S1']).close();
  if (embedder === 'settings') {
    fs.mkdirSync(path.join(p.root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(p.root, '.claude', 'settings.local.json'), JSON.stringify({ env: { AQE_EMBEDDER_ENDPOINT: 'http://embed.test', OTHER: 'x' } }));
  } else if (embedder === 'mcp') {
    fs.writeFileSync(path.join(p.root, '.mcp.json'), JSON.stringify({ mcpServers: { 'agentic-qe': { command: 'aqe-mcp', env: { AQE_EMBEDDER_ENDPOINT: 'http://mcp-embed.test' } } } }));
  }
  return p;
}

const names = (file) => withDb(file, (db) => db.prepare('SELECT name FROM qe_patterns ORDER BY name').all().map((r) => r.name)).value;

test('AQE starter patterns: the set comes from a fresh store in scratch, built with the project\'s embedder', async (t) => {
  const p = projectWithSeeds(t);
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: false, runner, holders: noHolders }));
  assert.equal(result.status, 'preview');
  assert.equal(result.refusal, null);
  assert.deepEqual(result.seeds, { patterns: 2, source: '.claude/settings.local.json' });
  const build = calls.filter((c) => c.args[0] !== 'brain');
  assert.deepEqual(build.map((c) => c.args), [['init', '--auto', '--minimal'], ['learning', 'stats', '--json']]);
  const seedDir = path.join(p.mergeDir, result.runId, 'scratch', 'seed');
  for (const c of build) {
    assert.equal(c.cwd, seedDir);
    assert.equal(c.env.AQE_PROJECT_ROOT, seedDir);
    assert.equal(c.env.AQE_MEMORY_PATH, path.join(seedDir, '.agentic-qe', 'memory.db'));
    assert.equal(c.env.AQE_STORAGE_PATH, path.join(seedDir, '.agentic-qe'));
    assert.ok(c.env.npm_config_prefix.startsWith(seedDir + path.sep), 'never the user\'s global npm prefix');
    assert.equal(c.env.AQE_EMBEDDER_ENDPOINT, 'http://embed.test');
    assert.equal(c.env.OTHER, undefined, 'only the embedder keys are taken from the project');
  }
  assert.equal(fs.existsSync(path.join(p.mergeDir, result.runId)), false, 'the preview removes the fresh store with its scratch');
});

test('AQE starter patterns: the embedder falls back to the project .mcp.json registration', async (t) => {
  const p = projectWithSeeds(t, { embedder: 'mcp' });
  const { runner, calls } = fakeAqe();
  const result = await mergeAqeStores(p.root, base(p, { apply: false, runner, holders: noHolders }));
  assert.equal(result.seeds.source, '.mcp.json');
  assert.ok(calls.filter((c) => c.args[0] === 'init').every((c) => c.env.AQE_EMBEDDER_ENDPOINT === 'http://mcp-embed.test'));
});

test('AQE starter patterns are counted per stray and left out of the expected root', async (t) => {
  const p = projectWithSeeds(t);
  const result = await mergeAqeStores(p.root, base(p, { apply: false, runner: fakeAqe().runner, holders: noHolders }));
  const docs = result.strays.find((s) => s.path === 'docs/.agentic-qe');
  const nested = result.strays.find((s) => s.path === '.agentic-qe/.agentic-qe');
  // Strays are read in path order: .agentic-qe/.agentic-qe brings C and D first.
  assert.deepEqual([nested.patterns, nested.seedPatterns, nested.newPatterns], [3, 1, 2]);
  assert.deepEqual([docs.patterns, docs.seedPatterns, docs.newPatterns], [4, 2, 0]);
  assert.deepEqual(result.expected, { patterns: 4, experiences: 2 }, 'A, B, C, D: no starter pattern');
});

test('--yes leaves AQE starter patterns and their rows out of the root; the archive keeps them', async (t) => {
  const p = projectWithSeeds(t);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe().runner, holders: noHolders }));
  assert.equal(result.status, 'merged', JSON.stringify(result.reason));
  assert.deepEqual(names(p.rootDb), ['A', 'B', 'C', 'D']);
  assert.equal(count(p.rootDb, 'qe_pattern_nulls'), 0);
  const runDir = path.join(p.mergeDir, result.runId);
  assert.deepEqual(names(path.join(runDir, 'archive', 'docs', '.agentic-qe', 'memory.db')), ['B', 'C', 'S1', 'S2'], 'the archived stray is whole');
  assert.equal(count(path.join(runDir, 'archive', 'docs', '.agentic-qe', 'memory.db'), 'qe_pattern_nulls'), 1);
  const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'));
  assert.deepEqual(receipt.seedSet, { patterns: 2, source: '.claude/settings.local.json' });
  assert.deepEqual(receipt.strays.map((s) => [s.path, s.seedPatternsSkipped]), [['.agentic-qe/.agentic-qe', 1], ['docs/.agentic-qe', 2]]);
});

test('no starter set (an empty fresh store) refuses the merge before any backup, and the preview says why', async (t) => {
  const p = projectWithSeeds(t);
  const empty = fakeAqe({ seeds: [] });
  const preview = await mergeAqeStores(p.root, base(p, { apply: false, runner: empty.runner, holders: noHolders }));
  assert.match(preview.refusal, /starter pattern/);
  assert.match(preview.refusal, /no starter patterns/);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: empty.runner, holders: noHolders, now: Date.UTC(2026, 8, 27, 15) }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /starter pattern/);
  assert.equal(result.backup, null);
  assert.equal(empty.calls.filter((c) => c.args[0] === 'brain').length, 0);
  assert.equal(fs.existsSync(path.join(p.mergeDir, result.runId)), false);
});

test('a failed fresh-store build refuses the merge and names the failure', async (t) => {
  const p = projectWithSeeds(t);
  const result = await mergeAqeStores(p.root, base(p, { apply: true, runner: fakeAqe({ initCode: 1 }).runner, holders: noHolders }));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /aqe init/);
  assert.match(result.reason, /init exploded/);
});

// ---- the command ----------------------------------------------------------

const cli = await import('../../src/commands/x/aqe-store.mjs');

async function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { return { code: await fn(), out: lines.join('\n') }; } finally { console.log = original; }
}

test('ak x aqe-store: help has usage, the merge sequence, the archive and Examples', () => {
  assert.match(cli.help, /^ak x aqe-store — /);
  for (const needle of [/status/, /merge/, /--yes/, /--dry-run/, /--json/, /aqe-store-merge/, /Examples:/, /no --force/i]) assert.match(cli.help, needle);
});

test('ak x aqe-store merge is a dry run unless --yes; --dry-run wins over --yes', async (t) => {
  const p = project(t);
  const seen = [];
  const merge = async (root, options) => { seen.push([root, options.apply]); return { status: 'preview', root, strays: [], skipped: [], expected: null, holders: null }; };
  await capture(() => cli.run({ flags: {}, positionals: ['merge'], cwd: path.join(p.root, 'docs'), merge }));
  await capture(() => cli.run({ flags: { yes: true }, positionals: ['merge'], cwd: p.root, merge }));
  await capture(() => cli.run({ flags: { yes: true, 'dry-run': true }, positionals: ['merge'], cwd: p.root, merge }));
  await capture(() => cli.run({ flags: { yes: true }, positionals: ['status'], cwd: p.root, merge }));
  assert.deepEqual(seen, [[p.root, false], [p.root, true], [p.root, false], [p.root, false]]);
});

test('ak x aqe-store --json prints exactly one object; a refusal exits 1', async (t) => {
  const p = project(t);
  const merge = async (root) => ({ status: 'refused', reason: 'PID 1 holds it', root, strays: [], skipped: [], expected: null, holders: null });
  const { code, out } = await capture(() => cli.run({ flags: { json: true, yes: true }, positionals: ['merge'], cwd: p.root, merge }));
  assert.equal(code, 1);
  assert.equal(JSON.parse(out).status, 'refused');
});

test('ak x aqe-store status prints the preview for a real fixture project', async (t) => {
  const p = project(t);
  const merge = (root, options) => mergeAqeStores(root, { ...options, ...base(p, { apply: false }), runner: fakeAqe().runner, holders: noHolders });
  const { code, out } = await capture(() => cli.run({ flags: {}, positionals: ['status'], cwd: p.root, merge }));
  assert.equal(code, 0);
  assert.match(out, /docs\/\.agentic-qe: 2 patterns \(1 already in the root\), 1 experience/);
  assert.match(out, /after the merge the root would hold 4 patterns and 2 experiences/);
  assert.match(out, /docker\/\.agentic-qe: skipped \(no memory\.db\)/);
  assert.match(out, /AQE starter set: 2 patterns/);
  assert.match(out, /ak x aqe-store merge --yes/);
});

test('outside a repository the command says so and exits 1', async (t) => {
  const dir = tempDir('ak-aqe-store-norepo', t);
  const { code, out } = await capture(() => cli.run({ flags: {}, positionals: ['status'], cwd: dir, merge: async () => { throw new Error('not called'); } }));
  assert.equal(code, 1);
  assert.match(out, /not inside a repository/);
});
