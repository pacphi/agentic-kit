import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalProcessTree } from '../../src/lib/execution/process-tree.mjs';

test('Windows tree signaling uses taskkill /T /F with a literal pid argv', async () => {
  const calls = [];
  const sent = await signalProcessTree({ pid: 4242 }, 'SIGTERM', {
    windows: true,
    runFn: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(sent, true);
  assert.deepEqual(calls[0].args, ['/PID', '4242', '/T', '/F']);
  assert.equal(calls[0].command, 'taskkill.exe');
});

test('POSIX tree signaling targets the detached process group before the child fallback', async () => {
  const calls = [];
  const child = { pid: 4242, kill: () => { calls.push(['child']); return true; } };
  const sent = await signalProcessTree(child, 'SIGTERM', {
    windows: false,
    processKill: (pid, signal) => { calls.push([pid, signal]); },
  });
  assert.equal(sent, true);
  assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
});

test('POSIX tree signaling falls back to the direct child when no group exists', async () => {
  const calls = [];
  const child = { pid: 4242, kill: (signal) => { calls.push(['child', signal]); return true; } };
  const sent = await signalProcessTree(child, 'SIGKILL', {
    windows: false,
    processKill: () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); },
  });
  assert.equal(sent, true);
  assert.deepEqual(calls, [['child', 'SIGKILL']]);
});

test('POSIX tree signaling terminates a detached wrapper and its descendant', {
  skip: process.platform === 'win32',
}, async () => {
  const wrapper = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
    'console.log(child.pid)',
    'setInterval(()=>{},1000)',
  ].join(';')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const [chunk] = await once(wrapper.stdout, 'data');
  const descendantPid = Number(String(chunk).trim());
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  try {
    const wrapperClosed = once(wrapper, 'close');
    assert.equal(await signalProcessTree(wrapper, 'SIGTERM'), true);
    await wrapperClosed;
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      try { process.kill(descendantPid, 0); } catch { gone = true; }
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(gone, true, 'descendant process was reaped after the group signal');
  } finally {
    try { process.kill(-wrapper.pid, 'SIGKILL'); } catch { /* already stopped */ }
    try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already stopped */ }
  }
});

test('Windows tree signaling terminates a wrapper and its live descendant', {
  skip: process.platform !== 'win32',
}, async () => {
  const wrapper = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
    'console.log(child.pid)',
    'setInterval(()=>{},1000)',
  ].join(';')], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [chunk] = await once(wrapper.stdout, 'data');
  const descendantPid = Number(String(chunk).trim());
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  try {
    // Register before awaiting taskkill: older Node releases can emit `close`
    // while signalProcessTree is still awaiting taskkill.exe.
    const wrapperClosed = once(wrapper, 'close');
    assert.equal(await signalProcessTree(wrapper, 'SIGTERM'), true);
    let closeTimer;
    try {
      await Promise.race([
        wrapperClosed,
        new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error('wrapper did not close')), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(closeTimer);
    }
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH|no such process/i);
  } finally {
    if (wrapper.exitCode == null) wrapper.kill('SIGKILL');
    try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already stopped */ }
  }
});
