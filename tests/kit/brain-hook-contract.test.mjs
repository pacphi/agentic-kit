import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brainHookContract } from '../../src/lib/brain-hook-contract.mjs';

const fixture = () => ({
  SessionStart: [{ matcher: 'startup|resume|clear|compact|fork', hooks: [{ type: 'command',
    command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" session-start || true', timeout: 5 }] }],
  Stop: [{ matcher: '*', hooks: [{ type: 'command',
    command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" continuation-gate || true', timeout: 10 }] }],
});

test('Brain continuity is qualified only for the exact reviewed release', () => {
  assert.equal(brainHookContract('4.3.17', fixture()).qualified, true);
  assert.equal(brainHookContract('4.3.16', {}).qualified, true);
  for (const version of ['4.3.16', '4.3.18', '4.3.17-beta.1', null]) {
    assert.equal(brainHookContract(version, fixture()).qualified, false);
  }
  assert.equal(brainHookContract('4.3.17', {}).qualified, false);
});

test('continuity qualification rejects altered or extra behavior', () => {
  const changes = [
    (h) => { h.PreToolUse = []; },
    (h) => { h.Stop.push(h.Stop[0]); },
    (h) => { h.Stop[0].hooks.push(h.Stop[0].hooks[0]); },
    (h) => { h.Stop[0].hooks[0].command += '; arbitrary-command'; },
    (h) => { h.Stop[0].hooks[0].timeout = 99; },
    (h) => { h.Stop[0].hooks[0].type = 'prompt'; },
    (h) => { h.Stop[0].hooks[0].async = true; },
    (h) => { h.SessionStart[0].matcher = '*'; },
    (h) => { h.Stop[0].extra = true; },
  ];
  for (const change of changes) {
    const hooks = fixture(); change(hooks);
    assert.equal(brainHookContract('4.3.17', hooks).qualified, false);
  }
});
