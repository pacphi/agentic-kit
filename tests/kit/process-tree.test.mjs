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
