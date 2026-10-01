import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome } from './helpers/launch-chrome.mjs';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
const sessionSurfaces = [{ host: 'codex', surface: 'chatgpt-desktop-work', initiator: 'agent', sessions: 2,
  countBasis: 'transcript-files', rawEvidence: { originator: ['codex_work_desktop'], source: ['vscode'] } },
{ host: 'claude', surface: 'cloud-session', initiator: 'automation', sessions: 1 }];
const project = { key: 'example', path: '/fixture/example', label: '<Example>', learningScope: 'repository', sessionSurfaces,
  repository: { kind: 'git', repositoryId: 'fixture-repo', root: '/fixture/example' } };
const counts = { everSeen: 1, onDisk: 1, gitRepos: 1, learning: 1, importedExcluded: 4, importedMixed: 2, importedUnresolved: 3 };
test('served dashboard renders independent session evidence and preserves observed surface filters', async t => {
  const browser = await launchChrome(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let currentProject = project;
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://surfaces.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: renderPage({ name: 'Surfaces', version: 'test' }) });
    const body = url.pathname === '/api/status' ? { overall: 'ok', rows: [], intel: { projects: [currentProject],
      census: { counts }, machineWide: { totals: { projectCount: 1 }, perProject: [currentProject] } } }
      : url.pathname === '/api/usage' ? { totals: { sessions: 1 }, sessions: [], projectTree: [{ project: 'Example', sessions: 1, rows: [{ id: 'fixture-session', host: 'claude', sessionOrigin: { surface: 'claude-desktop', initiator: 'person', thirdPartyProvider: 'amazon-bedrock', thirdPartyProviderBasis: 'assistant-model-id', rawEvidence: { entrypoint: 'claude-desktop-3p' } } }] }] }
      : url.pathname === '/api/system/summary' ? { projects: { ...counts, projects: [project], discoveryProjects: [project] } } : {};
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://surfaces.test/#token=fixture');
  await page.click('[data-overview-view="intel"]');
  const filter = page.locator('#mw-surface-filter'); await filter.waitFor();
  assert.deepEqual(await filter.locator('option').allTextContents(), ['All', 'ChatGPT desktop app · ChatGPT Work (local)', 'Cloud session']);
  await filter.selectOption({ label: 'Cloud session' });
  await page.locator('#mw-table .session-surface-detail summary').click();
  assert.match(await page.locator('#mw-table').innerText(), /Git repository/);
  assert.match(await page.locator('#mw-table').innerText(), /initiator: Agent/);
  assert.match(await page.locator('#mw-table').innerText(), /source: vscode/);
  assert.doesNotMatch(await page.locator('#mw-table').innerText(), /Codex IDE extension/);
  await page.locator('#mw-census summary').click();
  assert.match(await page.locator('#mw-census-body').innerText(), /3 files have unresolved bounded ownership/);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);
  }
  await page.click('#tab-system'); await page.click('[data-system-view="projects"]');
  await page.locator('#sys-projects .session-surface-detail summary').click();
  assert.match(await page.locator('#sys-projects').innerText(), /ChatGPT desktop app · ChatGPT Work \(local\)/);
  assert.match(await page.locator('#sys-projects').innerText(), /4 confirmed pure imported copies excluded/);
  assert.match(await page.locator('#sys-projects').innerText(), /dedicated Cowork transcript source is not covered/);
  assert.equal(await page.locator('#sys-projects img').count(), 0);
  await page.click('#tab-overview'); await page.click('[data-overview-view="intel"]');
  assert.equal(await filter.inputValue(), 'Cloud session');
  currentProject = { ...project, sessionSurfaces: undefined, sessionOrigins: [{ origin: 'claude-desktop', sessions: 3 }] };
  await page.click('#poll-now');
  await page.waitForFunction(() => globalThis.document.querySelector('#mw-surface-filter').value === 'all');
  assert.deepEqual(await filter.locator('option').allTextContents(), ['All', 'Claude Desktop']);
  assert.equal(await page.locator('#mw-table .mw-data-row').count(), 1);
  assert.match(await page.locator('#mw-table').innerText(), /Claude Desktop/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click('#tab-usage'); await page.click('#usage-tab-sessions');
  await page.locator('#u-tree .phead').click();
  await page.locator('#u-tree .s-exp').click();
  const detail = await page.locator('#sd-fixture-session').innerText();
  assert.match(detail, /Claude Desktop/); assert.match(detail, /Amazon Bedrock/);
  assert.match(detail, /assistant-model-id; not network attestation/);
  assert.match(detail, /claude-desktop-3p/);
  assert.deepEqual(errors, []);
});
