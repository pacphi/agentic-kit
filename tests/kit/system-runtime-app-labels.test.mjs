import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/commands/system.mjs';
import { captureLog } from './helpers/home-sandbox.mjs';

const measured = (value) => ({ status: 'measured', value, partial: false });
const unknown = (reason) => ({ status: 'unknown', reason });

test('ak system renders application, coding-agent host, service, and unknown runtime rows', async () => {
  const row = (pid, host, application, source) => ({ pid, host, application, source,
    cpuPercent: measured(2), rssBytes: measured(1000), uptimeMs: measured(2000) });
  const processes = [
    row(101, null, 'Claude Desktop', measured({ kind: 'desktop-app', label: 'Claude Desktop' })),
    row(102, 'claude', null, measured({ kind: 'repository', label: 'work' })),
    row(103, null, 'ChatGPT desktop app', measured({ kind: 'desktop-app', label: 'ChatGPT desktop app' })),
    row(104, 'codex', null, measured({ kind: 'host-service', label: 'Codex app service' })),
    row(105, null, null, unknown('not attributable — access denied')),
  ];
  const snapshot = { platform: 'darwin', generatedAt: 'now', snapshot: { present: false, reason: 'not scanned' },
    runtime: { ephemeral: true, processes: measured(processes), totals: {
      processCount: measured(5), rssBytes: measured(5000), cpuPercent: measured(10),
    }, daemons: { count: measured(0), staleCount: measured(0) } } };
  const { result, out } = await captureLog(() => run({ flags: { json: false }, deps: {
    collector: { read: async () => snapshot }, now: () => 0,
  } }));
  assert.equal(result, 0);
  assert.match(out, /CODING-AGENT HOST \/ DESKTOP APPLICATION/);
  assert.match(out, /Claude Desktop/);
  assert.match(out, /ChatGPT desktop app/);
  assert.match(out, /Codex app service/);
  assert.match(out, /work/);
  assert.match(out, /Unknown process/);
  assert.match(out, /unattributed: not attributable — access denied/);
  assert.match(out, /processes\s+5/);
  assert.match(out, /memory \(RSS\)\s+5\.00 KB/);
});
