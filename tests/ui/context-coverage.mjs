import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {renderPage} from '../../src/lib/dashboard/page.mjs';
import {buildContextProjection} from '../../src/lib/usage-context.mjs';
import {blankSession,noteContextSample} from '../../src/lib/usage-parsers.mjs';
const claude=blankSession('cl','claude'),codex=blankSession('cx','codex'),older=blankSession('old','codex');
const claudeSub=blankSession('cs','claude');claudeSub.sidechain=true;
noteContextSample(claude,326000);noteContextSample(codex,90000,100000);noteContextSample(older,50000);noteContextSample(claudeSub,180000);

test('Context distinguishes input-only, partial paired coverage and no sessions without zero windows',async t=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const projection=buildContextProjection([claude,codex,older,claudeSub],{windowDays:30});
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
 assert.equal(await cards.nth(0).locator('.ctx-facts dd').first().innerText(),'1','main sessions only: the sidechain is not pooled in');
 assert.match(await cards.nth(0).locator('.ctx-subagents').innerText(),/Subagent sessions.*1 · p90 peak input 180K · pressure not measured/s);
 assert.equal(await cards.nth(1).locator('.ctx-subagents').count(),0);
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

test('Context pressure tooltips are focusable and state each host formula; empty state follows source health',async t=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 let health={claude:{status:'ok'},codex:{status:'ok'},opencode:{status:'absent',reason:'absent'}};
 const projection=buildContextProjection([claude,codex],{windowDays:30});
 await page.route('http://context-health.test/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:renderPage({name:'Context health fixture',version:'test'})});
  const body=url.pathname==='/api/usage'?{context:projection,sourceHealth:health,totals:{},sessions:[]}:
   url.pathname==='/api/status'?{overall:'ok',rows:[]}:{};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('http://context-health.test/#token=fixture');
 await page.click('#tab-usage');await page.click('#usage-tab-context');
 const cards=page.locator('#u-ctx-hosts .ctx-card');await cards.first().waitFor();
 const expected=[/statusline reported for that session/,/last_token_usage\.input_tokens ÷ model_context_window/,/catalogue maximum is deliberately not used/];
 for(let i=0;i<3;i++){
  const area=cards.nth(i).locator('.ctx-pressure');
  assert.equal(await area.getAttribute('tabindex'),'0');
  assert.match(await area.getAttribute('title'),expected[i]);
  await area.focus();
  assert.equal(await page.evaluate(()=>globalThis.document.activeElement.className),'ctx-pressure');
  const id=await area.getAttribute('aria-describedby');
  assert.match(await page.locator('#'+id).textContent(),expected[i]);
 }
 assert.match(await cards.nth(2).innerText(),/Not installed/);
 health={claude:{status:'ok'},codex:{status:'ok'},opencode:{status:'ok'}};
 await page.reload();await page.click('#tab-usage');await page.click('#usage-tab-context');
 await page.locator('#u-ctx-hosts .ctx-card').nth(2).waitFor();
 assert.match(await page.locator('#u-ctx-hosts .ctx-card').nth(2).innerText(),/installed and readable/);
 health={claude:{status:'ok'},codex:{status:'ok'},opencode:{status:'degraded',reason:'schema'}};
 await page.reload();await page.click('#tab-usage');await page.click('#usage-tab-context');
 await page.locator('#u-ctx-hosts .ctx-card').nth(2).waitFor();
 assert.match(await page.locator('#u-ctx-hosts .ctx-card').nth(2).innerText(),/Source unreadable[\s\S]*could not be read \(schema\)/);
 assert.deepEqual(errors,[]);
});
