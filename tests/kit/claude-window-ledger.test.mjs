import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readClaudeWindowLog, statClaudeWindowLedger, windowAt, claudeWindowLedgerPath,
  WINDOW_LEAD_TOLERANCE_MS, MAX_LEDGER_BYTES,
} from '../../src/lib/claude-window-ledger.mjs';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function configDirWith(sessionId, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-window-reader-'));
  const ledger = path.join(dir, 'claude-context-windows');
  fs.mkdirSync(ledger, { recursive: true });
  if (content !== undefined) {
    fs.writeFileSync(path.join(ledger, `${sessionId}.json`), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('readClaudeWindowLog returns the validated, time-ordered log', () => {
  const dir = configDirWith(SID, [
    { t: 2000, size: 200000, model: 'm2' }, { t: 1000, size: 1000000, model: 'm1' },
  ]);
  assert.deepEqual(readClaudeWindowLog(dir, SID), [
    { t: 1000, size: 1000000, model: 'm1' }, { t: 2000, size: 200000, model: 'm2' },
  ]);
});

test('readClaudeWindowLog is null for an absent, corrupt, non-array, empty or oversized ledger', () => {
  assert.equal(readClaudeWindowLog(configDirWith(SID), SID), null, 'absent');
  assert.equal(readClaudeWindowLog(configDirWith(SID, '{oops'), SID), null, 'corrupt');
  assert.equal(readClaudeWindowLog(configDirWith(SID, { t: 1, size: 5 }), SID), null, 'not an array');
  assert.equal(readClaudeWindowLog(configDirWith(SID, []), SID), null, 'empty');
  const big = [{ t: 1, size: 1000, model: 'x'.repeat(MAX_LEDGER_BYTES) }];
  assert.equal(readClaudeWindowLog(configDirWith(SID, big), SID), null, 'oversized');
  assert.equal(readClaudeWindowLog('/nonexistent-dir-for-ak-test', SID), null, 'missing config dir');
});

test('readClaudeWindowLog drops malformed entries instead of guessing', () => {
  const dir = configDirWith(SID, [
    { t: 1000, size: 1000000, model: 'ok' }, { t: 'x', size: 5 }, { t: 2000, size: -1 },
    { t: 3000, size: 0 }, null, 'str', { t: 4000, size: 200000 },
  ]);
  assert.deepEqual(readClaudeWindowLog(dir, SID), [
    { t: 1000, size: 1000000, model: 'ok' }, { t: 4000, size: 200000, model: null },
  ]);
  assert.equal(readClaudeWindowLog(configDirWith(SID, [{ t: 'x', size: 5 }]), SID), null, 'nothing valid left');
});

test('unsafe session ids never resolve to a path or a read', () => {
  const dir = configDirWith(SID, [{ t: 1, size: 100 }]);
  fs.writeFileSync(path.join(dir, 'secret.json'), JSON.stringify([{ t: 1, size: 999 }]));
  for (const id of ['../secret', '..', '.', 'a/b', 'a\\b', '', 'a.b', 'x'.repeat(200), null, undefined, 7]) {
    assert.equal(claudeWindowLedgerPath(dir, id), null, String(id));
    assert.equal(readClaudeWindowLog(dir, id), null, String(id));
    assert.equal(statClaudeWindowLedger(dir, id), null, String(id));
  }
});

test('a subagent id (parent/stem) has no ledger by construction', () => {
  const dir = configDirWith(SID, [{ t: 1, size: 100 }]);
  assert.equal(readClaudeWindowLog(dir, `${SID}/agent-abc`), null);
});

test('statClaudeWindowLedger reports mtime+size, or null when absent', () => {
  const dir = configDirWith(SID, [{ t: 1, size: 100 }]);
  const st = statClaudeWindowLedger(dir, SID);
  assert.equal(typeof st.mtimeMs, 'number');
  assert.ok(st.size > 0);
  assert.equal(statClaudeWindowLedger(configDirWith(SID), SID), null);
});

const LOG = [
  { t: 10_000, size: 200000, model: 'a' },
  { t: 50_000, size: 1000000, model: 'b' },
  { t: 90_000, size: 200000, model: 'a' },
];

test('windowAt: the latest entry with t <= message time is in effect', () => {
  assert.equal(windowAt(LOG, 10_000), 200000, 'exactly on an entry');
  assert.equal(windowAt(LOG, 49_999), 200000);
  assert.equal(windowAt(LOG, 50_000), 1000000, 'the change applies from its own timestamp');
  assert.equal(windowAt(LOG, 89_999), 1000000);
  assert.equal(windowAt(LOG, 5_000_000), 200000, 'after the last entry the last window still holds');
});

test('windowAt: a message before the first entry uses the first entry only within the lead tolerance', () => {
  const late = [{ t: 1_000_000, size: 1000000, model: 'a' }];
  assert.equal(windowAt(late, 1_000_000 - WINDOW_LEAD_TOLERANCE_MS), 1000000, 'boundary is inclusive');
  assert.equal(windowAt(late, 1_000_000 - WINDOW_LEAD_TOLERANCE_MS - 1), null, 'earlier than tolerance: unknown, never a guess');
  assert.equal(windowAt(late, 0), null);
});

test('windowAt: unknown inputs yield null', () => {
  assert.equal(windowAt(null, 1), null);
  assert.equal(windowAt([], 1), null);
  assert.equal(windowAt(LOG, NaN), null);
  assert.equal(windowAt(LOG, undefined), null);
  assert.equal(windowAt(LOG, null), null);
});
