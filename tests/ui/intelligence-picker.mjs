// Real dashboard/browser regression; only HTTP observations are fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// Optional source checkout supports isolated implementation/test workers.
const pageModule = process.env.AK_UI_SOURCE_ROOT
  ? pathToFileURL(path.join(process.env.AK_UI_SOURCE_ROOT, 'src/lib/dashboard/page.mjs'))
  : new URL('../../src/lib/dashboard/page.mjs', import.meta.url);
const { renderPage } = await import(pageModule.href);
const projects = [
  { key: 'repo-z', label: 'Zulu', learningScope: 'repository', learningOrigins: ['claude-desktop'] },
  { key: 'unknown-z', label: 'Zulu unknown' },
  { key: 'tree-z', label: 'Zulu tree', learningScope: 'worktree' },
  { key: 'user-z', label: 'Zulu user', learningScope: 'user' },
  { key: 'repo-a', label: 'alpha', learningScope: 'repository', learningOrigins: ['claude-desktop', 'codex-desktop'] },
  { key: 'tree-a', label: 'Alpha tree', learningScope: 'worktree', learningOrigins: ['codex-desktop'] },
  { key: 'user-a', label: 'Alpha user', learningScope: 'user' },
  { key: 'unknown-a', label: 'Alpha unknown', learningScope: 'unsupported' },
];

test('Intelligence picker groups and sorts learning scopes without changing selection or hiding empty history', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 980 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  let available = projects;
  await page.route('http://intelligence.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: renderPage({ name: 'Intelligence fixture', version: 'test' }) });
    const selected = available.find(project => project.key === url.searchParams.get('project')) || available.find(project => project.key === 'repo-z');
    if (url.pathname === '/api/status') requests.push(selected?.key ?? null);
    const body = url.pathname === '/api/status' ? {
      overall: 'ok', rows: [], intel: { projects: available, selectedProjectKey: selected?.key ?? null,
        selectedProjectLabel: selected?.label ?? null, health: [], graph: [], patternStore: [],
        machineWide: { totals: { projectCount: available.length }, perProject: [] } },
    } : {};
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('http://intelligence.test/#token=fixture');
  await page.click('[data-overview-view="intel"]');
  const picker = page.getByLabel('select project', { exact: true });
  await picker.locator('optgroup').first().waitFor({ state: 'attached' });
  assert.equal(await picker.evaluate(el => el.tagName), 'SELECT');
  const groups = await picker.locator('optgroup').evaluateAll(nodes => nodes.map(node => ({ label: node.label,
    values: Array.from(node.children, option => option.value), labels: Array.from(node.children, option => option.textContent) })));
  assert.deepEqual(groups.map(group => [group.label, group.values]), [
    ['Git repositories', ['repo-a', 'repo-z']], ['Git worktrees', ['tree-a', 'tree-z']],
    ['User-level learning', ['user-a', 'user-z']], ['Other / unclassified', ['unknown-a', 'unknown-z']],
  ]);
  assert.equal(groups[0].labels[0], 'alpha');
  assert.equal(groups[1].labels[0], 'Alpha tree');
  assert.equal(await picker.locator('option').count(), projects.length);
  assert.equal(await picker.inputValue(), 'repo-z', 'sorting must retain the server-selected project');
  await picker.focus();
  assert.equal(await picker.evaluate(el => el === el.ownerDocument.activeElement), true);
  await picker.selectOption('tree-a');
  await page.waitForFunction(() => globalThis.document.getElementById('history-project-name').textContent === 'Alpha tree');
  await page.waitForFunction(() => globalThis.document.getElementById('history-empty').textContent.includes('Alpha tree'));
  assert.equal(requests.at(-1), 'tree-a', 'selection fetch preserves the opaque project key');
  assert.equal(await picker.inputValue(), 'tree-a');
  assert.equal(await page.locator('#history').isVisible(), true);
  assert.equal(await picker.isVisible(), true);
  assert.match(await page.locator('#history-empty').innerText(), /no learning history recorded for Alpha tree yet/);
  const shots = process.env.AK_UI_ARTIFACTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  for (const width of [1360, 390]) {
    await page.setViewportSize({ width, height: 980 });
    const overflowing = await page.evaluate(() => Array.from(globalThis.document.querySelectorAll('#panel-intel *')).filter(el => el.getBoundingClientRect().right > globalThis.innerWidth).map(el => ({tag:el.tagName,id:el.id,cls:el.className,right:el.getBoundingClientRect().right})).slice(0,12));
    if (shots) await page.screenshot({ path: path.join(shots, `intelligence-picker-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true, `no overflow at ${width}px: ${JSON.stringify(overflowing)}`);
    assert.equal(await picker.isVisible(), true);
    assert.equal(await picker.inputValue(), 'tree-a');
  }
  available = [];
  await page.reload();
  await page.click('[data-overview-view="intel"]');
  await page.waitForFunction(() => globalThis.document.getElementById('intel-project-select').disabled);
  assert.equal(await picker.isVisible(), true);
  assert.equal(await picker.locator('option').textContent(), 'no projects discovered');
  assert.equal(await page.locator('#history-empty').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('Intelligence table keeps every grouped row in five-row scroll regions with stable KPIs', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 980 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const scopes = ['repository', 'worktree', 'user', 'unknown'];
  const rows = scopes.flatMap(learningScope => Array.from({ length: 8 }, (_, i) => ({
    key: `${learningScope}-${8-i}`, label: `Project ${8-i}`, learningScope,
    patternsLearned: i+1, patternStoreCount: 1, learningState: ['.claude-flow'], lastAdaptation: 1700000000000,
  })));
  await page.route('http://intelligence-table.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: renderPage({ name: 'Intelligence table fixture', version: 'test' }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.pathname === '/api/status' ? {
      overall: 'ok', rows: [], intel: { projects: rows, selectedProjectKey: rows[0].key, selectedProjectLabel: rows[0].label,
        health: [], graph: [], patternStore: [], machineWide: {
          totals: { projectCount: 32, patternsLearnedLifetime: 144, mostActiveProject: 'Project 8' }, perProject: rows,
        } },
    } : {}) });
  });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('http://intelligence-table.test/#token=fixture');
  await page.click('[data-overview-view="intel"]');
  await page.locator('.mw-data-row').first().waitFor();
  const table = page.locator('#mw-table'), hero = await page.locator('#mw-hero').innerText();
  assert.equal(await table.locator('.mw-data-row').count(), 32);
  assert.deepEqual(await table.locator('.mw-group h3').allTextContents(),
    ['Git repositories8', 'Git worktrees8', 'User-level learning8', 'Other / unclassified8']);
  assert.equal(await table.getByRole('columnheader').count(), 16);
  for (const scope of scopes) {
    assert.deepEqual(await table.locator(`[data-learning-scope="${scope}"] .mw-name`).allTextContents(),
      ['Project 1', 'Project 2', 'Project 3', 'Project 4', 'Project 5', 'Project 6', 'Project 7', 'Project 8']);
  }
  const shots = process.env.AK_UI_ARTIFACTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  for (const width of [1360, 1100, 390]) {
    await page.setViewportSize({ width, height: 980 });
    const sizes = await table.locator('.mw-group-scroll').evaluateAll(regions => regions.map(region => ({
      height: region.clientHeight, scroll: region.scrollHeight,
      header: region.querySelector('.mw-head').getBoundingClientRect().height,
      row: region.querySelector('.mw-data-row').getBoundingClientRect().height,
    })));
    for (const size of sizes) {
      assert.equal(size.row, 34);
      assert.equal((size.height-size.header)/size.row, 5);
      assert.ok(size.scroll > size.height);
    }
    assert.ok(await table.evaluate(el => el.getBoundingClientRect().height) <= 520);
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true, `no horizontal overflow at ${width}px`);
    assert.equal(await page.locator('#mw-hero').innerText(), hero);
    if (shots) await page.screenshot({ path: path.join(shots, `intelligence-table-${width}.png`), fullPage: true });
  }
  await table.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => globalThis.document.getElementById('mw-table').scrollTop > 0);
  assert.equal(await table.evaluate(el => el === el.ownerDocument.activeElement), true);
  if (shots) await page.screenshot({ path: path.join(shots, 'intelligence-table-390-scrolled.png'), fullPage: true });
  const region = table.getByRole('region', { name: 'Git repositories learning rows', exact: true });
  await region.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => globalThis.document.querySelector('.mw-group-scroll').scrollTop > 0);
  assert.equal(await region.locator('.mw-name').last().getAttribute('title'), 'Project 8');
  assert.equal(await region.evaluate(el => el === el.ownerDocument.activeElement), true);
  assert.equal(await table.locator('.mw-data-row').count(), 32);
  assert.deepEqual(errors, []);
});
