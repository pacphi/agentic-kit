import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readMachineWideIntel } from '../../src/lib/dashboard/intel-history.mjs';

test('machine-wide rows retain their own scope and key without name-based attribution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-intel-table-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = [{ path: path.join(root, 'repo'), key: 'repository-key', label: 'same', learningScope: 'repository' },
    { path: path.join(root, 'user'), key: 'user-key', label: 'same', learningScope: 'user' },
    { path: path.join(root, 'missing'), key: 'unknown-key', label: 'same' }];
  const result = readMachineWideIntel(rows);
  assert.deepEqual(result.perProject.map((row) => [row.key, row.learningScope]),
    [['repository-key', 'repository'], ['user-key', 'user'], ['unknown-key', 'unknown']]);
  assert.equal(result.totals.projectCount, 3);
});

test('machine-wide groups alphabetize every retained row and preserve KPI totals', () => {
  const elements = { 'mw-table': {}, 'mw-hero': {} };
  const source = fs.readFileSync(new URL('../../src/lib/dashboard/client/intelligence.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/\bexport /g, '');
  const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const context = vm.createContext({ document: { getElementById: (id) => elements[id] }, esc,
    fmtNum: (value) => String(value ?? 0), kpi: (label, value) => `${label}:${value};` });
  vm.runInContext(`${source}\nglobalThis.renderTable=renderMachineWide;`, context);
  const perProject = Array.from({ length: 8 }, (_, i) => ({ key: `key-${i}`, label: `Repository ${8 - i}`,
    learningScope: 'repository', patternsLearned: i, patternStoreCount: 1 }));
  perProject.push({ key: 'user', label: '<User>', learningScope: 'user' });
  context.renderTable({ totals: { patternsLearnedLifetime: 28, projectCount: 9, mostActiveProject: 'Repository 8' }, perProject });
  const html = elements['mw-table'].innerHTML;
  assert.match(html, /Git repositories/);
  assert.match(html, /User-level learning/);
  assert.equal((html.match(/class="mw-row mw-data-row"/g) || []).length, 9);
  assert.ok(html.indexOf('Repository 1') < html.indexOf('Repository 8'));
  assert.ok(html.includes('title="&lt;User&gt;"'));
  assert.ok(html.includes('role="columnheader"'));
  assert.ok(html.includes('tabindex="0"'));
  assert.equal(elements['mw-hero'].innerHTML, 'patterns learned:28;projects tracked:9;most active project:Repository 8;');
});
