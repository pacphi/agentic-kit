import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { RANK, esc } from '../../src/lib/dashboard/groups.mjs';
import { RUFLO_PIN_NOTE } from '../../src/lib/install-edits.mjs';
import { installEditRows } from '../../src/commands/status/sections/natives.mjs';

const ABOUT_SOURCE = fs.readFileSync(new URL('../../src/lib/dashboard/client/about.mjs', import.meta.url), 'utf8');
const context = vm.createContext({ RANK, esc, sourceHostIcon: () => '', aboutHostChip: () => null });
vm.runInContext(ABOUT_SOURCE.replace(/^import .*;$/gm, '').replace(/\bexport /g, ''), context);

function renderCard(id, rows) {
  context.__entry = { id, name: id, category: 'engine-memory', tagline: '', paragraph: '', icon: { ref: 'R' } };
  context.__rows = rows;
  return vm.runInContext('aboutCard(__entry, { rows: __rows })', context);
}

test('About renders one escaped Ruflo install-edit line from the real natives row', () => {
  const rufloRoot = '/test/ruflo';
  const rows = installEditRows([{
    state: 'applied',
    file: `${rufloRoot}/node_modules/@claude-flow/cli/package.json`,
    section: 'optionalDependencies',
    name: 'better-sqlite3',
    from: '<old&"value>',
    to: '^12.10.0',
  }], { rufloRoot });
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /^ak applied Ruflo's native SQLite pin \(ruvnet\/ruflo#2219\)/);

  const rufloCard = renderCard('ruflo', rows);
  const editLines = rufloCard.match(/<div class="ab-manage">[^<]*<\/div>/g) || [];
  assert.deepEqual(editLines, [`<div class="ab-manage">${esc(rows[0].message)}</div>`]);
  assert.ok(editLines[0].startsWith('<div class="ab-manage">ak applied Ruflo&#39;s native SQLite pin (ruvnet/ruflo#2219)'));
  assert.doesNotMatch(rufloCard, /<old&"value>/);
  assert.doesNotMatch(renderCard('agentdb', rows), /<div class="ab-manage">/);
  assert.doesNotMatch(renderCard('ruflo', []), /<div class="ab-manage">/);
});

test('About edit-line matcher accepts the status row wording contract', () => {
  const editLineSource = ABOUT_SOURCE.split('function aboutEditLine(')[1]?.split('function aboutCard(')[0];
  assert.ok(editLineSource, 'the shipped About edit-line function exists');
  const pattern = editLineSource.match(/\/\^([^/]+)\/\.test\(String\(er\.message/);
  assert.ok(pattern, 'the shipped About edit-line matcher exists');
  assert.match(RUFLO_PIN_NOTE, new RegExp(`^${pattern[1]}`));
});
