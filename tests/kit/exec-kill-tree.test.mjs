// One process-tree kill for every MCP stdio client the kit starts (the
// discovery probe and the tool-call client), so their teardown cannot drift
// apart. POSIX kills the child's process group and falls back to the child
// itself exactly as run()'s timeout path does; Windows uses taskkill /T.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { killProcessTree } from '../../src/lib/exec.mjs';
import { probeMcp } from '../../src/lib/mcp-probe.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (predicate, tries = 60) => {
  for (let i = 0; i < tries && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 50));
};
const posix = { skip: process.platform === 'win32' ? 'POSIX process groups' : false };

// A node child that starts a long-lived grandchild and records its pid.
function parentWithGrandchild(t, { detached }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-kill-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = `const { spawn } = require('node:child_process');
    const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
    setTimeout(() => {}, 60000);`;
  const child = spawn(process.execPath, ['-e', script], { detached, stdio: 'ignore' }); // spawn-env: inherits (inert node process tree, runs no kit code)
  return { child, pidFile };
}

test('on Windows the whole tree is killed with taskkill /T /F, and a taskkill failure falls back to the child', () => {
  const calls = [];
  const killer = { on: (event, fn) => { calls.push(['on', event]); killer.fail = fn; } };
  const killed = [];
  const child = { pid: 4242, kill: (signal) => killed.push(signal) };
  killProcessTree(child, { platform: 'win32', spawnFn: (cmd, args, opts) => { calls.push([cmd, args, opts.shell]); return killer; } });
  assert.deepEqual(calls[0], ['taskkill', ['/pid', '4242', '/T', '/F'], false]);
  assert.deepEqual(killed, [], 'taskkill owns the kill while it can run');
  killer.fail();
  assert.deepEqual(killed, ['SIGKILL']);
});

test('without a pid nothing is spawned and nothing throws', () => {
  const spawnFn = () => { throw new Error('taskkill must not run without a pid'); };
  assert.doesNotThrow(() => killProcessTree({ pid: undefined, kill() {} }, { platform: 'win32', spawnFn }));
  assert.doesNotThrow(() => killProcessTree({ kill() { throw new Error('already reaped'); } }, { platform: 'linux', spawnFn }));
});

test('on POSIX the child process group dies, including a grandchild it started', posix, async (t) => {
  const { child, pidFile } = parentWithGrandchild(t, { detached: true });
  await waitFor(() => fs.existsSync(pidFile));
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(alive(grandchild), true, 'fixture: the grandchild is running before the kill');
  killProcessTree(child);
  const [, signal] = await once(child, 'close');
  assert.equal(signal, 'SIGKILL');
  await waitFor(() => !alive(grandchild), 40);
  assert.equal(alive(grandchild), false, 'killing only the child would orphan its own children');
});

test('a child that does not lead its own group is still killed directly', posix, async (t) => {
  const { child, pidFile } = parentWithGrandchild(t, { detached: false });
  await waitFor(() => fs.existsSync(pidFile));
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ } });
  killProcessTree(child);
  const [, signal] = await once(child, 'close');
  assert.equal(signal, 'SIGKILL', 'no process group to signal falls back to the child itself');
});

test('killing an already-dead process group is not an error', posix, async () => {
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' }); // spawn-env: inherits (inert node child, runs no kit code)
  await once(child, 'close');
  assert.doesNotThrow(() => killProcessTree(child));
});

test('a timed-out MCP probe kills the server and the children it started', posix, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-probe-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'worker.pid');
  // A silent "server" that starts a worker and never answers initialize.
  const script = `const { spawn } = require('node:child_process');
    const w = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(w.pid));
    setInterval(() => {}, 1000);`;
  const result = await probeMcp({ command: process.execPath, args: ['-e', script], timeoutMs: 1500 });
  assert.equal(result.status, 'timeout');
  await waitFor(() => fs.existsSync(pidFile));
  const worker = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitFor(() => !alive(worker), 40);
  assert.equal(alive(worker), false, 'a timed-out probe must not leave the server\'s workers running');
});
