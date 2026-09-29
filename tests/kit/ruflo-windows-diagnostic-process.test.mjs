import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createDiagnosticScope } from '../live/ruflo-windows-diagnostic-process.mjs';

function fakeChild({ closes = true, code = 0 } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    unreferenced: false, killed: false });
  child.unref = () => { child.unreferenced = true; };
  child.kill = () => {
    child.killed = true;
    if (closes) queueMicrotask(() => { child.exitCode = code; child.emit('close', code, null); });
  };
  return child;
}

function scopeFor(spawnFn) {
  let released = false;
  const scope = createDiagnosticScope({ spawnFn, platform: 'win32',
    killTimeoutMs: 20, closeTimeoutMs: 20,
    acquireHold: () => ({}), releaseHold: () => { released = true; } });
  return { scope, released: () => released };
}

test('every diagnostic role passes the exact environment, excluding parent-only credentials', async () => {
  process.env.AK_DIAGNOSTIC_PARENT_ONLY = 'synthetic-do-not-inherit';
  const env = { PATH: 'fixture-only' };
  const seen = [];
  let active;
  const { scope } = scopeFor((command, _args, options) => {
    seen.push({ command, env: options.env });
    const child = fakeChild();
    if (command === 'taskkill.exe') queueMicrotask(() => { active.kill(); child.kill(); });
    else active = child;
    return child;
  });
  try {
    for (const command of ['version', 'legacy', 'initialize']) {
      const r = await scope.launch({ command, args: [] }, { env, timeoutMs: 10 });
      assert.equal(r.cleanupComplete, true);
    }
    assert.deepEqual(seen.map((x) => x.command), ['version', 'taskkill.exe', 'legacy', 'taskkill.exe', 'initialize', 'taskkill.exe']);
    for (const entry of seen) {
      assert.strictEqual(entry.env, env);
      assert.equal(entry.env.AK_DIAGNOSTIC_PARENT_ONLY, undefined);
    }
    assert.equal(scope.release(), true);
  } finally { delete process.env.AK_DIAGNOSTIC_PARENT_ONLY; }
});

for (const failure of ['nonzero', 'spawn-error', 'stall']) {
  test(`taskkill ${failure} always disposes handles and retains uncertainty`, async () => {
    const children = [];
    const { scope, released } = scopeFor((command) => {
      const child = fakeChild({ closes: false }); children.push(child);
      if (command === 'taskkill.exe' && failure !== 'stall') queueMicrotask(() => {
        if (failure === 'spawn-error') child.emit('error', new Error('ENOENT'));
        child.exitCode = 1; child.emit('close', 1, null);
      });
      return child;
    });
    const started = Date.now();
    const r = await scope.launch({ command: 'initialize', args: [] }, { env: {}, timeoutMs: 10 });
    assert.equal(r.cleanupComplete, false);
    assert.ok(Date.now() - started < 1000);
    assert.equal(children[0].killed, true, 'direct-child fallback attempted');
    assert.equal(children[0].unreferenced, true);
    assert.equal(children[0].stdout.destroyed, true);
    assert.equal(children[0].stderr.destroyed, true);
    assert.equal(children[0].stdin.destroyed, true);
    assert.equal(scope.release(), false);
    assert.equal(released(), false);
    if (failure === 'stall') assert.equal(children[1].unreferenced, true);
  });
}

for (const command of ['version', 'legacy']) {
  test(`${command} cleanup failure cannot be cleared by a later successful launch`, async () => {
    const { scope, released } = scopeFor((cmd) => {
      const child = fakeChild();
      if (cmd === 'later' || cmd === 'taskkill.exe') queueMicrotask(() => {
        child.exitCode = cmd === 'taskkill.exe' ? 1 : 0; child.emit('close', child.exitCode, null);
      });
      return child;
    });
    assert.equal((await scope.launch({ command, args: [] }, { env: {}, timeoutMs: 10 })).cleanupComplete, false);
    assert.equal((await scope.launch({ command: 'later', args: [] }, { env: {}, timeoutMs: 10 })).cleanupComplete, true);
    assert.equal(scope.release(), false);
    assert.equal(released(), false);
  });
}

test('real version, legacy, initialize and taskkill children cannot see a parent-only sentinel', async () => {
  const key = 'AK_DIAGNOSTIC_PARENT_ONLY';
  const previous = process.env[key];
  process.env[key] = 'synthetic-do-not-inherit';
  const env = { AK_DIAGNOSTIC_ALLOWED: 'yes' };
  const observed = [];
  const scope = createDiagnosticScope({
    platform: 'win32', acquireHold: () => ({}), releaseHold: () => {},
    killTimeoutMs: 1000, closeTimeoutMs: 1000,
    spawnFn: (command, args, options) => {
      const payload = 'process.stdout.write(JSON.stringify({allowed:process.env.AK_DIAGNOSTIC_ALLOWED,sentinel:process.env.AK_DIAGNOSTIC_PARENT_ONLY}));';
      const code = command === 'taskkill.exe'
        ? `${payload}process.kill(${Number(args[1])},'SIGKILL');`
        : `${payload}${command === 'initialize' ? 'setInterval(()=>{},1000);' : ''}`;
      const child = spawn(process.execPath, ['-e', code], { ...options, env: options.env });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('close', () => observed.push({ command, ...JSON.parse(output) }));
      return child;
    },
  });
  try {
    for (const command of ['version', 'legacy', 'initialize']) {
      const result = await scope.launch({ command, args: [] }, { env, timeoutMs: 500 });
      assert.equal(result.cleanupComplete, true);
    }
    assert.deepEqual(observed.map((x) => x.command).sort(), ['initialize', 'legacy', 'taskkill.exe', 'version']);
    for (const result of observed) {
      assert.equal(result.allowed, 'yes');
      assert.equal(result.sentinel, undefined);
    }
    assert.equal(scope.release(), true);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});
