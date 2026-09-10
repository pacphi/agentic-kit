// Real Maintenance markup/client/projection with fixture HTTP responses.
// Mutation authority is covered separately by the real transaction-service test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
import { CSS } from '../../src/lib/dashboard/styles.mjs';
import { buildManagementInventory } from '../../src/lib/maintenance/management/projection.mjs';
import { admitGuidance, inspectorFor } from '../../src/lib/maintenance/management/guidance.mjs';
import { runInventoryQuery } from '../../src/lib/maintenance/management/query.mjs';
import { publicInventoryPage, publicInspector } from '../../src/lib/dashboard/maintenance-api.mjs';

const KEY = 'host-alignment-browser-fixture';
function clientSource(name) {
  return fs.readFileSync(new URL('../../src/lib/dashboard/client/'+name+'.mjs', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '')
    .replace(/\bexport (?=(?:function|var)\b)/g, '');
}

test('Host alignment view filters User and Project rows and offers exact registration preview', async t => {
  const entries = [
    { id: 'host-alignment-user', name: 'Host alignment: user-peer', host: 'claude', scope: 'user', project: null, file: '/fixture/user/.claude.json' },
    { id: 'host-alignment-project', name: 'Host alignment: project-peer', host: 'claude', scope: 'project', project: '/fixture/project', file: '/fixture/project/.mcp.json' },
  ].map(e => ({ ...e, repairable: true, code: 'retired-codex-mcp', message: 'Retired Codex MCP transport', sourceFingerprint: 'a'.repeat(64) }));
  const facts = { status: 'available', complete: true, entries };
  const projected = buildManagementInventory({ installationKey: KEY, environment: { platform: 'darwin' }, discovery: { hostAlignment: facts } }).inventory;
  const inventory = admitGuidance({ inventory: projected, installationKey: KEY,
    providers: new Map([['host-alignment', { version: 'v1', operations: ['realign'] }]]),
    detections: new Map([['host-alignment', facts]]) }).inventory;
  assert.ok(inventory.guidanceEntries.some(entry => entry.lane === 'apply'), JSON.stringify(inventory.guidanceEntries));
  const markup = renderPage({ name: 'Fixture', version: 'test' }).match(/<section class="mnt-panel mnt-inventory"[\s\S]*?<\/section>/)[0];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://alignment.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/inventory')) {
      const query = { scope: url.searchParams.get('scope') || 'across', view: url.searchParams.get('view') || 'all', presentation: 'flat' };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(publicInventoryPage(runInventoryQuery(inventory, query))) });
    }
    if (url.pathname.includes('/placements/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(publicInspector(inspectorFor(inventory, url.pathname.split('/').pop()))) });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en" data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>'+CSS+'</style></head><body><main>'+markup+'</main><p id="mnt-status" role="status"></p></body></html>' });
  });
  await page.goto('http://alignment.test/');
  await page.addScriptTag({ content: `
    function authHeaders(){return {};}
    function esc(value){return String(value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
    function ago(){return '';}
    function beginMaintPreview(button, request){window.selectedPreview=request;}
    ${['maintenance-workspace','maintenance-operation','maintenance-cards','maintenance-filters','maintenance-guidance','maintenance-relationships','maintenance-inspector','maintenance-language-logos','maintenance-focus','maintenance-inventory'].map(clientSource).join('\n')}
    MNT.scope='user';MNT.view='host-alignment';wireMntInventory();wireMntInspector();wireMntGuidance();loadMntInventory();
  ` });
  await page.locator('[data-mnt-plc]').first().waitFor();
  assert.match(await page.locator('#mnt-results').innerText(), /user-peer/);
  assert.doesNotMatch(await page.locator('#mnt-results').innerText(), /project-peer/);
  await page.locator('[data-mnt-plc]').first().click();
  await page.waitForFunction(() => !globalThis.mntInspectorBusy);
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.match(await page.locator('#mnt-inspector').innerText(), /Realign|Repair registration/, String(await page.evaluate(() => globalThis.mntInspectorError && (globalThis.mntInspectorError.stack || globalThis.mntInspectorError))));
  const preview = page.locator('[data-mnt-plan-plc]');
  await preview.waitFor();
  await preview.click();
  const selected = await page.evaluate(() => globalThis.selectedPreview);
  assert.equal(selected.placementId, inventory.placements.find(p => p.administrativeScope === 'user').placementId);
  await page.locator('[data-mnt-scope="project"]').click();
  await page.waitForFunction(() => !globalThis.mntInventoryBusy);
  assert.match(await page.locator('#mnt-results').innerText(), /project-peer/);
  assert.doesNotMatch(await page.locator('#mnt-results').innerText(), /user-peer/);
  assert.equal(errors.length, 0, errors.join('\n'));
  await page.screenshot({ path: path.join(os.tmpdir(), 'maintenance-host-alignment.png'), fullPage: true });
});
