import { censusDisclosure } from '../../src/lib/census-presentation.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as vocabulary from '../../src/lib/session-surface.mjs';
const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function renderer(name, elements = {}) {
  const context = vm.createContext({ ...vocabulary, censusDisclosure, MNT_CURATED_VIEW_LABELS: {}, esc, window: {}, document: { getElementById: (id) => elements[id] ?? null },
    fmtNum: String, kpi: () => '', ago: () => 'now', formatLocalDateTime: () => null });
  const read = (file) => fs.readFileSync(new URL(`../../src/lib/dashboard/client/${file}.mjs`, import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/\bexport /g, '');
  const helper = new URL('../../src/lib/dashboard/client/session-presentation.mjs', import.meta.url);
  if (fs.existsSync(helper)) vm.runInContext(read('session-presentation'), context);
  vm.runInContext(read(name), context);
  return context;
}
const sessionOrigin = { surface: 'chatgpt-desktop-work', initiator: 'agent', rawEvidence: { originator: 'future-client' } };
test('Usage detail renders independent surface, initiator and bounded raw evidence', () => {
  const context = renderer('usage');
  const html = context.sdetail({ id: 'x', host: 'codex', sessionOrigin });
  assert.match(html, /ChatGPT desktop app · ChatGPT Work \(local\)/);
  assert.match(html, /initiator.*Agent/);
  assert.match(html, /future-client/);
  const hostile = context.sdetail({ id: 'x', sessionOrigin: { surface: '<img>', rawEvidence: { originator: '<img src=x>', source: 'vscode' } } });
  assert.doesNotMatch(hostile, /<img|&lt;img/);
  assert.match(hostile, /Unknown/);
});
test('Intelligence keeps Git scope and session surfaces independent and displays both observed surfaces', () => {
  const elements = { 'mw-table': {}, 'mw-hero': {} };
  const context = renderer('intelligence', elements);
  context.renderMachineWide({ totals: {}, perProject: [{ label: 'Repository', learningScope: 'repository',
    sessionSurfaces: [{ ...sessionOrigin, host: 'codex', sessions: 1 }, { surface: 'cloud-session', initiator: 'automation', host: 'claude', sessions: 1 }] }] });
  assert.match(elements['mw-table'].innerHTML, /Git repository/);
  assert.match(elements['mw-table'].innerHTML, /ChatGPT desktop app · ChatGPT Work \(local\)/);
  assert.match(elements['mw-table'].innerHTML, /Cloud session/);
  assert.match(elements['mw-table'].innerHTML, /Session surface/);
});
test('Maintenance origin facet shares the same surface vocabulary and honest legacy fallback', () => {
  const context = renderer('maintenance-filters');
  assert.equal(context.mntFacetValueLabel('sessionOrigin', 'chatgpt-desktop-work'), 'ChatGPT desktop app · ChatGPT Work (local)');
  assert.equal(context.mntFacetValueLabel('sessionOrigin', 'codex-desktop'), 'Unknown');
});
test('Intelligence and System disclose pure, mixed and unresolved import counts, including an empty project census', () => {
  const counts = { importedExcluded: 4, importedMixed: 2, importedUnresolved: 3 };
  const elements = { 'mw-census': {}, 'mw-census-body': {}, 'sys-projects': {} };
  const intel = renderer('intelligence', elements);
  intel.renderCensus({ counts });
  const system = renderer('system-projects', elements);
  system.sysEmpty = (text) => text;
  system.renderSysProjects({ projects: { ...counts, projects: [], discoveryProjects: [] } });
  for (const id of ['mw-census-body', 'sys-projects']) {
    assert.match(elements[id].innerHTML, /4 confirmed pure imported copies excluded/);
    assert.match(elements[id].innerHTML, /2 mixed files retain proven native activity/);
    assert.match(elements[id].innerHTML, /3 files have unresolved bounded ownership/);
    assert.match(elements[id].innerHTML, /dedicated Cowork transcript source is not covered/);
  }
});
test('Maintenance project detail exposes independent evidence outside the navigation button', () => {
  const context = renderer('maintenance-focus');
  context.MNT = { facets: {} }; context.mntIcon = () => ''; context.mntProjectKindBadge = () => 'Git repository';
  const html = context.mntFocusNode({ value: 'id', label: 'Example', projectKind: 'git', count: 1,
    sessionSurfaces: [{ ...sessionOrigin, host: 'codex', sessions: 2 }] }, 0, 'project', false);
  assert.match(html, /<\/button><details/);
  assert.match(html, /ChatGPT desktop app · ChatGPT Work \(local\)/);
  assert.match(html, /future-client/);
});
test('prototype property names never become display labels', () => {
  const context = renderer('maintenance-filters');
  assert.equal(context.mntFacetValueLabel('sessionOrigin', '__proto__'), 'Unknown');
  assert.equal(vocabulary.sessionPresentation({ initiator: 'toString' }).initiator, 'Unknown');
});
test('Usage retains explicit observed provider IDs while refusing unproven or unsupported provider claims', () => {
  const context = renderer('usage');
  const observed = context.sdetail({ id: 'x', provider: 'openrouter', providerProvenance: 'observed' });
  assert.match(observed, /OpenRouter/);
  assert.match(observed, /recorded provider ID; not network attestation/);
  const unknown = context.sdetail({ id: 'x', provider: 'openrouter', providerProvenance: 'unknown' });
  assert.doesNotMatch(unknown, /OpenRouter/);
});
