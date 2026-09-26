// `ak setup` proves a memory write on a REAL project. The Ruflo CLI mirrors a
// `memory store` into memory.db and agentdb-memory.db (observed on 3.45.0), so
// cleanup must clear every store or each setup run leaves a `_setup/verify-*`
// row behind in the user's MCP corpus (issue #213 QE review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyProjectMemoryWrite } from '../../src/commands/setup.mjs';
import { captureLog } from './helpers/home-sandbox.mjs';

function store(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE memory_entries (namespace TEXT, key TEXT, status TEXT)');
  return db;
}
const keys = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT key FROM memory_entries').all().map((r) => r.key); } finally { db.close(); }
};

function project(t, { mirrored }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-setup-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ['memory.db', 'agentdb-memory.db'].map((n) => path.join(root, '.swarm', n));
  for (const file of files) {
    const db = store(file);
    db.prepare("INSERT INTO memory_entries VALUES ('real', 'user-row', 'active')").run();
    db.close();
  }
  // A fake `ruflo memory store`: writes the probe to memory.db, and to the sibling when mirrored.
  const runner = async (_cmd, args) => {
    const key = args[args.indexOf('-k') + 1];
    for (const file of mirrored ? files : [files[0]]) {
      const db = new DatabaseSync(file);
      db.prepare("INSERT INTO memory_entries VALUES ('_setup', ?, 'active')").run(key);
      db.close();
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { root, files, runner };
}

test('setup cleanup clears the probe from both stores when the CLI mirrored it', async (t) => {
  const { root, files, runner } = project(t, { mirrored: true });
  const { out } = await captureLog(() => verifyProjectMemoryWrite(root, {}, { runner }));
  for (const file of files) assert.deepEqual(keys(file), ['user-row'], `${path.basename(file)} kept a setup probe`);
  assert.match(out, /memory write VERIFIED/);
});

test('setup cleanup still works when only one store received the probe', async (t) => {
  const { root, files, runner } = project(t, { mirrored: false });
  await captureLog(() => verifyProjectMemoryWrite(root, {}, { runner }));
  for (const file of files) assert.deepEqual(keys(file), ['user-row']);
});

test('a store setup could not read is named for manual cleanup instead of claiming verification', async (t) => {
  const { root, files, runner } = project(t, { mirrored: false });
  fs.writeFileSync(files[1], 'not a database');
  const { out } = await captureLog(() => verifyProjectMemoryWrite(root, {}, { runner }));
  assert.deepEqual(keys(files[0]), ['user-row']);
  assert.match(out, /probe cleanup failed in agentdb-memory\.db/);
  assert.match(out, /remove _setup\/verify-/);
  assert.doesNotMatch(out, /memory write VERIFIED/);
});

test('setup reports a failed memory write instead of claiming verification', async (t) => {
  const { root } = project(t, { mirrored: false });
  const { out } = await captureLog(() => verifyProjectMemoryWrite(root, {}, { runner: async () => ({ code: 1, stdout: '', stderr: 'boom' }) }));
  assert.match(out, /memory write verification FAILED/);
});
