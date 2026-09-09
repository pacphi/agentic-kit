import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {renderPage} from '../../src/lib/dashboard/page.mjs';
import {buildContextReport} from '../../src/lib/context-report.mjs';

const measured=value=>({status:'measured',value});
const repo={kind:'git',repositoryId:'repo-one',root:'/projects/example',commonDir:'/projects/example/.git'};
const main={path:'/projects/example',label:'example',hosts:['claude'],remote:{status:'linked',webUrl:'https://example.com/repo'},repository:repo,
 sessionOrigins:[{origin:'claude-desktop',sessions:2},{origin:'unknown',sessions:1}],totalBytes:measured(1024),loc:{total:measured(42),languages:[]}};
const work={path:'/worktrees/feature',label:'feature',repository:{...repo,kind:'worktree'},sessionOrigins:[{origin:'codex-desktop',sessions:1}]};
const other={path:'/missing/project',label:'Unavailable folder',repository:{kind:'unknown'},sessionOrigins:[{origin:'unknown',sessions:1}]};
const capturedAt='2026-09-09T14:00:00Z';
const catalogModels=['claude','opencode'].map(host=>({key:{host,modelId:host+'-example',scopeId:'fixture-scope',provider:host==='opencode'?'example':null},
 capabilities:{contextLimit:200000,outputLimit:32000},evidence:['contextLimit','outputLimit'].map(field=>({field:'capabilities.'+field,
 source:host==='claude'?'anthropic-docs':'opencode-models',capturedAt,scopeFingerprint:'fixture-scope',freshness:'fresh'}))}));
const modelSnapshot={capturedAt,scope:{fingerprint:'fixture-scope'},models:catalogModels,
 sources:['anthropic-docs','opencode-models'].map(id=>({id,scopeFingerprint:'fixture-scope'}))};
const report=buildContextReport({integrations:{hosts:{claude:true,codex:true,opencode:true}},codexContext:{}},{available:true,configuredWindow:1000000,
 cacheFetchedAt:'2026-09-09T14:00:00Z',models:Array.from({length:12},(_,i)=>({model:'model-'+i,nativeWindow:200000,maximumWindow:1000000,effectiveWindow:950000}))},{now:Date.parse(capturedAt),modelSnapshot});

test('context and project grouping stay readable, keyboard operable and evidence-aware',async t=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 let projects={projects:[main],discoveryProjects:[main,work,other],everSeen:measured(3),onDisk:measured(2),count:measured(3)};
 await page.route('http://dashboard.test/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:renderPage({name:'Dashboard fixture',version:'test'})});
  const body=url.pathname==='/api/status'?{overall:'ok',rows:[{subsystem:'codex-context',level:'ok',message:'configured',contextReport:report},{subsystem:'codex-context/model',level:'info',message:'legacy model'}]}:
   url.pathname==='/api/system'?{projects,runtime:{},snapshot:null,scan:null}:{};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
 await page.goto('http://dashboard.test/#token=fixture');
 await page.click('[data-overview-view="runtime"]');
 await page.waitForSelector('#cards-runtime .context-card');
 assert.equal(await page.locator('#cards-runtime .context-card').count(),1);
 assert.doesNotMatch(await page.locator('#cards-runtime .context-card').innerText(),/Current usage|Reporting limits/);
 const card=await page.locator('#cards-runtime .context-card').boundingBox();assert.ok(card.height<520,JSON.stringify(card));
 await page.locator('#cards-runtime .context-host').filter({hasText:'Codex'}).locator('details summary').focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('#cards-runtime .context-host').filter({hasText:'Codex'}).locator('.context-model-scroll tbody tr').count(),12);
 assert.ok((await page.locator('#cards-runtime .context-host').filter({hasText:'Codex'}).locator('.context-model-scroll').boundingBox()).height<=220);
 const shots=path.resolve(process.env.AK_DASHBOARD_EVIDENCE_DIR || '.ui-artifacts/project-context');fs.mkdirSync(shots,{recursive:true});
 await page.screenshot({path:path.join(shots,'context-models-desktop.png'),fullPage:true,animations:"disabled"});
 await page.locator('#cards-runtime .context-host').filter({hasText:'Codex'}).locator('details summary').click();
 await page.screenshot({path:path.join(shots,'context-desktop.png'),fullPage:true,animations:"disabled"});
 await page.locator('#cards-runtime [data-model-inventory]').click();
 await page.waitForSelector('#v-models',{state:'visible'});
 assert.equal(await page.locator('#usage-tab-models').getAttribute('aria-selected'),'true');
 assert.equal(await page.evaluate(()=>globalThis.document.activeElement.id),'usage-tab-models');
 await page.click('#tab-system');await page.click('[data-system-view="projects"]');
 await page.waitForSelector('#project-population');
 assert.equal(await page.locator('#sys-projects tbody tr:not(.project-group)').count(),1);
 await page.selectOption('#project-population','all');
 assert.equal(await page.locator('#sys-projects tbody tr:not(.project-group)').count(),3);
 assert.equal(await page.locator('#sys-projects .project-group').count(),0);
 assert.equal(await page.locator('#sys-projects tbody').count(),2);
 await page.selectOption('#project-origin','codex-desktop');
 assert.equal(await page.locator('#sys-projects tbody tr:not(.project-group)').count(),1);
 assert.match(await page.locator('#sys-projects').innerText(),/feature/);
 assert.equal(await page.evaluate(()=>globalThis.document.activeElement.id),'project-origin');
 await page.selectOption('#project-origin','all');
 await page.screenshot({path:path.join(shots,'system-projects-desktop.png'),fullPage:true,animations:"disabled"});
 for(const width of [768,390]){
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth),`overflow at ${width}`);
  await page.screenshot({path:path.join(shots,'system-projects-'+width+'.png'),fullPage:true,animations:"disabled"});
  await page.click('#tab-overview');await page.click('[data-overview-view="runtime"]');
  assert.ok(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth),`context overflow at ${width}`);
  await page.screenshot({path:path.join(shots,'context-'+width+'.png'),fullPage:true,animations:"disabled"});
  await page.click('#tab-system');await page.click('[data-system-view="projects"]');
 }
 projects={projects:[],discoveryProjects:[],everSeen:measured(0)};
 await page.reload();await page.click('#tab-system');await page.click('[data-system-view="projects"]');
 await page.waitForSelector('#project-population');assert.match(await page.locator('#sys-projects').innerText(),/no project was discovered/);
 assert.deepEqual(errors,[]);
});
