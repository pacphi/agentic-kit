import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  canonicalJson,
  createToolLoopGuard,
  RufloHooks,
  projectHookEnv,
} from '../../src/templates/opencode-ruflo-hooks.js';

test('OpenCode lifecycle hooks pin Ruflo memory to their project directory', () => {
  const directory = path.resolve('/work/project');
  assert.deepEqual(projectHookEnv(directory, { KEEP: 'yes' }), {
    KEEP: 'yes',
    CLAUDE_FLOW_DB_PATH: path.join(directory, '.swarm', 'memory.db'),
  });
});

function complete(guard, {
  sessionID = 'ses_1',
  callID,
  tool = 'inspect_file',
  args = { path: '/tmp/a' },
  output = 'same result',
}) {
  const input = { sessionID, callID, tool };
  const verdict = guard.before(input, args);
  assert.equal(verdict.blocked, false);
  guard.after(input, output);
}

test('canonicalJson treats recursively reordered object keys as equivalent', () => {
  assert.equal(
    canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test('tool loop guard detects identical completed calls across assistant turns', () => {
  const guard = createToolLoopGuard({ threshold: 3 });
  complete(guard, { callID: 'call_1' });
  complete(guard, { callID: 'call_2' });
  complete(guard, { callID: 'call_3' });

  const verdict = guard.before(
    { sessionID: 'ses_1', callID: 'call_4', tool: 'inspect_file' },
    { path: '/tmp/a' },
  );
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.count, 3);
});

test('tool loop guard canonicalizes argument keys before comparing calls', () => {
  const guard = createToolLoopGuard({ threshold: 2 });
  complete(guard, {
    callID: 'call_1',
    args: { path: '/tmp/a', options: { line: 1, column: 2 } },
  });
  complete(guard, {
    callID: 'call_2',
    args: { options: { column: 2, line: 1 }, path: '/tmp/a' },
  });
  const verdict = guard.before(
    { sessionID: 'ses_1', callID: 'call_3', tool: 'inspect_file' },
    { options: { line: 1, column: 2 }, path: '/tmp/a' },
  );
  assert.equal(verdict.blocked, true);
});

test('different tool arguments or output reset the trailing streak', () => {
  const guard = createToolLoopGuard({ threshold: 2 });
  complete(guard, { callID: 'call_1' });
  complete(guard, { callID: 'call_2', args: { path: '/tmp/b' } });
  complete(guard, { callID: 'call_3', output: 'first result' });
  complete(guard, { callID: 'call_4', output: 'changed result' });

  const verdict = guard.before(
    { sessionID: 'ses_1', callID: 'call_5', tool: 'inspect_file' },
    { path: '/tmp/a' },
  );
  assert.equal(verdict.blocked, false);
});

test('new user message reset and session isolation prevent false positives', () => {
  const guard = createToolLoopGuard({ threshold: 2 });
  complete(guard, { callID: 'call_1' });
  complete(guard, { callID: 'call_2' });
  guard.reset('ses_1');

  assert.equal(guard.before(
    { sessionID: 'ses_1', callID: 'call_3', tool: 'inspect_file' },
    { path: '/tmp/a' },
  ).blocked, false);
  assert.equal(guard.before(
    { sessionID: 'ses_2', callID: 'call_1', tool: 'inspect_file' },
    { path: '/tmp/a' },
  ).blocked, false);
});

test('deployed hook aborts the session before a fourth identical completed call', async () => {
  const aborted = [];
  const hooks = await RufloHooks({
    client: {
      app: { log: async () => {} },
      session: { abort: async (request) => { aborted.push(request.path.id); } },
    },
  });
  for (let i = 1; i <= 3; i += 1) {
    const input = { sessionID: 'ses_live', callID: `call_${i}`, tool: 'inspect_file' };
    await hooks['tool.execute.before'](input, { args: { path: '/tmp/a' } });
    await hooks['tool.execute.after'](
      { ...input, args: { path: '/tmp/a' } },
      { title: 'inspect', output: 'same result', metadata: {} },
    );
  }

  await assert.rejects(
    hooks['tool.execute.before'](
      { sessionID: 'ses_live', callID: 'call_4', tool: 'inspect_file' },
      { args: { path: '/tmp/a' } },
    ),
    /Probable doom loop stopped after 3 identical completed calls/,
  );
  assert.deepEqual(aborted, ['ses_live']);
});
