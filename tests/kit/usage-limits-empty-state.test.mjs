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
  assert.match(html, /user-level statusLine runs a custom script/);
  assert.match(html, /does not report limits to ak/);
  assert.match(html, /project’s own statusLine takes precedence over your user-level one/);
  assert.match(html, /ak setup --project/);
  assert.doesNotMatch(html, /Run one session, then revisit/,
    'running more sessions is not the fix when the effective statusline cannot tee');
});

test('no user-level statusLine says only footer-carrying projects report limits', () => {
  const html = text(renderLimitsWith(empty({ claudeChannel: 'none' }))['u-lim-claude'].innerHTML);
  assert.match(html, /no user-level statusLine/);
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
