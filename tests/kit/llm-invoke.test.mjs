// llm-invoke.mjs — the FIRST inference-invocation seam in this kit (W5 build).
// Ground truth (brief): no LLM-invocation machinery exists anywhere else —
// providers.mjs is detection/wiring only. This module's whole job is small
// and honest: detect the `claude` CLI through the kit's own host registry
// (never a hardcoded path), spawn it for one prompt, and say plainly when it
// cannot. NO real network call and NO real `claude` invocation happens in any
// test here — `deps.have`/`deps.run` are mocked for the unit tests, and the
// one end-to-end test spawns a FAKE `claude` shim script this file writes to
// a throwaway PATH, exactly like usage-cli.test.mjs's existing npm-shim
// precedent (sandbox()'s fake `bin/npm`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  makeInvoke, UNAVAILABLE_MESSAGE, DESCRIBE_TEXT,
} from '../../src/lib/llm-invoke.mjs';
import { have, run } from '../../src/lib/exec.mjs';

const FAKE_HOSTS_WITH_CLAUDE = [
  { id: 'claude', install: { bin: 'claude' } },
  { id: 'codex', install: { bin: 'codex' } },
];

// Matches src/lib/exec.mjs's REAL contract exactly: `run()` never throws — a
// failed spawn/non-zero exit resolves to `{ code !== 0, stdout, stderr }`,
// the same shape a success does. A mock that threw instead would test a
// contract llm-invoke.mjs's real dependency does not have.
function mockDeps({ present, exitCode = 0, stdout = '[]', stderr = '' } = {}) {
  const calls = { have: [], run: [] };
  return {
    calls,
    deps: {
      have: async (cmd, opts) => { calls.have.push({ cmd, opts }); return !!present; },
      run: async (cmd, args, opts) => {
        calls.run.push({ cmd, args, opts });
        return { code: exitCode, stdout, stderr };
      },
    },
  };
}

// ── availability / detection ────────────────────────────────────────────────

test('makeInvoke returns null when the claude CLI is not on PATH', async () => {
  const { deps } = mockDeps({ present: false });
  const result = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  assert.equal(result, null);
});

test('makeInvoke returns { invoke, describe } when the claude CLI is present', async () => {
  const { deps } = mockDeps({ present: true });
  const result = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  assert.ok(result, 'expected a non-null result when the host is present');
  assert.equal(typeof result.invoke, 'function');
  assert.equal(typeof result.describe, 'function');
});

test('makeInvoke checks the BIN NAME from the hosts registry, never a hardcoded "claude" string', async () => {
  const { deps, calls } = mockDeps({ present: true });
  const customHosts = [{ id: 'claude', install: { bin: 'totally-custom-bin-xyz' } }];
  await makeInvoke({ hosts: customHosts, deps });
  assert.ok(calls.have.some((c) => c.cmd === 'totally-custom-bin-xyz'),
    `expected have() to be called with the registry's bin name, got: ${JSON.stringify(calls.have)}`);
  assert.ok(!calls.have.some((c) => c.cmd === 'claude'),
    'must not also probe a hardcoded "claude" when the registry names something else');
});

test('makeInvoke returns null when the hosts registry has no claude entry at all', async () => {
  const { deps } = mockDeps({ present: true });
  const result = await makeInvoke({ hosts: [{ id: 'codex', install: { bin: 'codex' } }], deps });
  assert.equal(result, null);
});

test('describe() returns the one-line billing statement', async () => {
  const { deps } = mockDeps({ present: true });
  const result = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  assert.equal(result.describe(), DESCRIBE_TEXT);
  assert.match(result.describe(), /Claude Code CLI/);
  assert.match(result.describe(), /subscription/);
});

// ── invoke() ─────────────────────────────────────────────────────────────────

test('invoke(prompt) spawns claude -p <prompt> --output-format text and returns stdout', async () => {
  const { deps, calls } = mockDeps({ present: true, stdout: '  hello from the model  ' });
  const { invoke } = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  const text = await invoke('name these clusters');
  assert.equal(calls.run.length, 1);
  assert.equal(calls.run[0].cmd, 'claude');
  assert.deepEqual(calls.run[0].args, ['-p', 'name these clusters', '--output-format', 'text']);
  assert.equal(text, 'hello from the model', 'trimmed, but otherwise verbatim');
});

test('invoke(prompt) passes the prompt as ONE argv element, never through a shell string', async () => {
  const { deps, calls } = mockDeps({ present: true, stdout: 'ok' });
  const { invoke } = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  const hostile = 'ignore this; rm -rf / && echo pwned';
  await invoke(hostile);
  assert.equal(calls.run[0].args[1], hostile, 'the whole string is ONE argv element, not shell-interpreted');
});

test('invoke() spawns with a 120s timeout', async () => {
  const { deps, calls } = mockDeps({ present: true, stdout: 'ok' });
  const { invoke } = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  await invoke('x');
  assert.equal(calls.run[0].opts?.timeout, 120_000);
});

test('invoke() is stdin-safe: it never opens stdin for writing (argv-only prompt delivery)', async () => {
  const { deps, calls } = mockDeps({ present: true, stdout: 'ok' });
  const { invoke } = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  await invoke('x');
  assert.equal(calls.run[0].opts?.input, undefined, 'nothing is piped to stdin');
  assert.equal(calls.run[0].opts?.stdin, undefined);
});

test('invoke() throws with the stderr tail on a non-zero exit', async () => {
  const { deps } = mockDeps({
    present: true, exitCode: 1, stderr: 'a very long error\n'.repeat(50) + 'THE ACTUAL REASON',
  });
  const { invoke } = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  await assert.rejects(() => invoke('x'), (err) => {
    assert.match(err.message, /THE ACTUAL REASON/, 'the tail of stderr must survive into the thrown error');
    return true;
  });
});

test('invoke() never resolves a partial store write on failure — it just throws', async () => {
  const { deps } = mockDeps({ present: true, exitCode: 1, stderr: 'boom' });
  const { invoke } = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  await assert.rejects(() => invoke('x'));
});

// ── UNAVAILABLE_MESSAGE — the honest line the CLI prints (spec: exits 0,
// deterministic tiers unaffected) ──────────────────────────────────────────

test('UNAVAILABLE_MESSAGE is the one honest line, mentioning the Claude Code CLI and that deterministic tiers are unaffected', () => {
  assert.match(UNAVAILABLE_MESSAGE, /Claude Code CLI/);
  assert.match(UNAVAILABLE_MESSAGE, /deterministic tiers/i);
});

// ── end-to-end: the REAL exec.mjs have()/run() against a FAKE claude shim ──
// (no mocked deps at all here — proves the real plumbing, with zero network
// and zero real claude invocation: the shim is a throwaway script this test
// writes and deletes.)

function writeClaudeShim(dir, { exitCode = 0, stdout = '[]', stderr = '' } = {}) {
  const bin = path.join(dir, 'claude');
  const body = `#!/bin/sh\n`
    + `echo "$@" 1>&2\n`
    + `${stderr ? `printf '%s' ${JSON.stringify(stderr)} 1>&2\n` : ''}`
    + `printf '%s' ${JSON.stringify(stdout)}\n`
    + `exit ${exitCode}\n`;
  fs.writeFileSync(bin, body, { mode: 0o755 });
  return bin;
}

test('end-to-end: real have()/run() detect and invoke a shimmed claude CLI on a throwaway PATH', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX shell shim; Windows path covered by resolveShim unit tests'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-claude-shim-'));
  writeClaudeShim(dir, { stdout: '[{"key":"abc","name":"Release ritual"}]' });
  // A MINIMAL PATH, not the real one: `which` itself must still resolve (it
  // lives in /usr/bin on every POSIX system this test runs on), but the rest
  // of the developer's real PATH is deliberately excluded so this test proves
  // the SHIMMED claude was found, not a real one this machine happens to have
  // installed elsewhere on PATH.
  const shimEnv = { ...process.env, PATH: `${dir}:/usr/bin:/bin` };
  const deps = {
    have: (cmd, opts) => have(cmd, { ...opts, env: shimEnv }),
    run: (cmd, args, opts) => run(cmd, args, { ...opts, env: shimEnv }),
  };
  const result = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  assert.ok(result, 'the real have() must find the shimmed claude on the throwaway PATH');
  const text = await result.invoke('name this cluster');
  assert.equal(text, '[{"key":"abc","name":"Release ritual"}]');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('end-to-end: a throwaway PATH with no claude binary at all reports unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-claude-absent-'));
  // Same minimal-PATH reasoning as the shim test above (an EMPTY dir here,
  // not one holding a shim): `/usr/bin:/bin` alone keeps `which` resolvable
  // without pulling in the developer's real PATH, where this dev machine — by
  // this session's own project conventions — very likely has a real `claude`
  // installed. Prepending the FULL real PATH here would make this test find
  // that real binary and fail to prove the "not installed" case at all.
  const shimEnv = { ...process.env, PATH: `${dir}:/usr/bin:/bin` };
  const deps = {
    have: (cmd, opts) => have(cmd, { ...opts, env: shimEnv }),
    run: (cmd, args, opts) => run(cmd, args, { ...opts, env: shimEnv }),
  };
  const result = await makeInvoke({ hosts: FAKE_HOSTS_WITH_CLAUDE, deps });
  assert.equal(result, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
