import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxHome, rmrf } from './helpers/home-sandbox.mjs';

const home = sandboxHome('ak-daemon-gc-rerecord');
after(() => rmrf(home));
const trapDir = path.join(home, 'no-such-bin');
const processProbeMarker = path.join(home, 'process-probe-reached');
fs.mkdirSync(trapDir, { recursive: true });
for (const command of ['ps', 'powershell']) {
  const trap = path.join(trapDir, command);
  fs.writeFileSync(trap, `#!/bin/sh\n: > '${processProbeMarker}'\nexit 99\n`, { mode: 0o755 });
}
const { run } = await import('../../src/commands/x/daemon-gc.mjs');

for (const [name, kill, killed, expected] of [
  ['successful reap', true, true, 2],
  ['failed reap', true, false, 1],
  ['list only', false, true, 1],
]) {
  test(`${name} re-records only after a successful kill`, async () => {
    const calls = [];
    let reapCalls = 0;
    const daemon = { pid: 4242, workspace: '/missing-ak-workspace', workspaceExists: false, ageSecs: 1 };
    const result = await run({
      flags: { kill, mcp: false, quiet: true },
      deps: {
        daemonLifecycle: {
          list: async opts => { calls.push(opts); return [daemon]; },
          reap: () => { reapCalls++; return [{ ...daemon, killed }]; },
        },
        mcpLifecycle: { list: async () => [], reap: () => { throw new Error('MCP reap forbidden'); } },
      },
    });
    assert.equal(result, 0);
    assert.equal(reapCalls, kill ? 1 : 0);
    assert.equal(calls.length, expected);
    if (expected === 2) assert.deepEqual(calls[1], { refresh: true, record: true, source: 'daemon-gc' });
    assert.equal(fs.existsSync(processProbeMarker), false, 'real process discovery was reached');
  });
}

test('JSON listing observes MCP transports without reaping or re-recording', async () => {
  const daemonCalls = [];
  let mcpCalls = 0;
  const oldLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await run({
      flags: { json: true, kill: true, mcp: false },
      deps: {
        daemonLifecycle: { list: async opts => { daemonCalls.push(opts); return []; }, reap: () => { throw new Error('reap forbidden'); } },
        mcpLifecycle: { list: async () => { mcpCalls++; return []; }, reap: () => { throw new Error('MCP reap forbidden'); } },
      },
    }), 0);
  } finally { console.log = oldLog; }
  assert.deepEqual(daemonCalls, [undefined]);
  assert.equal(mcpCalls, 1);
  assert.equal(fs.existsSync(processProbeMarker), false, 'real process discovery was reached');
});
