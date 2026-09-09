// Real dashboard: a bounded Git-project spend ranking, never inferred by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { renderPage } from '../../src/lib/dashboard/page.mjs';

const gitProjects = Array.from({length:12},(_,index)=>({key:'repo-'+index,label:'Git project '+index,
 cost:120-index*10,sessions:3,minutes:90,tokens:1000})).reverse();
const totals={cost:1000,sessions:40,spanMinutes:500,tokens:12000};

test('Usage Projects shows top ten Git projects and follows the timeframe without changing overall totals',async t=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],windows=[];
 page.on('pageerror',error=>errors.push(error.message));
 let legacy=false;
 await page.route('http://usage-projects.test/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:renderPage({name:'Usage Projects fixture',version:'test'})});
  let body={};
  if(url.pathname==='/api/status')body={overall:'ok',rows:[]};
  if(url.pathname==='/api/usage'){
   windows.push(url.searchParams.get('days'));
   body={totals,sessions:[],byProject:{'agent-xxx':{cost:220},'user-root':{cost:100}}};
   if(!legacy)body.gitProjects=url.searchParams.get('days')==='7'?gitProjects.slice(0,2):gitProjects;
  }
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
 await page.goto('http://usage-projects.test/#token=fixture');await page.click('#tab-usage');
 const panel=page.locator('#u-projects');await panel.locator('.mrow').first().waitFor();
 assert.equal(await panel.locator('.mrow').count(),10);
 assert.match(await page.locator('#u-projects-note').innerText(),/top 10 of 12/);
 assert.match(await panel.locator('.mrow').first().innerText(),/Git project 0.*\$120/s);
 assert.doesNotMatch(await panel.innerText(),/agent-xxx|user-root|Desktop|Show all/);
 assert.equal(await panel.locator('details').count(),0);
 assert.match(await page.locator('#u-hero').innerText(),/\$1,000/);
 const shots=process.env.AK_UI_ARTIFACTS;
 if(shots)fs.mkdirSync(shots,{recursive:true});
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1050});
  assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth),true);
  if(shots)await page.screenshot({path:path.join(shots,'usage-project-groups-'+width+'.png'),fullPage:true,animations:'disabled'});
 }
 // The existing timeframe control remains the only scope for this ranking.
 const seven=page.locator('#usage-days [data-days="7"]');
   await seven.click();await page.waitForFunction(()=>globalThis.document.querySelectorAll('#u-projects .mrow').length===2);
  assert.equal(windows.at(-1),'7');
 legacy=true;await page.reload();await page.click('#tab-usage');
 await page.waitForFunction(()=>globalThis.document.getElementById('u-projects').textContent.includes('Refresh usage'));
 assert.doesNotMatch(await panel.innerText(),/agent-xxx|user-root/);
 assert.deepEqual(errors,[]);
});
