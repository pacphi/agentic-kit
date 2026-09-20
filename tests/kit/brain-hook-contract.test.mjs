import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brainHookContract } from '../../src/lib/brain-hook-contract.mjs';

const fixture = () => ({
  SessionStart: [{ matcher: 'startup|resume|clear|compact|fork', hooks: [{ type: 'command',
    command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" session-start || true', timeout: 5 }] }],
  Stop: [{ matcher: '*', hooks: [{ type: 'command',
    command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" continuation-gate || true', timeout: 10 }] }],
});

test('Brain continuity is qualified by the exact reviewed hook contract', () => {
  for (const version of ['4.3.17', '4.3.18', '4.3.19', '4.3.17-beta.1', null]) {
    assert.equal(brainHookContract(version, fixture()).qualified, true);
  }
  assert.equal(brainHookContract('4.3.16', {}).qualified, true);
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

// Independent copy of the reviewed 4.3.26 lifecycle declaration (upstream plugin/hooks/hooks.json).
const shim = (action, timeout, tail = ' || true') => ({ type: 'command',
  command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ${action}${tail}`, timeout });
const lifecycle = () => ({
  SessionStart: [{ matcher: 'startup|resume|clear|compact|fork', hooks: [shim('session-start', 5)] }],
  UserPromptSubmit: [{ matcher: '*', hooks: [
    shim('unprompted-speech UserPromptSubmit', 3, ''), shim('ground-ruvnet', 10), shim('grounding-turn-mark', 5)] }],
  PreToolUse: [{ matcher: '^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$', hooks: [shim('decision-gate write', 5, '')] }],
  PostToolUse: [{ matcher: '^(?:.*__)?search_ruvnet$', hooks: [shim('grounding-stamp', 5)] }],
  Stop: [{ matcher: '*', hooks: [
    shim('continuation-gate', 10), shim('session-snapshot Stop', 10), shim('grounding-turn-gate', 10)] }],
  PreCompact: [{ matcher: '*', hooks: [shim('session-snapshot PreCompact', 10)] }],
  SessionEnd: [{ matcher: '*', hooks: [shim('session-snapshot SessionEnd', 10)] }],
});

test('Brain lifecycle plane is qualified by its exact reviewed hook contract', () => {
  const result = brainHookContract('4.3.26', lifecycle());
  assert.equal(result.qualified, true);
  assert.equal(result.contract, '4.3.26-lifecycle');
  assert.equal(brainHookContract('4.3.27', lifecycle()).qualified, true);
});

test('lifecycle qualification rejects altered or extra behavior', () => {
  const changes = [
    (h) => { h.PostToolUse = []; },
    (h) => { h.SubagentStop = h.Stop; },
    (h) => { h.PreToolUse[0].matcher = '*'; },
    (h) => { h.PreToolUse[0].hooks[0].command += ' || true'; },
    (h) => { h.Stop[0].hooks.pop(); },
    (h) => { h.UserPromptSubmit[0].hooks[1].command += '; arbitrary-command'; },
    (h) => { h.SessionEnd[0].hooks[0].timeout = 99; },
    (h) => { h.SessionEnd[0].hooks[0].async = true; },
  ];
  for (const change of changes) {
    const hooks = lifecycle(); change(hooks);
    assert.equal(brainHookContract('4.3.26', hooks).qualified, false);
  }
});
