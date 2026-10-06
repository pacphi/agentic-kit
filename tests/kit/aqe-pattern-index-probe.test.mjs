// agentic-qe#754: the pattern index binds to a configured embedder only through
// AQE's shipped bundle, so the probe drives the installed `aqe` command
// (`hooks learn`, then `hooks search`) in a disposable project. These tests
// inject the command runner; tests/live/aqe-pattern-index-conformance.test.mjs
// runs the real thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import { probeAqePatternIndex, PATTERN_INDEX_FIX_VERSION } from '../../src/lib/aqe-pattern-index-probe.mjs';

const env = { AQE_EMBEDDER_ENDPOINT: 'http://127.0.0.1:11434', AQE_EMBEDDER_TOKEN: 'private-token' };

function installed(t, version = '3.14.8') {
  const root = tempDir('ak-pattern-index', t);
  fs.mkdirSync(path.join(root, 'dist/cli'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'agentic-qe', version, bin: { aqe: 'dist/cli/bundle.js' } }));
  fs.writeFileSync(path.join(root, 'dist/cli/bundle.js'), '');
  return root;
}

const learned = { code: 0, stderr: '', stdout: JSON.stringify({ success: true, pattern: { id: 'p-1', name: 'x' } }, null, 2) };
const found = (matchType, id = 'p-1') => ({ code: 0, stderr: '',
  stdout: JSON.stringify({ query: 'q', total: 1, patterns: [{ id, name: 'x', score: 0.9, matchType }] }, null, 2) });

/** A runner that answers learn, then search, and records every call. */
function scripted(...answers) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return answers.shift() ?? { code: 1, stdout: '', stderr: 'unexpected call' };
  };
  return { runner, calls };
}

test('the fix version is the first release that contains the pattern-index binding', () => {
  assert.equal(PATTERN_INDEX_FIX_VERSION, '3.14.5');
});

test('a release below the fix is skipped without running anything', async (t) => {
  const { runner, calls } = scripted();
  const result = await probeAqePatternIndex({ packageRoot: installed(t, '3.14.4'), env, runner });
  assert.deepEqual(result, { status: 'unavailable', reason: 'version-below-fix' });
  assert.equal(calls.length, 0);
});

test('without an endpoint nothing runs: the index cannot bind to an embedder that is not configured', async (t) => {
  const { runner, calls } = scripted();
  const result = await probeAqePatternIndex({ packageRoot: installed(t), env: {}, runner });
  assert.deepEqual(result, { status: 'unavailable', reason: 'backend-not-endpoint' });
  assert.equal(calls.length, 0);
});

test('a missing or unreadable package is unavailable, not a failure', async (t) => {
  const { runner } = scripted();
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: '/missing-aqe', env, runner }),
    { status: 'unavailable', reason: 'aqe-package-unavailable' });
  const noBin = tempDir('ak-pattern-index-nobin', t);
  fs.writeFileSync(path.join(noBin, 'package.json'), '{"version":"3.14.8"}');
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: noBin, env, runner }),
    { status: 'unavailable', reason: 'aqe-package-unavailable' });
});

test('passes when the learned pattern comes back as a vector match', async (t) => {
  const { runner, calls } = scripted(learned, found('vector'));
  const result = await probeAqePatternIndex({ packageRoot: installed(t), env, runner });
  assert.deepEqual(result, { status: 'passed' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(1, 4), ['hooks', 'learn', '--json']);
  assert.deepEqual(calls[1].args.slice(1, 4), ['hooks', 'search', '--json']);
  assert.equal(calls[0].cmd, process.execPath);
  assert.ok(calls[0].args[0].endsWith(path.join('dist', 'cli', 'bundle.js')), 'runs the installed package\'s own aqe bin');
});

test('runs in a disposable project with a private home and only the variables AQE needs, then removes it', async (t) => {
  const { runner, calls } = scripted(learned, found('vector'));
  const outer = { ...env, UNRELATED_SECRET: 'x', HOME: '/real/home', AQE_MEMORY_PATH: '/real/project/memory.db' };
  await probeAqePatternIndex({ packageRoot: installed(t), env: outer, runner });
  const sandbox = calls[0].opts.env.AQE_PROJECT_ROOT;
  assert.equal(calls[0].opts.cwd, sandbox);
  assert.equal(calls[0].opts.env.HOME, sandbox);
  assert.equal(calls[0].opts.env.AQE_EMBEDDER_ENDPOINT, env.AQE_EMBEDDER_ENDPOINT);
  assert.equal(calls[0].opts.env.AQE_EMBEDDER_TOKEN, env.AQE_EMBEDDER_TOKEN);
  for (const key of ['UNRELATED_SECRET', 'AQE_MEMORY_PATH']) assert.equal(calls[0].opts.env[key], undefined, key);
  assert.notEqual(calls[0].opts.env.HOME, '/real/home');
  assert.equal(calls[1].opts.env.AQE_PROJECT_ROOT, sandbox, 'both commands share one project');
  assert.equal(fs.existsSync(sandbox), false, 'the disposable project is removed');
});

test('the sandbox is removed even when a command fails', async (t) => {
  const { runner, calls } = scripted({ code: 1, stdout: '', stderr: 'boom' });
  await probeAqePatternIndex({ packageRoot: installed(t), env, runner });
  assert.equal(fs.existsSync(calls[0].opts.env.AQE_PROJECT_ROOT), false);
});

test('a pattern found only lexically means the index did not bind', async (t) => {
  const { runner } = scripted(learned, found('lexical'));
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: installed(t), env, runner }),
    { status: 'failed', reason: 'lexical-fallback' });
});

test('a search that does not return the learned pattern fails', async (t) => {
  const { runner } = scripted(learned, found('vector', 'someone-else'));
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: installed(t), env, runner }),
    { status: 'failed', reason: 'pattern-not-retrieved' });
});

test('a failed learn or search names its step', async (t) => {
  const failedLearn = scripted({ code: 1, stdout: '', stderr: 'boom' });
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: installed(t), env, runner: failedLearn.runner }),
    { status: 'failed', reason: 'learn-failed' });
  const refused = scripted({ code: 0, stderr: '', stdout: JSON.stringify({ success: false }) });
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: installed(t), env, runner: refused.runner }),
    { status: 'failed', reason: 'learn-failed' });
  const failedSearch = scripted(learned, { code: 1, stdout: '', stderr: 'boom' });
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: installed(t), env, runner: failedSearch.runner }),
    { status: 'failed', reason: 'search-failed' });
});

test('output that is not the expected JSON is invalid, whichever command printed it', async (t) => {
  const garbled = scripted({ code: 0, stdout: 'Pattern stored: x', stderr: '' });
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: installed(t), env, runner: garbled.runner }),
    { status: 'failed', reason: 'invalid-output' });
  const noPatterns = scripted(learned, { code: 0, stderr: '', stdout: JSON.stringify({ total: 0 }) });
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: installed(t), env, runner: noPatterns.runner }),
    { status: 'failed', reason: 'invalid-output' });
});

test('warnings printed before the JSON do not hide it', async (t) => {
  const noisy = (answer) => ({ ...answer, stdout: `[WasmLoader] degraded mode\n(node) MaxListenersExceededWarning\n${answer.stdout}` });
  const { runner } = scripted(noisy(learned), noisy(found('vector')));
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: installed(t), env, runner }), { status: 'passed' });
});

test('a command that runs out of time is a timeout', async (t) => {
  const { runner } = scripted({ code: 1, stdout: '', stderr: 'timed out after 20000ms' });
  assert.deepEqual(await probeAqePatternIndex({ packageRoot: installed(t), env, runner }),
    { status: 'failed', reason: 'timeout' });
});

test('every command is bounded and the token never appears in a result', async (t) => {
  const { runner, calls } = scripted(learned, found('lexical'));
  const result = await probeAqePatternIndex({ packageRoot: installed(t), env, runner, timeoutMs: 5_000 });
  for (const call of calls) {
    assert.equal(call.opts.timeout, 5_000);
    assert.ok(call.opts.maxBuffer > 0);
  }
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('an unbounded timeout is rejected', async (t) => {
  const { runner, calls } = scripted();
  const result = await probeAqePatternIndex({ packageRoot: installed(t), env, runner, timeoutMs: 120_000 });
  assert.deepEqual(result, { status: 'invalid-config', reason: 'timeout-must-be-between-1-and-30000-ms' });
  assert.equal(calls.length, 0);
});
