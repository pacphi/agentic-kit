import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rufloComponentRows, formatComponentResults } from '../../src/commands/status/sections/ruflo-components.mjs';
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

test('trust group omits opted-out components', () => {
  const group = rufloComponentsTrustGroup({
    rufloComponents: {
      typesafePicker: false, minilmPicker: false, mcpGovernance: false,
      learningProfile: false, turnCredit: false, memoryFix2887: false, funnel: true,
    },
  });
  assert.equal(group, null);
});
