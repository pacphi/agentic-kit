import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
import { esc } from '../../src/lib/dashboard/groups.mjs';

const source = name => fs.readFileSync(new URL('../../src/lib/dashboard/client/'+name+'.mjs', import.meta.url), 'utf8')
  .replace(/^import\s[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '')
  .replace(/\bexport (?=(?:function|var)\b)/g, '');
const checks = Object.fromEntries(['installation','configuration','authentication','model','integration']
  .map(key => [key, { state: 'pass', reason: 'Local evidence confirmed' }]));
const report = () => ({ checkedAt: '2026-09-20T10:00:00Z', scope: 'Dashboard launch directory', project: 'agentic-kit',
  hosts: Object.fromEntries(['claude','codex','opencode'].map(host => [host, {
    host, status: 'ok', level: 'local', checks, evidenceKey: 'a'.repeat(64), canCheckConnection: true,
    checkedAt: '2026-09-20T10:00:00Z', connection: { state: 'not-run' }, target: { nativeDefault: true },
  }])) });

test('all hosts have qualified OK, accessible details and explicitly confirmed connection checks', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('http://health.test/**', async route => {
    const url = new URL(route.request().url());
    if(url.pathname.startsWith('/api/host-health/')){
      const body=route.request().postDataJSON();requests.push({url:url.pathname,body});
      const data=report();
      if(url.pathname.endsWith('/connection')){
        await gate;
        data.hosts[body.host]={...data.hosts[body.host],level:'connected',evidenceKey:'b'.repeat(64),connection:{state:'pass',reason:'Provider responded',checkedAt:'2026-09-20T10:00:30Z'}};
      }
      return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    }
    return route.fulfill({contentType:'text/html',body:renderPage({name:'Health fixture',version:'test'}).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')});
  });
  await page.goto('http://health.test/');
  await page.addScriptTag({content:`${esc.toString()}\nfunction authHeaders(){return {'x-dash-token':'fixture'};}\n${source('usage')}\n${source('host-readiness')}\nwireHostHealth();`});
  assert.equal(await page.locator('[data-health-host="codex"] .sp-status').innerText(),'Checking');
  await page.evaluate(data=>globalThis.renderHostReadiness(data),report());
  for(const [host,name] of [['claude','Claude Code'],['codex','Codex'],['opencode','OpenCode']]){
    const badge=page.locator('[data-health-host="'+host+'"]');
    assert.equal(await badge.innerText(),'OK');
    await badge.focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#host-health-title').innerText(),name+' health');
    assert.match(await page.locator('#host-health-summary').innerText(),/OK · Local checks/);
    assert.equal(await page.locator('#host-health-checks li').count(),5);
    assert.equal(await page.locator('#host-health-connect').isDisabled(),true);
    await page.keyboard.press('Escape');
    assert.equal(await badge.evaluate(el=>el===globalThis.document.activeElement),true);
  }
  assert.equal(requests.length,0);
  await page.locator('[data-health-host="opencode"]').click();
  await page.locator('#host-health-consent').check();
  await page.locator('#host-health-connect').click();
  await page.waitForFunction(()=>globalThis.document.getElementById('host-health-summary').textContent.includes('Checking'));
  assert.equal(await page.locator('#host-health-connect').isDisabled(),true);
  release();
  await page.waitForFunction(()=>globalThis.document.getElementById('host-health-summary').textContent.includes('Connected'));
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0].body,{host:'opencode',confirm:true,evidenceKey:'a'.repeat(64)});
  assert.equal(await page.locator('#host-health-consent').isChecked(),false);
  assert.match(await page.locator('#host-health-integrations').innerText(),/Optional MCP tool connections are not tested/);
  await page.screenshot({path:'/tmp/ak-health-details-desktop.png',animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth>globalThis.innerWidth),false);
  await page.screenshot({path:'/tmp/ak-health-details-mobile.png',animations:'disabled'});
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{
    globalThis.renderSourceHealth({codex:{status:'degraded',reason:'parse-yield-partial'},codexLedger:{status:'ok'}});
    globalThis.document.getElementById('area-overview').hidden=true;
    globalThis.document.getElementById('panel-usage').hidden=false;
  });
  await page.locator('.usage-source-details summary').click();
  assert.match(await page.locator('.source-diagnostics').innerText(),/parse-yield-partial/);
  assert.equal(await page.locator('[data-health-host="codex"] .sp-status').innerText(),'OK');
  await page.evaluate(()=>globalThis.renderHostReadiness(null));
  assert.equal(await page.locator('[data-health-host="codex"] .sp-status').innerText(),'Unknown');
  assert.equal(errors.length,0,errors.join('\n'));
});
