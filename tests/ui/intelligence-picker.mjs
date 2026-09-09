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
  assert.equal(groups[0].labels[0], 'alpha · Claude Desktop · Codex Desktop');
  assert.equal(groups[1].labels[0], 'Alpha tree · Codex Desktop');
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
