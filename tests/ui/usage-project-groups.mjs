// Full dashboard browser regression for the Usage Score Projects panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const pageModule = process.env.AK_UI_SOURCE_ROOT
  ? pathToFileURL(path.join(process.env.AK_UI_SOURCE_ROOT, 'src/lib/dashboard/page.mjs'))
  : new URL('../../src/lib/dashboard/page.mjs', import.meta.url);
const { renderPage } = await import(pageModule.href);
const member = (key, label, kind, cost, sessions, minutes, origins = []) => ({ key, label, kind, cost, sessions, minutes,
  tokens: 1000, origins, reportedLabels: [label], evidence: 'git-directory', observedAt: 1700000000000,
  observationBasis: 'current-filesystem', sessionRefs: [{ id: key + '-session', host: 'codex', cost, start: '2026-09-09T12:00:00Z' }] });
const projectGroups = [
  { key: 'repo-first', label: 'Example repository', kind: 'repository', cost: 30, sessions: 3, minutes: 90, tokens: 2000,
    origins: ['claude-desktop', 'codex-desktop'], members: [member('main', 'Main checkout', 'git', 20, 2, 60, ['claude-desktop']),
      member('work', 'Feature worktree', 'worktree', 10, 1, 30, ['codex-desktop'])] },
  ...Array.from({ length: 9 }, (_, index) => ({ key: 'repo-' + index, label: 'Repository ' + index, kind: 'repository',
    cost: 9 - index, sessions: 1, minutes: 30, tokens: 1000, origins: [],
    members: [member('member-' + index, 'Checkout ' + index, 'git', 9 - index, 1, 30)] })),
];
const totals = { cost: 75, sessions: 12, spanMinutes: 360, tokens: 11000 };
const byProject = { 'Example repository': { cost: 30, sessions: 3, minutes: 90 }, Legacy: { cost: 45, sessions: 9, minutes: 270 } };

test('Usage Score shows eight repository groups, expands worktrees and preserves all group totals and legacy fallback', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let payload = { projectGroups, byProject, totals, sessions: [] };
  await page.route('http://usage-projects.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: renderPage({ name: 'Usage Projects fixture', version: 'test' }) });
    const body = url.pathname === '/api/usage' ? payload : url.pathname === '/api/status' ? { overall: 'ok', rows: [] } : {};
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('http://usage-projects.test/#token=fixture');
  await page.click('#tab-usage');
  await page.waitForSelector('#u-projects .u-project-group');
  const panel = page.locator('#u-projects');
  assert.equal(await panel.locator(':scope > .u-project-group').count(), 8);
  assert.match(await page.locator('#u-projects-note').innerText(), /8.*10/);
  assert.match(await page.locator('#u-projects-note').innerText(), /\$72.*\$75/);
  assert.equal(await panel.locator('.u-project-group:visible').count(), 8);
  const first = panel.locator(':scope > .u-project-group').first();
  assert.match(await first.locator(':scope > summary').innerText(), /Example repository/);
  assert.match(await first.locator(':scope > summary').innerText(), /\$30/);
  assert.match(await first.locator(':scope > summary').innerText(), /3 sess.*2h/);
  await first.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await first.getAttribute('open'), '');
  assert.equal(await first.locator('.u-project-member').count(), 2);
  const worktree = first.locator('.u-project-member').filter({ hasText: 'Feature worktree' });
  assert.match(await worktree.innerText(), /Codex Desktop/);
  assert.match(await worktree.innerText(), /\$10/);
  assert.match(await worktree.innerText(), /30m/);
  await worktree.locator(':scope > summary').click();
  assert.ok(await worktree.locator('a').count() > 0, 'expanded member retains session navigation');
  const href = await worktree.locator('a').first().getAttribute('href');
  assert.ok(href.includes('work-session'), href);
  assert.doesNotMatch(await panel.innerText(), /Unknown origin|Sessions: Unknown/);
  const overflow = panel.locator('.u-project-overflow');
  assert.match(await overflow.locator(':scope > summary').innerText(), /Show all 10 groups/);
  await overflow.locator(':scope > summary').click();
  assert.equal(await panel.locator('.u-project-group').count(), 10);
  assert.equal(await panel.locator('.u-project-group:visible').count(), 10);
  assert.match(await page.locator('#u-hero').innerText(), /\$75/);
  const shots = process.env.AK_UI_ARTIFACTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true, `no horizontal overflow at ${width}px`);
    if (shots) await page.screenshot({ path: path.join(shots, `usage-project-groups-${width}.png`) });
  }
  payload = { byProject, totals, sessions: [] };
  await page.reload();
  await page.click('#tab-usage');
  await page.waitForFunction(() => globalThis.document.getElementById('u-projects').textContent.includes('Legacy'));
  assert.match(await panel.innerText(), /Example repository/);
  assert.match(await panel.innerText(), /\$45/);
  assert.match(await panel.innerText(), /9 sess/);
  assert.deepEqual(errors, []);
});
