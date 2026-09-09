// Real Guidance markup, CSS and browser renderers with fixed evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
import { CSS } from '../../src/lib/dashboard/styles.mjs';

function source(name) {
  return fs.readFileSync(new URL('../../src/lib/dashboard/client/'+name+'.mjs', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '')
    .replace(/\bexport (?=(?:function|var)\b)/g, '');
}
test('guidance has exclusive pills, host context, and no resource selector or optional removal advice', async (t) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const markup = renderPage({ name: 'Fixture', version: 'test' }).match(/<section class="mnt-panel mnt-guidance"[\s\S]*?<\/section>/)[0].replace(' hidden>', '>');
  await page.setContent('<html data-theme="dark"><head><style>'+CSS+'</style></head><body>'+markup+'<div id="optional-test"></div></body></html>');
  await page.addScriptTag({ content: `
    function esc(v){return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');}
    function mntWritesBlocked(){return false;}
    ${['maintenance-workspace','maintenance-cards','maintenance-guidance','maintenance-relationships', 'maintenance-inspector'].map(source).join('\n')}
    mntJoinPlacements=function(){return Promise.resolve();};
    MNT.guidance={counts:{steps:1,decision:1,total:2},entries:[
      {guidanceId:'missing',placementId:'shared',lane:'steps',outcome:'Restore missing command'},
      {guidanceId:'choice',placementId:'shared',lane:'decision',outcome:'Resolve overlap'},
      {guidanceId:'optional',placementId:'codex',lane:'apply',purpose:'optional-management',verb:'remove',outcome:'Remove healthy registration'}
    ],coverage:[{label:'OpenCode',placements:2,recommendations:2,optionalActions:0,actionStatusLabel:'No automatic actions registered for this host'}]};
    mntPlacementRows.shared={displayName:'Shared MCP',scope:{label:'User'},consumerHosts:['claude','opencode']};
    mntActiveLane='steps';wireMntGuidance();renderMntGuidance();
    document.getElementById('optional-test').innerHTML=mntWhatCanIAccomplish([MNT.guidance.entries[2]]);
  ` });
  assert.equal(await page.locator('#mnt-guidance-kind').count(), 0);
  assert.match(await page.locator('#mnt-guidance-list').innerText(), /Available to Claude and OpenCode/);
  for (const lane of ['decision', 'apply', 'steps', 'steps']) {
    await page.locator('[data-mnt-lane="'+lane+'"]').click();
    assert.equal(await page.locator('#mnt-lanes [aria-selected="true"]').count(), 1);
    assert.equal(await page.locator('#mnt-lanes [aria-selected="true"]').getAttribute('data-mnt-lane'), lane);
    assert.doesNotMatch(await page.locator('#mnt-guidance-list').innerText(), /Remove healthy/);
  }
  assert.equal(await page.locator('#mnt-lanes button').first().evaluate(el => globalThis.getComputedStyle(el).borderRadius), '999px');
  await page.getByText('Host coverage', { exact: true }).click();
  assert.match(await page.locator('#mnt-guidance-coverage').innerText(), /OpenCode.*2 installations/);
  assert.match(await page.locator('#optional-test').innerText(), /Optional actions/);
  assert.equal(await page.locator('#optional-test [data-mnt-plan-gid="optional"]').count(), 1);
  assert.equal(await page.locator('#optional-test .mnt-dispositions').count(), 0);
  await page.screenshot({ path: '/tmp/ak-guidance-current.png' });
  assert.deepEqual(errors, []);
});
