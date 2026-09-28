// Which processes hold an AQE store's files open (B5-D3, agentic-qe#753). The
// merge refuses while any process holds the root or a stray store, so detection
// is by open file, never by process name: an `npm exec agentic-qe mcp` server
// counts exactly like `aqe-mcp`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tempDir } from './helpers/temp-dir.mjs';
import { parseLsofHolders, storeHolders } from '../../src/lib/aqe-store-holders.mjs';

const lsofRunner = (stdout, code = 0) => async (cmd, args) => {
  assert.equal(cmd, 'lsof');
  assert.ok(args.includes('-Fpcn'), JSON.stringify(args));
  return { code, stdout, stderr: '' };
};

test('lsof field output parses into one holder per pid with the files it holds', () => {
  const out = 'p101\ncnode\nn/p/.agentic-qe/memory.db\nn/p/.agentic-qe/memory.db-wal\np202\ncnpm exec agentic-qe mcp\nn/p/.agentic-qe/memory.db-shm\n';
  assert.deepEqual(parseLsofHolders(out), [
    { pid: 101, command: 'node', files: ['/p/.agentic-qe/memory.db', '/p/.agentic-qe/memory.db-wal'] },
    { pid: 202, command: 'npm exec agentic-qe mcp', files: ['/p/.agentic-qe/memory.db-shm'] },
  ]);
});

test('macOS: lsof lists the holders; the caller itself is excluded; any command name counts', async (t) => {
  const dir = tempDir('ak-holders-mac', t);
  const db = path.join(dir, 'memory.db');
  fs.writeFileSync(db, 'x');
  const out = `p${process.pid}\ncnode\nn${db}\np4242\ncnpm exec agentic-qe mcp\nn${db}\n`;
  const result = await storeHolders([db, `${db}-wal`], { platform: 'darwin', runner: lsofRunner(out) });
  assert.equal(result.method, 'lsof');
  assert.equal(result.complete, true);
  assert.deepEqual(result.holders.map((h) => [h.pid, h.command]), [[4242, 'npm exec agentic-qe mcp']]);
});

test('macOS: lsof exit 1 with no output means no holder, not a failure', async (t) => {
  const dir = tempDir('ak-holders-none', t);
  const db = path.join(dir, 'memory.db');
  fs.writeFileSync(db, 'x');
  const result = await storeHolders([db], { platform: 'darwin', runner: lsofRunner('', 1) });
  assert.deepEqual(result, { holders: [], method: 'lsof', complete: true });
});

test('lsof missing: detection is incomplete, never "no holders"', async (t) => {
  const dir = tempDir('ak-holders-nolsof', t);
  const db = path.join(dir, 'memory.db');
  fs.writeFileSync(db, 'x');
  const runner = async () => ({ code: 'ENOENT', stdout: '', stderr: 'spawn lsof ENOENT' });
  const result = await storeHolders([db], { platform: 'darwin', runner });
  assert.equal(result.complete, false);
  assert.deepEqual(result.holders, []);
});

test('files that do not exist are not asked about; none at all means nothing to hold', async (t) => {
  const dir = tempDir('ak-holders-absent', t);
  let called = false;
  const runner = async () => { called = true; return { code: 0, stdout: '', stderr: '' }; };
  const result = await storeHolders([path.join(dir, 'memory.db')], { platform: 'darwin', runner });
  assert.equal(called, false);
  assert.deepEqual(result, { holders: [], method: 'lsof', complete: true });
});

/** A fake /proc: pid → { uid, fds: { n: target } | 'EACCES', comm }. */
function fakeProc(root, processes) {
  for (const [pid, spec] of Object.entries(processes)) {
    const base = path.join(root, pid);
    fs.mkdirSync(path.join(base, 'fd'), { recursive: true });
    fs.writeFileSync(path.join(base, 'comm'), `${spec.comm}\n`);
    if (spec.fds === 'EACCES') fs.chmodSync(path.join(base, 'fd'), 0o000);
    else for (const [fd, target] of Object.entries(spec.fds)) fs.symlinkSync(target, path.join(base, 'fd', fd));
  }
  fs.mkdirSync(path.join(root, 'self'), { recursive: true });
}

test('Linux: /proc/*/fd finds the holder by its open file', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tempDir('ak-holders-proc', t);
  const db = path.join(dir, 'memory.db');
  fs.writeFileSync(db, 'x');
  const proc = path.join(dir, 'proc');
  fakeProc(proc, {
    700: { comm: 'node', fds: { 3: db, 4: '/dev/null' } },
    701: { comm: 'bash', fds: { 0: '/dev/null' } },
  });
  const result = await storeHolders([db], { platform: 'linux', procRoot: proc, runner: lsofRunner('') });
  assert.equal(result.method, 'proc');
  assert.equal(result.complete, true);
  assert.deepEqual(result.holders, [{ pid: 700, command: 'node', files: [db] }]);
});

test('Linux: an unreadable fd folder falls back to lsof', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const dir = tempDir('ak-holders-proc-denied', t);
  const db = path.join(dir, 'memory.db');
  fs.writeFileSync(db, 'x');
  const proc = path.join(dir, 'proc');
  fakeProc(proc, { 800: { comm: 'node', fds: 'EACCES' } });
  let result;
  // Restored here, not in an after hook: tempDir's own removal hook runs first.
  try { result = await storeHolders([db], { platform: 'linux', procRoot: proc, runner: lsofRunner(`p800\ncnode\nn${db}\n`) }); }
  finally { fs.chmodSync(path.join(proc, '800', 'fd'), 0o755); }
  assert.equal(result.method, 'lsof');
  assert.deepEqual(result.holders.map((h) => h.pid), [800]);
});

test('Windows: the host-session census for the project, never complete', async () => {
  const sessions = [
    { pid: 11, host: 'claude', cwd: 'C:\\work\\proj\\sub' },
    { pid: 12, host: 'codex', cwd: 'C:\\work\\other' },
    { pid: 13, host: 'opencode', cwd: 'C:\\work\\proj' },
  ];
  const result = await storeHolders(['C:\\work\\proj\\.agentic-qe\\memory.db'], {
    platform: 'win32', root: 'C:\\work\\proj', listSessions: async () => sessions,
  });
  assert.equal(result.method, 'census');
  assert.equal(result.complete, false);
  assert.deepEqual(result.holders.map((h) => [h.pid, h.command]), [[11, 'claude'], [13, 'opencode']]);
});

test('Windows: a census that fails is reported, not read as "no sessions"', async () => {
  const result = await storeHolders(['C:\\p\\.agentic-qe\\memory.db'], {
    platform: 'win32', root: 'C:\\p', listSessions: async () => { throw new Error('survey failed'); },
  });
  assert.equal(result.complete, false);
  assert.match(result.error, /survey failed/);
});

const haveLsof = process.platform !== 'win32' && spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined;

test('a real child process holding the store open is reported', { skip: !haveLsof, timeout: 20_000 }, async (t) => {
  const dir = tempDir('ak-holders-real', t);
  const db = path.join(dir, 'memory.db');
  fs.writeFileSync(db, 'x');
  const child = spawn(process.execPath, ['-e',
    `const fs=require('node:fs');const fd=fs.openSync(${JSON.stringify(db)},'r');process.stdout.write('open\\n');setTimeout(()=>fs.closeSync(fd),15000);`],
  { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* exited */ } });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', () => reject(new Error('holder exited early')));
  });
  const platform = process.platform === 'linux' ? 'linux' : 'darwin';
  const result = await storeHolders([db], { platform });
  assert.ok(result.holders.some((h) => h.pid === child.pid), JSON.stringify(result));
  assert.ok(!result.holders.some((h) => h.pid === process.pid), 'the caller is excluded');
});
