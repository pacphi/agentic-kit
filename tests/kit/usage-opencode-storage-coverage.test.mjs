import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { observeOpencodeStorageCoverage } from '../../src/lib/usage-opencode-storage-coverage.mjs';

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-oc-coverage-'));
  const file = path.join(root, 'opencode.db');
  const db = new DatabaseSync(file);
  try { return fn({ root, file, db }); }
  finally { if (db.isOpen) db.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('null inputs remain not observed, with no completeness claim', () => {
  assert.deepEqual(observeOpencodeStorageCoverage(), {
    v2: { status: 'not-observed' }, legacy: { status: 'not-observed' }, warnings: [],
  });
});

test('older schema, empty V2 table, and populated V2 table have distinct states', () => fixture(({ db }) => {
  assert.equal(observeOpencodeStorageCoverage({ db }).v2.status, 'missing');
  db.exec('CREATE TABLE session_message (id TEXT, data TEXT)');
  assert.equal(observeOpencodeStorageCoverage({ db }).v2.status, 'empty');
  db.prepare('INSERT INTO session_message VALUES (?, ?)').run('one', 'private body');
  const result = observeOpencodeStorageCoverage({ db });
  assert.deepEqual(result.v2, { status: 'present' });
  assert.deepEqual(result.warnings, ['opencode-v2-session-message-present']);
  assert.equal(JSON.stringify(result).includes('private body'), false);
}));

test('non-table schema and failed query stay unknown without leaking error detail', () => fixture(({ db }) => {
  db.exec('CREATE VIEW session_message AS SELECT 1 AS id');
  assert.deepEqual(observeOpencodeStorageCoverage({ db }).v2, { status: 'unknown' });
  db.exec('DROP VIEW session_message; CREATE TABLE session_message (id TEXT)');
  db.close();
  const result = observeOpencodeStorageCoverage({ db });
  assert.deepEqual(result.v2, { status: 'unknown' });
  assert.deepEqual(result.warnings, ['opencode-v2-observation-incomplete']);
}));

test('legacy absent and regular JSON presence are distinguished without reading content', () => fixture(({ root, db, file }) => {
  const missing = path.join(root, 'missing');
  assert.equal(observeOpencodeStorageCoverage({ legacyRoot: missing }).legacy.status, 'absent');
  const storage = path.join(root, 'storage');
  fs.mkdirSync(path.join(storage, 'session'), { recursive: true });
  const json = path.join(storage, 'session', 'one.json');
  fs.writeFileSync(json, '{"private":"body"}');
  const before = [digest(file), digest(json)];
  const result = observeOpencodeStorageCoverage({ db, legacyRoot: storage });
  assert.deepEqual(result.legacy, { status: 'present' });
  assert.deepEqual(result.warnings, ['opencode-legacy-json-present']);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual([digest(file), digest(json)], before);
}));

test('unreadable shape, entry cap, depth cap, and symlink-only tree are unknown', () => fixture(({ root }) => {
  const fileRoot = path.join(root, 'file');
  fs.writeFileSync(fileRoot, 'not a directory');
  assert.equal(observeOpencodeStorageCoverage({ legacyRoot: fileRoot }).legacy.status, 'unknown');
  const storage = path.join(root, 'storage');
  fs.mkdirSync(storage);
  fs.writeFileSync(path.join(storage, 'a.txt'), 'a');
  fs.writeFileSync(path.join(storage, 'b.txt'), 'b');
  assert.equal(observeOpencodeStorageCoverage({ legacyRoot: storage, maxEntries: 1 }).legacy.status, 'unknown');
  fs.mkdirSync(path.join(storage, 'nested'));
  fs.writeFileSync(path.join(storage, 'nested', 'one.json'), '{}');
  assert.equal(observeOpencodeStorageCoverage({ legacyRoot: storage, maxDepth: 0 }).legacy.status, 'unknown');
  const linkOnly = path.join(root, 'links');
  fs.mkdirSync(linkOnly);
  fs.symlinkSync(path.join(storage, 'nested'), path.join(linkOnly, 'nested'));
  assert.equal(observeOpencodeStorageCoverage({ legacyRoot: linkOnly }).legacy.status, 'unknown');
}));

test('established presence survives incomplete traversal, and combined warnings are fixed shape', () => fixture(({ root, db }) => {
  db.exec('CREATE TABLE session_message (id TEXT)');
  db.prepare('INSERT INTO session_message VALUES (?)').run('one');
  const storage = path.join(root, 'storage');
  fs.mkdirSync(storage);
  fs.writeFileSync(path.join(storage, 'a.json'), '{}');
  fs.symlinkSync(path.join(root, 'outside'), path.join(storage, 'z-link'));
  assert.deepEqual(observeOpencodeStorageCoverage({ db, legacyRoot: storage }), {
    v2: { status: 'present' }, legacy: { status: 'present' },
    warnings: ['opencode-v2-session-message-present', 'opencode-legacy-json-present'],
  });
}));

test('caller-owned read-only handle remains open and database bytes remain unchanged', () => fixture(({ db, file }) => {
  db.exec('CREATE TABLE session_message (id TEXT); INSERT INTO session_message VALUES (1)');
  db.close();
  const before = digest(file);
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(observeOpencodeStorageCoverage({ db: reader }).v2.status, 'present');
    assert.equal(reader.isOpen, true);
    assert.equal(digest(file), before);
  } finally { reader.close(); }
}));
