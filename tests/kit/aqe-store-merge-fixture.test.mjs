import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './helpers/temp-dir.mjs';
import { buildStore } from './helpers/aqe-store-merge-fixture.mjs';
import { fakeAqe } from './helpers/aqe-store-merge-harness.mjs';

const schema = fs.readFileSync(new URL('../fixtures/aqe-store/schema-3.14.4.sql', import.meta.url), 'utf8');
const statements = schema.split(/;\s*\n(?=CREATE)/).map((s) => s.trim().replace(/;$/, ''))
  .filter((s) => s && !/^CREATE TABLE (sqlite_sequence|'qe_patterns_fts_(data|idx|docsize|config)')/.test(s));

// Keep independent statement-by-statement execution as the migration oracle,
// but group writes so Windows does not flush every schema statement separately.
function sequentialStore(dir, experiences) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'memory.db'));
  try {
    db.exec('BEGIN');
    for (const sql of statements) if (experiences !== null || !/captured_experiences/.test(sql)) db.exec(sql);
    db.exec('COMMIT');
    db.exec('PRAGMA journal_mode = WAL');
  } finally { db.close(); }
}

const schemaObjects = (db) => db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
  ORDER BY type, name`).all();

for (const experiences of [[], null]) {
  const variant = experiences === null ? 'fresh store' : 'store with experiences';
  test(`${variant} has the same schema as the sequential AQE 3.14.4 loader`, (t) => {
    const root = tempDir('ak-aqe-schema-parity', t);
    const expectedDir = path.join(root, 'expected');
    const actualDir = path.join(root, 'actual');
    sequentialStore(expectedDir, experiences);
    buildStore(actualDir, { patterns: ['Alpha'], experiences, witness: 1 });
    const expected = new DatabaseSync(path.join(expectedDir, 'memory.db'), { readOnly: true });
    const actual = new DatabaseSync(path.join(actualDir, 'memory.db'), { readOnly: true });
    try {
      assert.deepEqual(schemaObjects(actual), schemaObjects(expected));
      assert.equal(actual.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(actual.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(actual.prepare("SELECT name FROM qe_patterns_fts WHERE qe_patterns_fts MATCH 'Alpha'").all().map((r) => r.name), ['Alpha']);
      assert.equal(actual.prepare('SELECT count(*) AS n FROM witness_chain').get().n, 1);
      assert.equal(fs.existsSync(path.join(actualDir, 'patterns.rvf')), true);
    } finally { actual.close(); expected.close(); }
  });
}

test('fake AQE import creates captured_experiences in a fresh store', async (t) => {
  const root = tempDir('ak-aqe-schema-import', t);
  const dir = path.join(root, '.agentic-qe');
  buildStore(dir, { experiences: null });
  const file = path.join(dir, 'memory.db');
  const input = path.join(root, 'export');
  fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, 'captured-experiences.jsonl'),
    `${JSON.stringify({ id: 'e1', task: 'task', agent: 'agent' })}\n`);
  const before = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(before.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'captured_experiences'").get().n, 0);
  } finally { before.close(); }
  const result = await fakeAqe().runner('aqe', ['brain', 'import', '--db', file, '-i', input], { cwd: root, env: {} });
  assert.equal(result.code, 0);
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(after.prepare('SELECT count(*) AS n FROM captured_experiences').get().n, 1);
    assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { after.close(); }
});

test('template copies keep FTS insert and delete triggers live', (t) => {
  const dir = path.join(tempDir('ak-aqe-schema-fts', t), '.agentic-qe');
  buildStore(dir, { patterns: ['Alpha'] });
  const db = new DatabaseSync(path.join(dir, 'memory.db'));
  try {
    const search = () => db.prepare("SELECT name FROM qe_patterns_fts WHERE qe_patterns_fts MATCH 'Alpha'").all().map((r) => r.name);
    assert.deepEqual(search(), ['Alpha']);
    db.prepare('DELETE FROM qe_patterns WHERE name = ?').run('Alpha');
    assert.deepEqual(search(), []);
  } finally { db.close(); }
});
