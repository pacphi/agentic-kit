// The disposable project the opt-in qe-court live test runs its seats in (audit
// H D7). The live test itself is paid and never runs in CI, so this proves the
// isolation it depends on: a git-initialised throwaway root that is its own
// memory root, Ruflo's daemon start-on-use off by file, the memory env pinned
// inside it and restored afterwards, a read-only leak check against the real
// project, and a cleanup that leaves nothing behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createDisposableMemoryProject, disposableMemoryEnv, leakedProofKeys, withProcessEnv,
} from '../live/disposable-memory-project.mjs';
import { memoryProjectRoot } from '../../src/lib/ruflo-memory.mjs';

/** Stands in for `git init` and `ruflo memory init`, recording each call and
 *  whether the daemon opt-out file already existed when memory init ran. */
function fakeRunner({ initCode = 0 } = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    const call = { command, args, cwd: options.cwd, env: options.env };
    calls.push(call);
    if (command === 'git') fs.mkdirSync(path.join(options.cwd, '.git'));
    if (command === 'ruflo') {
      call.optOutPresent = fs.existsSync(path.join(options.cwd, 'claude-flow.config.json'));
      if (initCode === 0) {
        fs.mkdirSync(path.join(options.cwd, '.swarm'), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, '.swarm', 'memory.db'), '');
      }
    }
    return { code: command === 'ruflo' ? initCode : 0, stdout: '', stderr: initCode ? 'init exploded' : '' };
  };
  return { runner, calls };
}

function tmpParent(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-disposable-parent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the project is a git repository of its own, so every host resolves it as the memory root', async (t) => {
  const { runner, calls } = fakeRunner();
  const project = await createDisposableMemoryProject({ runner, tmpRoot: tmpParent(t) });
  t.after(() => project.cleanup());
  assert.equal(project.root, fs.realpathSync(project.root), 'the root is a realpath');
  assert.ok(fs.existsSync(path.join(project.root, '.git')), 'codex exec refuses to run outside a git repository');
  assert.equal(memoryProjectRoot(project.root), project.root, 'ak x ruflo-mcp resolves this folder, not an enclosing checkout');
  assert.deepEqual(calls.map((c) => [c.command, ...c.args]), [['git', 'init', '-q'], ['ruflo', 'memory', 'init']]);
  assert.ok(calls.every((c) => c.cwd === project.root));
});

test("Ruflo's daemon start-on-use is off by file before any ruflo command runs", async (t) => {
  const { runner, calls } = fakeRunner();
  const project = await createDisposableMemoryProject({ runner, tmpRoot: tmpParent(t) });
  t.after(() => project.cleanup());
  const config = JSON.parse(fs.readFileSync(path.join(project.root, 'claude-flow.config.json'), 'utf8'));
  assert.deepEqual(config, { daemon: { autostart: false } });
  assert.equal(calls.find((c) => c.command === 'ruflo').optOutPresent, true,
    'the file opt-out reaches an MCP server that Codex launches with a filtered environment; the env var would not');
});

test('memory init and the seats get a memory env pinned inside the project', async (t) => {
  const { runner, calls } = fakeRunner();
  const project = await createDisposableMemoryProject({ runner, tmpRoot: tmpParent(t) });
  t.after(() => project.cleanup());
  const expected = {
    CLAUDE_FLOW_DB_PATH: path.join(project.root, '.swarm', 'memory.db'),
    CLAUDE_FLOW_MEMORY_PATH: path.join(project.root, '.swarm'),
    RUFLO_DAEMON_AUTOSTART: '0',
  };
  assert.deepEqual(project.env, expected);
  assert.deepEqual(disposableMemoryEnv(project.root), expected);
  const init = calls.find((c) => c.command === 'ruflo');
  for (const [key, value] of Object.entries(expected)) assert.equal(init.env[key], value, key);
});

test('a failed memory init throws and leaves nothing behind', async (t) => {
  const parent = tmpParent(t);
  const { runner } = fakeRunner({ initCode: 1 });
  await assert.rejects(createDisposableMemoryProject({ runner, tmpRoot: parent }), /ruflo memory init failed.*init exploded/);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('cleanup removes the whole project, and stops a daemon that holds its pidfile', async (t) => {
  const { runner } = fakeRunner();
  const project = await createDisposableMemoryProject({ runner, tmpRoot: tmpParent(t) });
  let child = null;
  if (process.platform !== 'win32') {
    // A keep-alive child whose command line reads like a Ruflo daemon, so the
    // pid-reuse guard in daemons.mjs reap() lets cleanup stop it.
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'daemon', 'start'], { stdio: 'ignore' }); // spawn-env: inherits (inert node sleeper, runs no kit code)
    t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.mkdirSync(path.join(project.root, '.claude-flow'));
    fs.writeFileSync(path.join(project.root, '.claude-flow', 'daemon.pid'), String(child.pid));
  }
  const exited = child ? new Promise((resolve) => child.once('exit', () => resolve('stopped'))) : null;
  project.cleanup();
  assert.equal(fs.existsSync(project.root), false);
  if (exited) {
    const pending = new Promise((resolve) => { setTimeout(resolve, 5_000, 'still running').unref(); });
    assert.equal(await Promise.race([exited, pending]), 'stopped', 'the project daemon is stopped before the folder goes');
  }
  project.cleanup(); // idempotent
});

test('withProcessEnv sets the overrides for the callback and restores the previous values, even on failure', async () => {
  const saved = { keep: process.env.AK_TEST_KEEP, fresh: process.env.AK_TEST_FRESH };
  process.env.AK_TEST_KEEP = 'before';
  delete process.env.AK_TEST_FRESH;
  try {
    const seen = await withProcessEnv({ AK_TEST_KEEP: 'during', AK_TEST_FRESH: 'new' },
      async () => [process.env.AK_TEST_KEEP, process.env.AK_TEST_FRESH]);
    assert.deepEqual(seen, ['during', 'new']);
    assert.equal(process.env.AK_TEST_KEEP, 'before');
    assert.equal('AK_TEST_FRESH' in process.env, false, 'a key that was absent is removed again');
    await assert.rejects(withProcessEnv({ AK_TEST_KEEP: 'boom' }, async () => { throw new Error('seat failed'); }), /seat failed/);
    assert.equal(process.env.AK_TEST_KEEP, 'before');
  } finally {
    if (saved.keep === undefined) delete process.env.AK_TEST_KEEP; else process.env.AK_TEST_KEEP = saved.keep;
    if (saved.fresh === undefined) delete process.env.AK_TEST_FRESH; else process.env.AK_TEST_FRESH = saved.fresh;
  }
});

test('leakedProofKeys reads the real project read-only and names only proof keys that landed there', (t) => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-real-project-'));
  t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  assert.deepEqual(leakedProofKeys(real, 'ns', ['a']), [], 'no stores: nothing leaked');
  fs.mkdirSync(path.join(real, '.swarm'));
  const file = path.join(real, '.swarm', 'agentdb-memory.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE memory_entries (id TEXT, key TEXT, namespace TEXT, content TEXT, status TEXT); INSERT INTO memory_entries VALUES ('1', 'leaked', 'ns', 'v', 'active')");
  db.close();
  const before = fs.statSync(file).mtimeMs;
  assert.deepEqual(leakedProofKeys(real, 'ns', ['leaked', 'clean']), ['leaked']);
  assert.deepEqual(leakedProofKeys(real, 'other-ns', ['leaked']), []);
  assert.equal(fs.statSync(file).mtimeMs, before, 'the real store is never written');
});
