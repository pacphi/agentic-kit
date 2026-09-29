import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rufloComponentRows, formatComponentResults, componentResultReport, RESTART_REMINDER } from '../../src/commands/status/sections/ruflo-components.mjs';
import { describeState } from '../../src/lib/ruflo-components/states.mjs';
import { rufloComponentsTrustGroup, trustManifestLines } from '../../src/lib/trust-manifest.mjs';

const view = (id, label, stateId, stateLabel, meaning, action = '') => ({ id, label, state: { id: stateId, label: stateLabel, meaning, action } });
const snapshot = {
  rufloVersion: '3.44.0', summary: { active: 1, total: 3 }, components: [
    view('typesafePicker', 'Typesafe agent picker', 'active', 'active', "Applied and confirmed by ruflo's own evidence."),
    view('minilmPicker', 'MiniLM agent picker', 'needs-ruflo', 'needs ruflo ≥ 3.44.0', 'The installed ruflo is too old for this component.', 'Run ak sync to upgrade ruflo.'),
    view('learningProfile', 'Learning profile', 'user-managed', 'user-managed', 'You set your own value or opted out; ak reports it and leaves it alone.'),
  ],
};

test('rows lead with a summary and always carry the meaning', () => {
  const rows = rufloComponentRows(snapshot);
  assert.equal(rows[0].message, 'ruflo components: 1 of 3 active (ruflo 3.44.0)');
  assert.ok(rows.every((r) => r.subsystem === 'ruflo-components'));
  assert.match(rows[2].message, /MiniLM agent picker — needs ruflo ≥ 3\.44\.0: The installed ruflo is too old/);
  assert.equal(rows[2].level, 'warn');
  assert.match(rows[2].fix, /ak sync/);
  assert.equal(rows[3].level, 'ok');
  assert.equal(rows[3].fix, null);
});

test('applied-unverified gives one restart instruction across message and manual fix', () => {
  const [summary, unverified] = rufloComponentRows({
    rufloVersion: '3.44.0', summary: { active: 0, total: 1 }, components: [
      { id: 'minilmPicker', label: 'MiniLM agent picker', state: describeState('applied-unverified') },
    ],
  });
  assert.equal(summary.level, 'info');
  assert.equal(unverified.state, 'applied-unverified');
  assert.equal(unverified.level, 'warn');
  assert.equal(unverified.repair, 'manual');
  assert.match(unverified.message, /MiniLM agent picker — applied, not verified: Set, but not yet confirmed/);
  assert.match(unverified.fix, /restart Claude Code, Codex and OpenCode, then run ak status --refresh/i);
  assert.equal(`${unverified.message} ${unverified.fix}`.match(/restart Claude Code, Codex and OpenCode/gi)?.length, 1);
});

test('neighboring component rows retain action, repair, and convergence contracts', () => {
  const states = ['not-applied', 'drifted', 'blocked', 'active'];
  const rows = rufloComponentRows({
    rufloVersion: '3.44.0', summary: { active: 1, total: 4 },
    components: states.map((id) => ({ id, label: `${id} component`, state: describeState(id) })),
  }).slice(1);
  for (const id of ['not-applied', 'drifted']) {
    const rendered = rows.find((r) => r.state === id);
    assert.equal(rendered.level, 'warn');
    assert.equal(rendered.repair, 'sync');
    assert.match(rendered.message, /Run ak sync/);
    assert.match(rendered.fix, /sync applies/);
  }
  const blocked = rows.find((r) => r.state === 'blocked');
  assert.equal(blocked.level, 'fail');
  assert.equal(blocked.repair, 'sync');
  assert.match(blocked.message, /Follow the reason shown, then run ak sync/);
  assert.match(blocked.fix, /sync applies/);
  const active = rows.find((r) => r.state === 'active');
  assert.equal(active.level, 'ok');
  assert.equal(active.repair, null);
  assert.equal(active.fix, null);
});

test('setup results table lists state and meaning per component', () => {
  const lines = formatComponentResults(snapshot);
  assert.ok(lines.some((l) => /Learning profile.*user-managed.*leaves it alone/.test(l)));
});

test('trust group discloses every managed change with benefit, cost and opt-out', () => {
  const group = rufloComponentsTrustGroup({
    rufloComponents: {
      typesafePicker: true, minilmPicker: true,
      mcpGovernance: { maxCallsPerMinute: 120 }, learningProfile: 'balanced', turnCredit: true, memoryFix2887: true, funnel: false,
    },
  });
  const text = trustManifestLines([group]).join('\n');
  for (const needle of ['@ruvector/typesafe', 'CLAUDE_FLOW_ROUTER_TYPESAFE=1', 'CLAUDE_FLOW_ROUTER_EMBEDDER=minilm',
    '.harness/mcp-policy.json', 'RUFLO_INTELLIGENCE_MODE=balanced', 'ruflo funnel disable', 'rufloComponents']) {
    assert.ok(text.includes(needle), needle);
  }
});

test('trust group discloses that ak keeps its policy file out of git, and the 3.46.0 boundary', () => {
  const group = rufloComponentsTrustGroup({ rufloComponents: { mcpGovernance: { maxCallsPerMinute: 120 } } });
  const text = trustManifestLines([group]).find((line) => line.includes('.harness/mcp-policy.json —'));
  assert.ok(text, 'the policy-file line is disclosed');
  assert.match(text, /\.git\/info\/exclude/);
  assert.match(text, /Ruflo 3\.46\.0 and newer/);
  assert.doesNotMatch(text, /3\.44\.0|\.gitignore/);
});

test('trust group omits opted-out components', () => {
  const group = rufloComponentsTrustGroup({
    rufloComponents: {
      typesafePicker: false, minilmPicker: false, mcpGovernance: false,
      learningProfile: false, turnCredit: false, memoryFix2887: false, funnel: true,
    },
  });
  assert.equal(group, null);
});

// Controller ruling: a blocked component must count toward `ak sync`'s
// post-heal convergence check, which filters on `r.level === 'fail'` — a
// 'warn' row would let sync report "converged" while the component stayed broken.
test('a blocked component row is level fail, not warn, so sync convergence counts it', () => {
  const blocked = {
    rufloVersion: '3.44.0', summary: { active: 0, total: 1 }, components: [
      view('mcpGovernance', 'MCP tool governance', 'blocked', 'blocked',
        'Applying failed. Follow the reason shown, then run ak sync.', 'Follow the reason shown, then run ak sync.'),
    ],
  };
  const rows = rufloComponentRows(blocked);
  assert.equal(rows[1].level, 'fail');
  assert.match(rows[1].fix, /ak sync/);
});

// Final review M11: machine setup gets the same after-changes report as project setup.
test('the setup report has the table, failed steps and the restart reminder only after a change', () => {
  const failed = componentResultReport({ snapshot, changed: true, results: [
    { id: 'typesafePicker', ok: true, detail: 'present' }, { id: 'funnel', ok: false, detail: 'ruflo funnel disable did not take effect' },
  ] });
  assert.equal(failed.filter((l) => l.level === 'log').length, snapshot.components.length);
  assert.deepEqual(failed.filter((l) => l.level === 'warn').map((l) => l.text), ['ruflo components: funnel — ruflo funnel disable did not take effect']);
  assert.equal(failed.at(-1).text, RESTART_REMINDER);
  const quiet = componentResultReport({ snapshot, changed: false, results: [] });
  assert.ok(!quiet.some((l) => l.text === RESTART_REMINDER));
});
