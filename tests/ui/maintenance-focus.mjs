// Real focus queries, public DTOs, page markup and browser modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
import { CSS } from '../../src/lib/dashboard/styles.mjs';
import { baseInventory } from '../fixtures/maintenance/management-fixtures.mjs';
import { runInventoryQuery } from '../../src/lib/maintenance/management/query.mjs';
import { inspectorFor } from '../../src/lib/maintenance/management/guidance.mjs';
import { publicInventoryPage, publicInspector } from '../../src/lib/dashboard/maintenance-api.mjs';
function source(name){return fs.readFileSync(new URL('../../src/lib/dashboard/client/'+name+'.mjs',import.meta.url),'utf8').replace(/^import\s[\s\S]*?from ['"][^'"]+['"];\s*$/gm,'').replace(/\bexport (?=(?:function|var)\b)/g,'');}
test('focus browser progressively narrows to exact installations and preserves filters through relationships',async(t)=>{
 const inventory=structuredClone(baseInventory()),requests=[],errors=[];
 const skillResources=inventory.resources.filter(r=>r.kind==='skill');
 for(const resource of skillResources)resource.presentationFamilyId=skillResources[0].resourceId;
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));
 const markup=renderPage({name:'Fixture',version:'test'}).match(/<section class="mnt-panel mnt-inventory"[\s\S]*?<\/section>/)[0];
 await page.route('http://maintenance.test/**',async route=>{
  const url=new URL(route.request().url());let body;
  if(url.pathname.endsWith('/inventory')){
   const facets={};for(const [k,v] of url.searchParams)if(k.startsWith('facet.'))(facets[k.slice(6)]??=[]).push(v);
   const query={scope:url.searchParams.get('scope')||'across',view:url.searchParams.get('view')||'all',facets,presentation:url.searchParams.get('presentation')||'flat',includeWorktrees:url.searchParams.get('includeWorktrees')==='true',cursor:url.searchParams.get('cursor'),search:url.searchParams.get('search')||''};
   requests.push(query);body=publicInventoryPage(runInventoryQuery(inventory,query));
  }else if(url.pathname.includes('/placements/'))body=publicInspector(inspectorFor(inventory,url.pathname.split('/').pop()));
  else return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+CSS+'</style></head><body>'+markup+'<p id="mnt-status" role="status"></p></body></html>'});
  await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('http://maintenance.test/');
 await page.addScriptTag({content:`
  function authHeaders(){return {};}
  function esc(v){return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');}
  function ago(){return '';}
  function mntWritesBlocked(){return false;}
  ${['maintenance-workspace','maintenance-cards','maintenance-filters','maintenance-language-logos','maintenance-focus','maintenance-relationships','maintenance-guidance','maintenance-inspector','maintenance-inventory'].map(source).join('\n')}
  wireMntInventory();wireMntInspector();loadMntInventory();
 `});
 await page.locator('[data-mnt-focus="user"]').waitFor();
 assert.equal(await page.locator('#mnt-results [data-mnt-plc]').count(),0,'opening shows scope roots only');
 assert.equal(await page.locator('#mnt-results [data-mnt-focus]').count(),4);
 await page.locator('[data-mnt-focus="user"]').click();
 await page.locator('[data-mnt-focus="mcp-registration"]').waitFor();
 assert.equal(requests.at(-1).scope,'user');
 await page.locator('[data-mnt-focus="mcp-registration"]').click();
 const mcp=inventory.placements.find(p=>p.kind==='mcp-registration');
 await page.locator('[data-mnt-focus="'+mcp.resourceId+'"]').click();
 await page.locator('[data-mnt-plc="'+mcp.placementId+'"]').click();
 await page.locator('#mnt-inspector-title').waitFor();
 assert.match(await page.locator('#mnt-breadcrumbs').innerText(),/All scopes.*User.*MCP registration/s);
 assert.deepEqual(requests.at(-1).facets.kind,['mcp-registration']);
 assert.deepEqual(requests.at(-1).facets.family,[mcp.resourceId]);
 assert.match(await page.locator('#mnt-inspector').innerText(),/Relationships/);
 await page.locator('#mnt-inspector-back').click();
 assert.equal(await page.locator('[data-mnt-plc="'+mcp.placementId+'"]').evaluate(el=>el===globalThis.document.activeElement),true);
 await page.locator('[data-mnt-back="scope"]').click();
 await page.locator('[data-mnt-focus="skill"]').click();
 const skill=inventory.placements.find(p=>p.kind==='skill');
 await page.locator('[data-mnt-focus="'+skill.resourceId+'"]').click();
 await page.locator('[data-mnt-plc="'+skill.placementId+'"]').click();
 await page.locator('.mnt-relationship').filter({hasText:'Available to'}).locator('summary').click();
 assert.match(await page.locator('#mnt-inspector').innerText(),/Claude/);
 assert.match(await page.locator('#mnt-inspector').innerText(),/Codex/);
 await page.locator('.mnt-relationship').filter({hasText:'Also installed'}).locator('summary').click();
 await page.locator('[data-mnt-related]').first().click();
 await page.locator('#mnt-related-back').waitFor();
 assert.match(await page.locator('.mnt-related-context').innerText(),/filters are unchanged/);
 assert.equal(await page.evaluate(()=>globalThis.MNT.scope),'user');
 await page.locator('#mnt-related-back').click();
 await page.locator('#mnt-inspector-title').waitFor();
 await page.screenshot({path:'/tmp/ak-focus-implemented-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('#mnt-inspector').evaluate(el=>globalThis.getComputedStyle(el).position),'static');
 assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth<=globalThis.innerWidth),true);
 await page.locator('#mnt-inspector-back').click();
 await page.locator('[data-mnt-back="root"]').click();
 await page.locator('[data-mnt-focus="user"]').waitFor();
 await page.locator('[data-mnt-focus="system"]').focus();await page.keyboard.press('ArrowDown');
 assert.equal(await page.locator('[data-mnt-focus="machine"]').evaluate(el=>el===globalThis.document.activeElement),true);
 await page.screenshot({path:'/tmp/ak-focus-implemented-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
});

test('polyglot cards expose labelled language badges and an accessible disclosure',async(t)=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1100,height:650}});
 const languages=[['rust','Rust','Rs'],['typescript','TypeScript','TS'],['javascript','JavaScript','JS'],['python','Python','Py'],['java','Java','Jv']].map(([id,name,icon])=>({id,name,icon,evidence:'source'}));
 const state={facets:{},query:{navigation:{level:'project',nodes:[{value:'prj_example',label:'billing-service',count:24,projectKind:'git',languages}]},groups:[]}};
 await page.setContent('<!doctype html><html data-theme="dark"><head><style>'+CSS+'</style></head><body><main style="padding:32px"><h2>Projects</h2><div id="cards"></div></main></body></html>');
 await page.addScriptTag({content:'var MNT='+JSON.stringify(state)+';var MNT_SCOPE_LABELS={};function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");}function mntKindLabel(s){return s;}function mntFacetValueLabel(_,s){return s;}function mntIcon(){return "";}function mntAvailableTo(){return "";}\n'+source('maintenance-language-logos')+'\n'+source('maintenance-focus')+'\ndocument.getElementById("cards").innerHTML=renderMntFocusResults(false);'});
 assert.equal(await page.locator('.mnt-language-icon:visible').count(),3);
 await page.getByText('+2 more languages',{exact:true}).focus();
 await page.keyboard.press('Enter');
 assert.equal(await page.locator('.mnt-language-icon:visible').count(),5);
 assert.equal(await page.getByRole('img', { name: 'Python — Source language detected', exact: true }).isVisible(),true);
 await page.screenshot({path:'/tmp/ak-polyglot-projects-svg.png'});
 await page.emulateMedia({colorScheme:'light'});
 await page.locator('html').evaluate(el=>el.setAttribute('data-theme','light'));
 await page.screenshot({path:'/tmp/ak-polyglot-projects-svg-light.png'});
});
