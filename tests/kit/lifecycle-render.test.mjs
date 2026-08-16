// lifecycle-render.mjs — the shape-dispatching lifecycle report renderer
// (ADR-0031 P3). Wave C security review found two BLOCKER-level bugs here:
//
//   F3 — a hostile hook's stdout (an admitted manifest's own detect/apply/
//   undo hook) can carry raw ANSI control sequences (e.g. ESC[2K erase-line
//   + ESC[1A cursor-up, followed by a forged "✓ ... in sync" line) that a
//   terminal would execute, erasing the real (failing) line and forging a
//   fake green one. Every report line must render inert.
//
//   F5 — the shared renderer hard-coded level('ok') for opencode's plugin/
//   agents lines and gated the skill line on `changed` alone, so a FAILED
//   opencode sub-surface (opencode.mjs's own adoptionBlocked path produces
//   exactly {ok:false, changed:false} for all three) rendered a green ✓ (or,
//   for skill, nothing at all) — a real regression from pre-wave sync, which
//   read every sub-result through output.mjs's reportOutcome.
//
// This file pins both fixes directly against renderApplyReport/
// renderUndoReport — no command, no subprocess, no sandbox needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderApplyReport, renderUndoReport } from '../../src/lib/adapters/lifecycle-render.mjs';

// ── F3: control-char / ANSI smuggling is stripped at the choke point ───────

test('F3: a generic admitted host\'s hostile error text (ESC[2K + ESC[1A + a forged ✓ line) renders inert, single-line, no raw ESC', () => {
  const hostile = '\x1b[2K\x1b[1A✓ opencode: totally fine — in sync\x1b[0m';
  const report = renderApplyReport('acme', {
    ok: false, changed: false, facts: null, actions: [], ownership: [], warnings: [], errors: [hostile],
  });
  assert.equal(report.lines.length, 1);
  const { text } = report.lines[0];
  assert.ok(!text.includes('\x1b'), `no raw ESC byte must survive: ${JSON.stringify(text)}`);
  assert.ok(!text.includes('\n') && !text.includes('\r'), 'no embedded newline — a single line only');
  // The escape lost its ESC byte; the rest ("[2K", "[1A", "[0m") survives only
  // as INERT, visible text glued onto the rest of the message — never
  // executed as a terminal control sequence.
  assert.ok(text.includes('[2K') && text.includes('[1A'), 'the CSI remnants must be present as plain text, not silently deleted (proves they are inert, not hidden)');
});

test('F3: control chars are stripped from opencode-shaped lines too (defence-in-depth, not just the generic path)', () => {
  const hostile = 'refused\x1b[2Khostile';
  const report = renderApplyReport('opencode', {
    changed: false,
    result: {
      oc: { ok: false, changed: false, detail: hostile },
      plugin: { ok: true, changed: false, detail: 'ok' },
      gateway: { ok: true, changed: false, detail: 'ok' },
      agents: { ok: true, changed: false, detail: 'ok' },
      skill: { ok: true, changed: false, detail: 'ok' },
      markersChanged: false,
    },
  });
  const headline = report.lines[0];
  assert.ok(!headline.text.includes('\x1b'));
  assert.ok(headline.text.includes('refused') && headline.text.includes('hostile'));
});

test('F3: a tab/newline/CR embedded in hook text collapses to spaces, not a second smuggled line', () => {
  const report = renderApplyReport('acme', {
    ok: false, changed: false, errors: ['line one\nline two\rline three\tline four'],
  });
  const { text } = report.lines[0];
  assert.ok(!text.includes('\n') && !text.includes('\r') && !text.includes('\t'));
  assert.match(text, /line one line two line three line four/);
});

// ── F5: opencode sub-surface levels reflect their OWN ok/status, never a
// hard-coded 'ok' — and a failed skill write is never silently dropped ─────

function opencodeApply({ oc, plugin, gateway, agents, skill, markersChanged = false, changed = true }) {
  return {
    changed,
    result: {
      oc: { ok: true, changed: false, detail: 'converged', ...oc },
      plugin: { ok: true, changed: false, detail: 'plugin ok', ...plugin },
      gateway: { ok: true, changed: false, detail: 'gateway ok', ...gateway },
      agents: { ok: true, changed: false, detail: 'agents ok', ...agents },
      skill: { ok: true, changed: false, detail: 'skill ok', ...skill },
      markersChanged,
    },
  };
}

test('F5: a failed opencode plugin sub-surface renders level=fail, never a hard-coded ok', () => {
  const report = renderApplyReport('opencode', opencodeApply({
    plugin: { ok: false, changed: false, detail: 'skipped because the artifact receipt ledger is malformed' },
  }));
  const pluginLine = report.lines.find((l) => l.text.startsWith('opencode plugin:'));
  assert.ok(pluginLine, `expected a plugin line; got: ${JSON.stringify(report.lines)}`);
  assert.equal(pluginLine.level, 'fail');
});

test('F5: a failed opencode agents sub-surface renders level=fail, never a hard-coded ok', () => {
  const report = renderApplyReport('opencode', opencodeApply({
    agents: { ok: false, changed: false, detail: 'adoptionBlocked' },
  }));
  const agentsLine = report.lines.find((l) => l.text.startsWith('opencode agents:'));
  assert.ok(agentsLine);
  assert.equal(agentsLine.level, 'fail');
});

test('F5: a failed opencode skill write (ok:false, changed:false — exactly opencode.mjs\'s adoptionBlocked shape) is REPORTED, not silently dropped', () => {
  const report = renderApplyReport('opencode', opencodeApply({
    skill: { ok: false, changed: false, adoptionBlocked: true, detail: 'skipped because the artifact receipt ledger is malformed' },
  }));
  const skillLine = report.lines.find((l) => l.text.startsWith('opencode skill:'));
  assert.ok(skillLine, `a failed-but-unchanged skill write must still produce a line; got: ${JSON.stringify(report.lines)}`);
  assert.equal(skillLine.level, 'fail');
});

test('F5: an unchanged, SUCCESSFUL skill write stays silent (changed:false, ok:true — no regression from the fix)', () => {
  const report = renderApplyReport('opencode', opencodeApply({
    skill: { ok: true, changed: false, detail: 'skill in sync' },
  }));
  const skillLine = report.lines.find((l) => l.text.startsWith('opencode skill:'));
  assert.equal(skillLine, undefined, 'an unchanged, healthy skill write must not print a line');
});

test('F5: a degraded (status:\'degraded\') opencode sub-surface renders level=warn, not ok or fail', () => {
  const report = renderApplyReport('opencode', opencodeApply({
    plugin: { ok: true, status: 'degraded', changed: false, detail: 'partially deployed' },
  }));
  const pluginLine = report.lines.find((l) => l.text.startsWith('opencode plugin:'));
  assert.equal(pluginLine.level, 'warn');
});

test('F5: a healthy opencode apply still renders every line green (ok) — success path is unchanged', () => {
  const report = renderApplyReport('opencode', opencodeApply({
    skill: { ok: true, changed: true, detail: 'deployed' },
  }));
  for (const l of report.lines) assert.equal(l.level, 'ok', `expected 'ok', got '${l.level}' for: ${l.text}`);
  assert.ok(report.lines.some((l) => l.text.startsWith('opencode skill:')), 'a CHANGED skill write is always reported');
});

test('F5: the fatal (opencode.json did not converge) branch is unaffected by the level fix — still headline + skip line, plugin/agents/skill never rendered', () => {
  const report = renderApplyReport('opencode', opencodeApply({
    oc: { ok: false, changed: false, detail: 'refused', fatal: true },
  }));
  assert.equal(report.fatal, true);
  assert.equal(report.lines.length, 2);
  assert.equal(report.lines[0].level, 'fail');
  assert.match(report.lines[1].text, /plugin\/gateway\/agents\/skill\/guidance skipped/);
});

// ── generic (admitted) apply/undo still render a plain ok/warn summary ─────

test('generic apply renders ok/warn only (never fail) — a manifest never promised per-surface reporting', () => {
  const failed = renderApplyReport('acme', { ok: false, changed: false, errors: ['boom'] });
  assert.equal(failed.lines[0].level, 'warn');
  const succeeded = renderApplyReport('acme', { ok: true, changed: true, actions: ['wired'] });
  assert.equal(succeeded.lines[0].level, 'ok');
});

test('generic undo control-char stripping (F3 applies to undo too)', () => {
  const report = renderUndoReport('acme', { ok: false, changed: false, errors: ['\x1b[2Kforged'] });
  assert.equal(report.lines.length, 1);
  assert.ok(!report.lines[0].text.includes('\x1b'));
});
