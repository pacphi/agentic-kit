// The Usage > Context host card: per-host pressure tooltips (real formula and
// evidence source), source-health-aware empty states (audit O-13), and the
// separate subagent line (audit C-5). The renderer is a pure function shared
// with the browser bundle, so it is tested in node without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextHostCard } from '../../src/lib/dashboard/context-host-card.mjs';
import { JS } from '../../src/lib/dashboard/client.mjs';
import { CONTEXT_POLICY } from '../../src/lib/usage-context.mjs';

const EMPTY = { coverage: { sessions: 0, inputMeasured: 0, windowMeasured: 0, pressureMeasured: 0, state: 'not-observed' } };
const INPUT_ONLY = {
  coverage: { sessions: 44, inputMeasured: 44, windowMeasured: 0, pressureMeasured: 0, state: 'partial' },
  inputTokens: { peak: { p90: 765_000 } },
};
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
const tipOf = (html) => decode(/class="ctx-pressure"[^>]*title="([^"]*)"/.exec(html)[1]);

test('every host card has a focusable pressure area whose tooltip is also exposed to assistive tech', () => {
  for (const host of ['claude', 'codex', 'opencode']) {
    const html = contextHostCard(host, EMPTY, { policy: CONTEXT_POLICY });
    assert.match(html, /class="ctx-pressure" tabindex="0" title="/);
    assert.match(html, new RegExp(`aria-describedby="ctx-tip-${host}"`));
    assert.match(html, new RegExp(`<span class="sr-only" id="ctx-tip-${host}">`));
  }
});

test('Codex tooltip states the same-event formula and that cached input is not added again', () => {
  const tip = tipOf(contextHostCard('codex', EMPTY, { policy: CONTEXT_POLICY }));
  assert.match(tip, /last_token_usage\.input_tokens ÷ model_context_window/);
  assert.match(tip, /SAME token_count event/);
  assert.match(tip, /Cached input is a subset[^.]*not added again/);
});

test('Claude tooltip states gross input, the statusline window, and which sessions stay Input only', () => {
  const tip = tipOf(contextHostCard('claude', INPUT_ONLY, { policy: CONTEXT_POLICY }));
  assert.match(tip, /gross input of each assistant message \(fresh \+ cache read \+ cache write\)/);
  assert.match(tip, /statusline reported for that session at that time/);
  assert.match(tip, /ran with the kit's statusline/);
  assert.match(tip, /ak sync/);
  assert.match(tip, /headless, subagent and pre-upgrade sessions show Input only/);
});

test('OpenCode tooltip says pressure is not measured and why no catalogue maximum is used', () => {
  const tip = tipOf(contextHostCard('opencode', EMPTY, { policy: CONTEXT_POLICY }));
  assert.match(tip, /OpenCode records no runtime context window, so pressure is not measured/);
  assert.match(tip, /catalogue maximum is deliberately not used/);
  assert.match(tip, /overstate capacity/);
  assert.match(tip, /local models often load far less/);
});

test('every tooltip carries the policy thresholds and the not-measured-is-not-zero rule', () => {
  for (const host of ['claude', 'codex', 'opencode']) {
    const tip = tipOf(contextHostCard(host, EMPTY, { policy: CONTEXT_POLICY }));
    assert.match(tip, /startup target \d+%/);
    assert.match(tip, /warn \d+% · compact \d+% · handoff \d+%/);
    assert.match(tip, /reserve \d+%/);
    assert.match(tip, /"Not measured" never means 0%/);
    assert.match(tip, /per-session runtime observation/);
  }
  assert.match(tipOf(contextHostCard('codex', EMPTY, {})), /startup target unknown/, 'no policy is unknown, never a guessed number');
});

test('tooltip text is escaped in both attributes and never smuggles markup', () => {
  const html = contextHostCard('claude', EMPTY, { policy: { startupTargetBps: '"><img src=x>' } });
  assert.doesNotMatch(html, /<img/);
});

test('no catalogue-based percentage appears for OpenCode', () => {
  const html = contextHostCard('opencode', INPUT_ONLY, { policy: CONTEXT_POLICY });
  assert.match(html, /Pressure not measured/);
  assert.doesNotMatch(html, /role="meter"/);
});

// ── source-health-aware empty state (O-13) ──────────────────────────────────

test('empty state: not installed (health absent)', () => {
  const html = contextHostCard('opencode', EMPTY, { health: { status: 'absent', reason: 'absent' } });
  assert.match(html, /Not installed/);
  assert.match(html, /No OpenCode session store was found/);
  assert.doesNotMatch(html, /No sessions in the selected timeframe/);
});

test('empty state: installed but nothing in this window (health ok)', () => {
  const html = contextHostCard('opencode', EMPTY, { health: { status: 'ok', reason: null } });
  assert.match(html, /No sessions in the selected timeframe\. OpenCode is installed and readable/);
});

test('empty state: unreadable store carries the health reason and does not claim zero sessions', () => {
  const html = contextHostCard('opencode', EMPTY, { health: { status: 'degraded', reason: 'schema' } });
  assert.match(html, /Source unreadable/);
  assert.match(html, /could not be read \(schema\)/);
  assert.match(html, /does not mean no sessions ran/);
});

test('empty state: with no health supplied the original wording is kept', () => {
  assert.match(contextHostCard('opencode', EMPTY, {}), /No sessions in the selected timeframe\./);
  assert.match(contextHostCard('opencode', EMPTY), /No sessions in the selected timeframe\./);
});

test('health never overrides a card that has sessions', () => {
  const html = contextHostCard('claude', INPUT_ONLY, { health: { status: 'absent' } });
  assert.match(html, /Input only/);
  assert.match(html, /Only sessions that ran with the kit statusline record one/);
});

// ── subagent secondary line (C-5) ───────────────────────────────────────────

test('a host with subagent sessions shows a separate, labelled, input-only line', () => {
  const sub = {
    coverage: { sessions: 302, inputMeasured: 302, windowMeasured: 0, pressureMeasured: 0 },
    inputTokens: { peak: { p90: 179_800 } },
  };
  const html = contextHostCard('claude', INPUT_ONLY, { subagent: sub });
  assert.match(html, /class="ctx-subagents"/);
  assert.match(html, /Subagent sessions<\/b> \(delegated work, reported separately from the figures above\): 302 · p90 peak input 180K · pressure not measured/);
});

test('a subagent line with real pressure reports it as its own figure', () => {
  const sub = {
    coverage: { sessions: 3, pressureMeasured: 3 }, inputTokens: { peak: { p90: 50_000 } },
    pressureBps: { peak: { p90: 4_250 } },
  };
  assert.match(contextHostCard('codex', EMPTY, { subagent: sub }), /p90 peak pressure 42\.5%/);
});

test('no subagent sessions renders no secondary line', () => {
  assert.doesNotMatch(contextHostCard('claude', INPUT_ONLY, { subagent: { coverage: { sessions: 0 } } }), /ctx-subagents/);
});

test('the served browser bundle ships the same card renderer', () => {
  assert.match(JS, /function contextHostCard\(/);
  assert.match(JS, /Only sessions that ran with the kit\\'s statusline|Only sessions that ran with the kit's statusline/);
});
