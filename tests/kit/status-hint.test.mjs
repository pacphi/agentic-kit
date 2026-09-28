// `hintLines(rows, worst)` — the bare `ak` hint's content, pure so it can be
// asserted on directly instead of through captured stdout. A row at warn/fail
// with no fix at all (neither `ak sync` nor a manual step touches it) must
// be counted on its own: a set of ONLY no-fix rows must never fall through
// to "0 item(s) need attention — run: ak sync", which is nonsensical
// (nothing for sync to do).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hintLines, worstLevel } from '../../src/commands/status.mjs';
import { row } from '../../src/commands/status/row.mjs';

// output.mjs only colors a real TTY (`useColor = process.stdout.isTTY && …`),
// and the test runner's stdout never is one, so `hintLines` returns plain
// text here — no ANSI to strip.
const text = (lines) => lines.join('\n');

test('all healthy: one line, no sync/manual/no-fix framing', () => {
  const rows = [row('versions', 'ok', 'up to date')];
  const out = text(hintLines(rows, worstLevel(rows)));
  assert.match(out, /all healthy — nothing to do/);
  assert.doesNotMatch(out, /ak sync/);
  assert.doesNotMatch(out, /manual/);
  assert.doesNotMatch(out, /no automatic fix/);
});

test('only fix:null warnings: no automatic fix — no "ak sync" suggestion', () => {
  const rows = [
    row('security', 'warn', 'defend flags unavailable', null),
    row('mcp', 'fail', 'codex mcp unreachable', null),
  ];
  const worst = worstLevel(rows);
  const out = text(hintLines(rows, worst));
  assert.match(out, /2 item\(s\) need attention and have no automatic fix — see the rows above/);
  assert.doesNotMatch(out, /ak sync/);
  assert.doesNotMatch(out, /manual/);
});

test('only manual fixes, nothing else: existing message, no no-fix note', () => {
  const rows = [row('mcp', 'warn', 'ak not on PATH', 'put `ak` on PATH, then run `ak sync`', { repair: 'manual' })];
  const out = text(hintLines(rows, worstLevel(rows)));
  assert.match(out, /1 item\(s\) need attention — run the "→ manual:" step\(s\) above yourself; ak sync does not perform them/);
  assert.doesNotMatch(out, /more have no fix/);
});

test('manual fixes plus no-fix rows: the manual message gains a no-fix count', () => {
  const rows = [
    row('mcp', 'warn', 'ak not on PATH', 'put `ak` on PATH, then run `ak sync`', { repair: 'manual' }),
    row('security', 'warn', 'defend flags unavailable', null),
  ];
  const out = text(hintLines(rows, worstLevel(rows)));
  assert.match(out, /1 item\(s\) need attention — run the "→ manual:" step\(s\) above yourself; ak sync does not perform them · 1 more have no fix \(see above\)/);
});

test('sync-fixable rows only: the existing "run: ak sync" message, unchanged', () => {
  const rows = [row('hosts', 'fail', 'claude not installed', 'sync installs @anthropic-ai/claude-code')];
  const out = text(hintLines(rows, worstLevel(rows)));
  assert.match(out, /1 item\(s\) need attention — run: ak sync/);
  assert.doesNotMatch(out, /more have no fix/);
  assert.doesNotMatch(out, /more need a manual step/);
});

test('mixed: sync-fixable and no-fix rows — both counts appear', () => {
  const rows = [
    row('hosts', 'fail', 'claude not installed', 'sync installs @anthropic-ai/claude-code'),
    row('security', 'warn', 'defend flags unavailable', null),
    row('mcp', 'warn', 'codex mcp flaky', null),
  ];
  const out = text(hintLines(rows, worstLevel(rows)));
  assert.match(out, /1 item\(s\) need attention — run: ak sync/);
  assert.match(out, /2 more have no fix \(see above\)/);
});

test('mixed: sync, manual and no-fix rows all present — every count shows', () => {
  const rows = [
    row('hosts', 'fail', 'claude not installed', 'sync installs @anthropic-ai/claude-code'),
    row('mcp', 'warn', 'ak not on PATH', 'put `ak` on PATH, then run `ak sync`', { repair: 'manual' }),
    row('security', 'warn', 'defend flags unavailable', null),
  ];
  const out = text(hintLines(rows, worstLevel(rows)));
  assert.match(out, /1 item\(s\) need attention — run: ak sync/);
  assert.match(out, /1 more need a manual step \(→ manual:\)/);
  assert.match(out, /1 more have no fix \(see above\)/);
});

test('the dashboard line is always the last line', () => {
  const rows = [row('versions', 'ok', 'up to date')];
  const lines = hintLines(rows, worstLevel(rows));
  assert.match(lines.at(-1), /ak dashboard — open the local web dashboard/);
});
