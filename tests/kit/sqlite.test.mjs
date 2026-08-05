import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withDb } from '../../src/lib/sqlite.mjs';

test('withDb distinguishes an absent database from an empty result', () => {
  const file = path.join(os.tmpdir(), `ak-sqlite-absent-${process.pid}-${Date.now()}.db`);
  const result = withDb(file, () => []);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'absent');
  assert.equal(result.error.stage, 'open');
});

test('withDb classifies corrupt input instead of returning the caller fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-sqlite-corrupt-'));
  const file = path.join(dir, 'store.db');
  fs.writeFileSync(file, 'not a sqlite database');
  const result = withDb(file, (db) => db.prepare('SELECT 1').get());
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'corrupt');
  assert.equal(result.error.stage, 'query');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('withDb classifies SQL/schema errors separately from a valid empty query', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-sqlite-query-'));
  const file = path.join(dir, 'store.db');
  const seed = new DatabaseSync(file);
  seed.exec('CREATE TABLE item (id INTEGER PRIMARY KEY);');
  seed.close();

  const empty = withDb(file, (db) => db.prepare('SELECT * FROM item').all());
  assert.deepEqual(empty, { ok: true, value: [] });
  const bad = withDb(file, (db) => db.prepare('SELECT * FROM missing_table').all());
  assert.equal(bad.ok, false);
  assert.equal(bad.error.kind, 'query');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('withDb classifies busy and close failures through its injectable driver seam', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-sqlite-driver-'));
  const file = path.join(dir, 'store.db');
  fs.writeFileSync(file, 'fixture');
  class BusyDatabase {
    constructor() { throw Object.assign(new Error('database is locked'), { errcode: 5 }); }
  }
  class CloseFailureDatabase {
    close() { throw Object.assign(new Error('close failed'), { code: 'EIO' }); }
  }
  const busy = withDb(file, () => null, { Database: BusyDatabase });
  assert.equal(busy.error.kind, 'busy');
  const close = withDb(file, () => 1, { Database: CloseFailureDatabase });
  assert.equal(close.error.kind, 'close');
  assert.equal(close.error.stage, 'close');
  fs.rmSync(dir, { recursive: true, force: true });
});
