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
import { tempDir } from './helpers/temp-dir.mjs';

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

// hermeticity-setup-probe-redirected-root: Ruflo's CLI mirrors the store into
// agentdb-memory.db under the MEMORY ROOT (CLAUDE_FLOW_MEMORY_PATH, else the
// config's persistPath, else <cwd>/.swarm), not beside the pinned memory.db.
// A project whose root is redirected (ruvnet/ruflo#3193's persistPath
// ./data/memory, or an exported CLAUDE_FLOW_MEMORY_PATH) must still get its
// probe back: setup pins the memory root to <root>/.swarm for the probe.
test('the setup probe leaves nothing in a redirected memory root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-setup-probe-redirect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const redirected = path.join(root, 'data', 'memory');
  fs.writeFileSync(path.join(root, 'claude-flow.config.json'), JSON.stringify({ memory: { persistPath: './data/memory' } }));
  for (const file of [path.join(root, '.swarm', 'memory.db'), path.join(root, '.swarm', 'agentdb-memory.db'), path.join(redirected, 'agentdb-memory.db')]) {
    const db = store(file);
    db.prepare("INSERT INTO memory_entries VALUES ('real', 'user-row', 'active')").run();
    db.close();
  }
  const put = (file, key) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE IF NOT EXISTS memory_entries (namespace TEXT, key TEXT, status TEXT)');
    db.prepare("INSERT INTO memory_entries VALUES ('_setup', ?, 'active')").run(key);
    db.close();
  };
  // A fake `ruflo memory store` with the real resolution order for the mirror.
  const runner = async (_cmd, args, { cwd, env }) => {
    const key = args[args.indexOf('-k') + 1];
    put(env.CLAUDE_FLOW_DB_PATH ?? path.join(cwd, '.swarm', 'memory.db'), key);
    put(path.join(env.CLAUDE_FLOW_MEMORY_PATH ?? redirected, 'agentdb-memory.db'), key);
    return { code: 0, stdout: '', stderr: '' };
  };
  const env = { CLAUDE_FLOW_DB_PATH: path.join(fs.realpathSync(root), '.swarm', 'memory.db') };
  const { out } = await captureLog(() => verifyProjectMemoryWrite(root, env, { runner }));
  assert.match(out, /memory write VERIFIED/);
  assert.deepEqual(keys(path.join(redirected, 'agentdb-memory.db')), ['user-row'], 'the redirected MCP store kept a setup probe');
  for (const name of ['memory.db', 'agentdb-memory.db']) assert.deepEqual(keys(path.join(root, '.swarm', name)), ['user-row']);
});

// Ruflo 3.48 writes its native mirror under CLAUDE_FLOW_MEMORY_PATH even when
// CLAUDE_FLOW_DB_PATH points elsewhere. The fake follows those two routes.
function routedProject(t) {
  const root = tempDir('ak-setup-route', t);
  const primary = path.join(root, '.swarm', 'memory.db');
  const canonical = path.join(root, '.swarm', 'agentdb-memory.db');
  const redirected = path.join(root, 'data', 'memory', 'agentdb-memory.db');
  for (const file of [primary, canonical, redirected]) {
    const db = store(file);
    db.prepare("INSERT INTO memory_entries VALUES ('real', 'user-row', 'active')").run();
    db.close();
  }
  const mirrors = [];
  const runner = async (_cmd, args, { env }) => {
    const key = args[args.indexOf('-k') + 1];
    assert.equal(env.RUFLO_DAEMON_AUTOSTART, '0');
    assert.equal(env.CLAUDE_FLOW_DB_PATH, primary);
    const mirror = path.join(env.CLAUDE_FLOW_MEMORY_PATH, 'agentdb-memory.db');
    mirrors.push(mirror);
    for (const file of [env.CLAUDE_FLOW_DB_PATH, mirror]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE IF NOT EXISTS memory_entries (namespace TEXT, key TEXT, status TEXT)');
      db.prepare("INSERT INTO memory_entries VALUES ('_setup', ?, 'active')").run(key);
      db.close();
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { root, primary, canonical, redirected, mirrors, runner };
}

test('setup verifies the primary while removing its private mirror and preserving native corpora', async (t) => {
  const p = routedProject(t);
  const { out } = await captureLog(() => verifyProjectMemoryWrite(p.root, { CLAUDE_FLOW_DB_PATH: p.primary,
    CLAUDE_FLOW_MEMORY_PATH: path.dirname(p.redirected) }, { runner: p.runner }));
  assert.match(out, /memory write VERIFIED/);
  assert.deepEqual(keys(p.primary), ['user-row']);
  assert.deepEqual(keys(p.canonical), ['user-row']);
  assert.deepEqual(keys(p.redirected), ['user-row']);
  assert.equal(p.mirrors.length, 1);
  assert.equal(fs.existsSync(path.dirname(p.mirrors[0])), false);
});

test('setup pins the primary when caller env is absent and removes the mirror on a failed store', async (t) => {
  const p = routedProject(t);
  const { out } = await captureLog(() => verifyProjectMemoryWrite(p.root, undefined, {
    runner: async (cmd, args, options) => {
      await p.runner(cmd, args, options);
      return { code: 1, stdout: '', stderr: 'failed after write' };
    },
  }));
  assert.match(out, /memory write verification FAILED/);
  assert.doesNotMatch(out, /memory write VERIFIED/);
  assert.deepEqual(keys(p.canonical), ['user-row']);
  assert.deepEqual(keys(p.redirected), ['user-row']);
  assert.equal(fs.existsSync(path.dirname(p.mirrors[0])), false);
});

test('setup removes its private mirror after a runner throws', async (t) => {
  const p = routedProject(t);
  const { out } = await captureLog(() => verifyProjectMemoryWrite(p.root, {}, {
    runner: async (cmd, args, options) => {
      await p.runner(cmd, args, options);
      throw new Error('runner failed');
    },
  }));
  assert.match(out, /memory write verification FAILED/);
  assert.equal(fs.existsSync(path.dirname(p.mirrors[0])), false);
  assert.deepEqual(keys(p.canonical), ['user-row']);
});

test('setup reports a missing primary row and removes the private mirror', async (t) => {
  const p = routedProject(t);
  let mirror;
  const { out } = await captureLog(() => verifyProjectMemoryWrite(p.root, {}, {
    runner: async (_cmd, _args, { env }) => {
      mirror = env.CLAUDE_FLOW_MEMORY_PATH;
      const db = store(path.join(mirror, 'agentdb-memory.db'));
      db.close();
      return { code: 0, stdout: '', stderr: '' };
    },
  }));
  assert.match(out, /memory write verification FAILED/);
  assert.doesNotMatch(out, /memory write VERIFIED/);
  assert.equal(fs.existsSync(mirror), false);
  assert.deepEqual(keys(p.primary), ['user-row']);
});

test('setup does not claim complete verification when private mirror removal fails', { skip: process.platform === 'win32' }, async (t) => {
  const p = routedProject(t);
  let mirror;
  t.after(() => {
    if (mirror && fs.existsSync(mirror)) {
      fs.chmodSync(mirror, 0o700);
      fs.rmSync(mirror, { recursive: true, force: true });
    }
  });
  const { out } = await captureLog(() => verifyProjectMemoryWrite(p.root, {}, {
    runner: async (cmd, args, options) => {
      await p.runner(cmd, args, options);
      mirror = options.env.CLAUDE_FLOW_MEMORY_PATH;
      fs.chmodSync(mirror, 0o000);
      return { code: 0, stdout: '', stderr: '' };
    },
  }));
  assert.match(out, /temporary mirror cleanup failed/);
  assert.match(out, /memory write verification FAILED/);
  assert.doesNotMatch(out, /memory write VERIFIED/);
  assert.deepEqual(keys(p.primary), ['user-row']);
});
