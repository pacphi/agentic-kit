// Usage → Limits empty states (#238 M3, P4). The panels used to print one fixed
// guess when a provider had no data. The server now carries WHY (the Claude tee
// channel class, the Codex app-server failure class) and the client must say
// it. usage.mjs is browser source, so it is loaded as text into a vm with the
// few DOM elements renderLimits writes — the shipped function, not a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function renderLimitsWith(limits) {
  const ids = ['u-lim-claude', 'u-lim-claude-note', 'u-lim-codex', 'u-lim-codex-note', 'u-lim-insights'];
  const elements = Object.fromEntries(ids.map((id) => [id, { innerHTML: '', textContent: '' }]));
  const source = fs.readFileSync(new URL('../../src/lib/dashboard/client/usage.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({
    window: {}, document: { getElementById: (id) => elements[id] ?? null }, esc,
    formatLocalDateTime: () => null,
  });
  vm.runInContext(source, context);
  context.__limits = limits;
  vm.runInContext('LIMITS = __limits; renderLimits();', context);
  return elements;
}

const empty = (extra = {}) => ({ generatedAt: '2026-09-26T00:00:00.000Z', claude: null, codex: null, others: [], insights: [], ...extra });
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&mdash;/g, '—').replace(/&rsquo;/g, '’');

// ── Claude: the channel class decides the advice ────────────────────────────

test('a custom user-level statusLine is named, with the project precedence that still fills the panel', () => {
  const html = text(renderLimitsWith(empty({ claudeChannel: 'custom' }))['u-lim-claude'].innerHTML);
  assert.match(html, /effective statusLine runs a custom script/);
  assert.match(html, /does not report limits to ak/);
  assert.match(html, /local or managed settings may override the project and user settings/);
  assert.match(html, /ak setup --project/);
  assert.doesNotMatch(html, /Run one session, then revisit/,
    'running more sessions is not the fix when the effective statusline cannot tee');
});

test('no effective statusLine says only footer-carrying projects report limits', () => {
  const html = text(renderLimitsWith(empty({ claudeChannel: 'none' }))['u-lim-claude'].innerHTML);
  assert.match(html, /no effective statusLine/);
  assert.match(html, /ak setup --project/);
});

test('a user-level statusLine that runs each project helper points at that project', () => {
  const html = text(renderLimitsWith(empty({ claudeChannel: 'project-helper' }))['u-lim-claude'].innerHTML);
  assert.match(html, /runs each project’s own ruflo helper/);
  assert.match(html, /ak sync/);
});

test('a kit-footer statusLine keeps the run-one-session advice, qualified by plan and first response', () => {
  const html = text(renderLimitsWith(empty({ claudeChannel: 'kit-footer' }))['u-lim-claude'].innerHTML);
  assert.match(html, /carries the kit footer/);
  assert.match(html, /Pro\/Max/);
  assert.match(html, /first response/);
});

test('an older server with no channel field still gets the generic copy', () => {
  for (const claudeChannel of [undefined, 'unknown', 'something-new']) {
    const html = text(renderLimitsWith(empty({ claudeChannel }))['u-lim-claude'].innerHTML);
    assert.match(html, /no Claude limit data yet/, String(claudeChannel));
    assert.match(html, /takes precedence/, 'the precedence rule is true whatever the class');
  }
});

test('Claude windows still render as meters whatever the channel says', () => {
  const claude = { provider: 'claude', fetchedAt: Date.now(), windows: [{ id: 'five_hour', label: '5h', usedPercent: 12 }] };
  const els = renderLimitsWith(empty({ claude, claudeChannel: 'custom' }));
  assert.match(els['u-lim-claude'].innerHTML, /class="mrow"/);
  assert.doesNotMatch(els['u-lim-claude'].innerHTML, /custom script/,
    'data that arrived (from a footer-carrying project) must not be explained away');
});

// ── Codex: the server's failure class replaces the three-way guess ──────────

const codexText = (extra) => text(renderLimitsWith(empty(extra))['u-lim-codex'].innerHTML);

test('each Codex failure class renders its own cause and next check', () => {
  const cases = [
    [{ reason: 'not-installed' }, /codex CLI was not found/, /ak status/],
    [{ reason: 'spawn-failed' }, /could not be started/, /ak status/],
    [{ reason: 'exited', exitCode: 2 }, /exited before answering \(exit code 2\)/, /codex --version/],
    [{ reason: 'timeout' }, /did not answer in time/, /next refresh/],
    [{ reason: 'rpc-error', rpcCode: -32600 }, /refused the rate-limit request \(RPC error -32600\)/, /codex login status/],
    [{ reason: 'no-limit-windows' }, /reported no plan limit window/, /API-key/],
    // ADR-0010: presence-gated reasons (providers.mjs recordedHostPresence) —
    // no app-server call was ever attempted for either, so their copy
    // describes absence/staleness of host evidence, not a refresh failure.
    [{ reason: 'host-not-found' }, /not installed on this machine/, /quota is not requested/],
    [{ reason: 'host-unconfirmed' }, /not checked for Codex/, /status check finds it/],
  ];
  for (const [codexUnavailable, cause, next] of cases) {
    const html = codexText({ codexUnavailable });
    assert.match(html, cause, codexUnavailable.reason);
    assert.match(html, next, codexUnavailable.reason);
    assert.doesNotMatch(html, /not installed, not logged in, or/, 'the old three-way guess is gone');
  }
});

test('an older server with no Codex reason keeps the generic copy', () => {
  assert.match(codexText({}), /no Codex limit data/);
  assert.match(codexText({ codexUnavailable: { reason: 'from-the-future' } }), /no Codex limit data/);
});

test('a stale Codex answer served after a failed refresh says the refresh failed', () => {
  const codex = { provider: 'codex', fetchedAt: Date.now() - 3_600_000, planType: 'plus',
    lanes: [{ id: 'codex', name: 'codex', windows: [{ label: 'weekly', usedPercent: 40, windowMinutes: 10080 }] }] };
  const els = renderLimitsWith(empty({ codex, codexUnavailable: { reason: 'exited', exitCode: 2 } }));
  assert.match(els['u-lim-codex'].innerHTML, /class="mrow"/, 'the stale meters still render');
  assert.match(els['u-lim-codex-note'].textContent, /last refresh failed: exited \(code 2\)/);
  const fresh = renderLimitsWith(empty({ codex, codexUnavailable: null }));
  assert.doesNotMatch(fresh['u-lim-codex-note'].textContent, /refresh failed/);
});

// Fix round 1: a cached figure served under a presence-gated reason (no spawn
// was ever attempted) must say "not refreshed", never "last refresh failed" —
// that phrase implies an attempt that did not happen.
test('a cached Codex figure served under a presence-gated reason says "not refreshed", never "failed"', () => {
  const codex = { provider: 'codex', fetchedAt: Date.now() - 3_600_000, planType: 'plus',
    lanes: [{ id: 'codex', name: 'codex', windows: [{ label: 'weekly', usedPercent: 40, windowMinutes: 10080 }] }] };
  const notFound = renderLimitsWith(empty({ codex, codexUnavailable: { reason: 'host-not-found' } }));
  assert.match(notFound['u-lim-codex'].innerHTML, /class="mrow"/, 'the cached meters still render');
  assert.match(notFound['u-lim-codex-note'].textContent, /not refreshed: codex not found/);
  assert.doesNotMatch(notFound['u-lim-codex-note'].textContent, /failed/);

  const unconfirmed = renderLimitsWith(empty({ codex, codexUnavailable: { reason: 'host-unconfirmed' } }));
  assert.match(unconfirmed['u-lim-codex-note'].textContent, /not refreshed: not checked yet/);
  assert.doesNotMatch(unconfirmed['u-lim-codex-note'].textContent, /failed/);
});
