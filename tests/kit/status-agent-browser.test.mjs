// agent-browser status row: an external install outside Ruflo's range is preserved
// (ADR-0043 §3), so the row carries no sync fix; it must still say what the user can
// do (#237, audit D5). Disk-only fixture global root; nothing is installed or run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _setGlobalRootForTest } from '../../src/lib/paths.mjs';
import section from '../../src/commands/status/sections/agent-browser.mjs';

function externalPackage(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-status-agent-browser-'));
  fs.mkdirSync(path.join(root, 'agent-browser'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-browser', 'package.json'), JSON.stringify({ name: 'agent-browser', version }));
  _setGlobalRootForTest(root);
  t.after(() => { _setGlobalRootForTest(null); fs.rmSync(root, { recursive: true, force: true }); });
}

test('an out-of-range external agent-browser lists the options as a manual fix, never a sync fix', async t => {
  externalPackage(t, '0.38.1');
  const [row] = await section.collect({ cfg: { agentBrowser: true } });
  assert.equal(row.level, 'warn');
  assert.equal(row.repair, 'manual', 'a preserved external install is never planned by sync');
  assert.match(row.message, /external agent-browser 0\.38\.1 is outside Ruflo >=0\.27\.0 <0\.28\.0; preserved/);
  assert.match(row.message, /Ruflo's browser tools may not work/);
  assert.match(row.fix, /install a Ruflo-compatible agent-browser 0\.27\.x yourself/);
  assert.match(row.fix, /set agentBrowser: false in kit\.json/);
  assert.match(row.fix, /trusted browser config/, 'says what opting out gives up');
});

test('opting out reports the executor as disabled', async t => {
  externalPackage(t, '0.38.1');
  const [row] = await section.collect({ cfg: { agentBrowser: false } });
  assert.equal(row.level, 'info');
  assert.equal(row.fix, null);
});
