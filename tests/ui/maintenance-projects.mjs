// Focused browser regression: real workspace markup, styles, client modules,
// and public inventory projection; HTTP evidence is supplied by a fixed fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
import { CSS } from '../../src/lib/dashboard/styles.mjs';
import { buildManagementInventory } from '../../src/lib/maintenance/management/projection.mjs';
import { runInventoryQuery } from '../../src/lib/maintenance/management/query.mjs';
import { inspectorFor } from '../../src/lib/maintenance/management/guidance.mjs';
import { publicInventoryPage, publicInspector } from '../../src/lib/dashboard/maintenance-api.mjs';

function fixture() {
  const projects = ['ampel', 'boon-worthy', 'emailibrium', 'finima', 'keel', 'prompt-genie', 'ampel-feature'].map((name) => ({
    loc: { languages: (name === 'ampel' ? ['javascript', 'python', 'rust', 'java', 'ada'] : ['typescript']).map(id => ({ id })) },
    path: '/fixture/projects/'+name, label: name, hosts: ['claude', 'codex'], projectKind: name==='ampel-feature'?'worktree':'git',
  }));
  const copies = projects.map((project) => ({ project: project.path, itemPath: project.path+'/.claude/skills/a11y-ally', host: 'claude', scope: 'project' }));
  copies.push({ project: projects[0].path, itemPath: projects[0].path+'/.agents/skills/a11y-ally', host: 'codex', scope: 'project' });
  copies.push({ project: null, itemPath: '/fixture/user/.claude/skills/a11y-ally', host: 'claude', scope: 'user' });
  const presence = copies.flatMap((copy, i) => [copy.host, 'opencode'].map((host) => ({
    ...copy, host, artifactId: 'skill-'+i, digest: { status: 'measured', value: 'same-content' },
    consumer: { mechanism: 'skills', enabled: true, configScope: copy.scope },
  })));
  return buildManagementInventory({
    environment: { platform: 'darwin' }, installationKey: 'project-ui-fixture', now: () => Date.parse('2026-09-08T00:00:00Z'),
    footprint: { projects: { projects }, catalog: { items: [{ canonicalId: 'skill::a11y-ally', kind: 'skill', name: 'a11y-ally', presence }] } },
  }).inventory;
}

function clientSource(name) {
  return fs.readFileSync(new URL('../../src/lib/dashboard/client/'+name+'.mjs', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '')
    .replace(/\bexport (?=(?:function|var)\b)/g, '');
}

test('project worktree visibility and all-installations navigation work on desktop and mobile', async (t) => {
  const inventory = fixture();
  const requests = [];
  const markup = renderPage({ name: 'Fixture', version: 'test' }).match(/<section class="mnt-panel mnt-inventory"[\s\S]*?<\/section>/)[0];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://maintenance.test/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/inventory')) {
      const facets = {};
      for (const [key, value] of url.searchParams) if (key.startsWith('facet.')) (facets[key.slice(6)] ??= []).push(value);
      const query = { facets, presentation: url.searchParams.get('presentation') || 'flat', includeWorktrees: url.searchParams.get('includeWorktrees') === 'true', scope: url.searchParams.get('scope') || 'across', view: url.searchParams.get('view') || 'all', search: url.searchParams.get('search') || '', sort: url.searchParams.get('sort') || 'guidance-first' };
      requests.push(query);
      body = publicInventoryPage(runInventoryQuery(inventory, query));
    } else if (url.pathname.includes('/placements/')) {
      body = publicInspector(inspectorFor(inventory, url.pathname.split('/').pop()));
    } else {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en" data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>'+CSS+'</style></head><body><main>'+markup+'</main><p id="mnt-status" role="status"></p></body></html>' });
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://maintenance.test/');
  await page.addScriptTag({ content: `
    function authHeaders(){return {};}
    function esc(value){return String(value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
    function ago(){return '';}
    ${['maintenance-workspace', 'maintenance-cards', 'maintenance-filters', 'maintenance-guidance', 'maintenance-relationships', 'maintenance-inspector', 'maintenance-language-logos','maintenance-focus', 'maintenance-inventory'].map(clientSource).join('\n')}
    MNT.scope='project';wireMntInventory();wireMntInspector();loadMntInventory();
  ` });
  await page.locator('#mnt-results [data-mnt-focus]').first().waitFor();
  const worktreeId = inventory.placements.find((p) => p.projectKind==='worktree').projectId;
  const worktree = '#mnt-facets input[value="'+worktreeId+'"]';
  assert.equal(await page.locator(worktree).count(), 0);
  assert.equal(await page.locator('[data-mnt-focus="'+worktreeId+'"]').count(), 0);
  await page.locator('#mnt-facets [data-mnt-include-worktrees]').check();
  await page.waitForFunction(() => !globalThis.mntInventoryBusy);
  assert.equal(await page.locator(worktree).count(), 1);
  assert.equal(await page.locator('[data-mnt-focus="'+worktreeId+'"]').count(), 1);
  await page.locator('#mnt-facets [data-mnt-include-worktrees]').uncheck();
  await page.waitForFunction(() => !globalThis.mntInventoryBusy);
  await page.locator('#mnt-facets [data-mnt-facet-search="project"]').fill('feature');
  assert.equal(await page.locator(worktree).count(), 0);
  assert.equal(await page.locator('#mnt-facets [data-mnt-include-worktrees]').isVisible(), true);
  await page.locator('#mnt-facets [data-mnt-facet-search="project"]').fill('');
  const ampelId = inventory.placements.find(p => p.locationBreadcrumb?.includes('ampel')).projectId;
  const ampelCard = page.locator('[data-mnt-focus="'+ampelId+'"]');
  await ampelCard.waitFor();
  const logoFacts = await ampelCard.locator('img.mnt-language-icon').evaluateAll(images => images.map(image => ({
    source: image.getAttribute('src'), alt: image.getAttribute('alt'), label: image.getAttribute('aria-label'),
    tooltip: image.parentElement.title, width: image.getBoundingClientRect().width,
    height: image.getBoundingClientRect().height, loaded: image.complete && image.naturalWidth > 0,
  })));
  assert.equal(logoFacts.length, 5);
  assert.deepEqual(logoFacts.map(logo => logo.alt), ['JavaScript', 'Python', 'Rust', 'Java', 'Ada']);
  assert.ok(logoFacts.every(logo => logo.source.startsWith('data:image/svg+xml;base64,')
    && logo.tooltip.startsWith(logo.alt) && logo.label.startsWith(logo.alt)
    && logo.width === 24 && logo.height === 24 && logo.loaded));
  assert.equal(await ampelCard.locator('.mnt-language-list').innerText(), '', 'language initials and names do not crowd the card');
  assert.equal(await ampelCard.locator('..').locator('.mnt-language-more').count(), 0);
  assert.equal(await ampelCard.locator('.mnt-project-title > .mnt-icon').count(), 1);
  assert.equal(await ampelCard.locator('.mnt-project-kind').innerText(), 'Git');
  assert.equal(await ampelCard.locator('.mnt-project-kind .mnt-icon').count(), 1);
  assert.doesNotMatch(await ampelCard.innerText(), /Git repository/);
  if (process.env.AK_UI_ARTIFACTS) {
    fs.mkdirSync(process.env.AK_UI_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.AK_UI_ARTIFACTS, 'project-cards-desktop.png') });
  }
  await page.locator('[data-mnt-focus="'+ampelId+'"]').click();
  await page.locator('[data-mnt-focus="skill"]').click();
  await page.locator('#mnt-results [data-mnt-focus]').first().click();
  await page.locator('#mnt-results [data-mnt-plc]').first().waitFor();
  assert.equal(await page.locator('#mnt-results [data-mnt-plc]').count(), 2);
  assert.match(await page.locator('#mnt-results').innerText(), /\.claude\/skills\/a11y-ally/);
  assert.match(await page.locator('#mnt-results').innerText(), /Available to Claude and OpenCode/);
  assert.doesNotMatch(await page.locator('#mnt-results').innerText(), /Used by|Hosts:/);
  if (process.env.AK_UI_ARTIFACTS) {
    fs.mkdirSync(process.env.AK_UI_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.AK_UI_ARTIFACTS, 'projects-desktop.png') });
  }
  await page.locator('#mnt-results [data-mnt-plc]').first().click();
  await page.locator('#mnt-inspector-title').waitFor();
  await page.getByRole('button', { name: 'View all 9 installations', exact: true }).click();
  await page.waitForFunction(() => globalThis.document.getElementById('mnt-context-heading')===globalThis.document.activeElement);
  assert.equal(requests.at(-1).scope, 'across');
  assert.equal(await page.locator('#mnt-inspector').isVisible(), false);
  assert.match(await page.locator('#mnt-context-heading').innerText(), /a11y-ally/);
  assert.equal(await page.locator('#mnt-results [data-mnt-plc]').count(), 9);
  await page.locator('[data-mnt-back="root"]').click();
  await page.locator('[data-mnt-focus="project"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await ampelCard.locator('img.mnt-language-icon').count(), 5);
  assert.equal(await ampelCard.locator('.mnt-language-list').evaluate(el => globalThis.getComputedStyle(el).flexWrap), 'wrap');
  if (process.env.AK_UI_ARTIFACTS) await page.screenshot({ path: path.join(process.env.AK_UI_ARTIFACTS, 'project-cards-mobile.png') });
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const sheet = page.locator('#mnt-facets-sheet');
  await sheet.locator('[data-mnt-include-worktrees]').check();
  await page.waitForFunction(() => !globalThis.mntInventoryBusy);
  const selectedWorktree = sheet.locator('input[value="'+worktreeId+'"]');
  await selectedWorktree.check();
  await page.waitForFunction(() => (globalThis.MNT.facets.project||[]).length===1&&!globalThis.mntInventoryBusy);
  await sheet.locator('[data-mnt-include-worktrees]').uncheck();
  await page.waitForFunction(() => !globalThis.mntInventoryBusy);
  assert.equal(await selectedWorktree.isChecked(), true);
  if (process.env.AK_UI_ARTIFACTS) await page.screenshot({ path: path.join(process.env.AK_UI_ARTIFACTS, 'projects-mobile.png') });
  await selectedWorktree.click();
  await page.waitForFunction(() => !(globalThis.MNT.facets.project||[]).length&&!globalThis.mntInventoryBusy);
  assert.equal(await selectedWorktree.count(), 0);
  await sheet.getByRole('button', { name: 'Close filters' }).click();
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth), true);
  assert.deepEqual(errors, []);
});
