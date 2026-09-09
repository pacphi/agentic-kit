import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {renderPage} from '../../src/lib/dashboard/page.mjs';
import {buildContextProjection} from '../../src/lib/usage-context.mjs';
import {blankSession,noteContextSample} from '../../src/lib/usage-parsers.mjs';
const claude=blankSession('cl','claude'),codex=blankSession('cx','codex'),older=blankSession('old','codex');
noteContextSample(claude,326000);noteContextSample(codex,90000,100000);noteContextSample(older,50000);

test('Context distinguishes input-only, partial paired coverage and no sessions without zero windows',async t=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const projection=buildContextProjection([claude,codex,older],{windowDays:30});
 await page.route('http://context-coverage.test/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:renderPage({name:'Context coverage fixture',version:'test'})});
  const body=url.pathname==='/api/usage'?{context:projection,totals:{},sessions:[]}:
   url.pathname==='/api/status'?{overall:'ok',rows:[]}:{};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
 await page.goto('http://context-coverage.test/#token=fixture');
 await page.click('#tab-usage');await page.click('#usage-tab-context');
 await page.locator('#u-ctx-hosts .ctx-card').first().waitFor();
 const cards=page.locator('#u-ctx-hosts .ctx-card');
 assert.equal(await cards.count(),3);
 assert.match(await cards.nth(0).innerText(),/Input only/);
 assert.equal(await cards.nth(0).locator('[role="meter"]').count(),0);
 assert.equal(await cards.nth(0).locator('.ctx-facts dd').nth(3).innerText(),'—');
 assert.match(await cards.nth(1).innerText(),/Partial coverage/);
 assert.equal(await cards.nth(1).locator('[role="meter"]').getAttribute('aria-valuenow'),'90.0');
 assert.match(await cards.nth(1).innerText(),/1 of 2 sessions/);
 assert.match(await cards.nth(2).innerText(),/No sessions in the selected timeframe/);
 assert.equal(await cards.nth(2).locator('.ctx-facts dd').nth(2).innerText(),'—');
 const shots=process.env.AK_UI_ARTIFACTS;if(shots)fs.mkdirSync(shots,{recursive:true});
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth),true);
  if(shots)await page.screenshot({path:path.join(shots,'context-coverage-'+width+'.png'),fullPage:true,animations:'disabled'});
 }
 assert.deepEqual(errors,[]);
});
