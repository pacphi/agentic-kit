import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './helpers/launch-chrome.mjs';
import { renderPage } from '../../src/lib/dashboard/page.mjs';
import { esc } from '../../src/lib/dashboard/groups.mjs';

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.ui-artifacts');
fs.mkdirSync(SHOTS, { recursive: true });
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
const luminance = color => {
  const rgb = color.match(/[\d.]+/g).slice(0,3).map(Number).map(value => value/255)
    .map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4);
  return rgb[0]*.2126 + rgb[1]*.7152 + rgb[2]*.0722;
};
const contrast = (a,b) => { const values=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (values[0]+.05)/(values[1]+.05); };
test('all hosts have qualified OK, accessible details and explicitly confirmed connection checks', async t => {
  const browser = await launchChrome();
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
  await page.addScriptTag({content:`${esc.toString()}\nfunction authHeaders(){return {'x-dash-token':'fixture'};}\n${source('usage')}\nfunction refreshRunning(){return false;}\nfunction startRefresh(strength){(window.__refreshCalls ||= []).push(strength);return Promise.resolve(true); }\n${source('host-readiness')}\nwireHostHealth();`});
  assert.equal(await page.locator('[data-health-host="codex"] .sp-status').innerText(),'Checking');
  await page.evaluate(data=>globalThis.renderHostReadiness(data),report());
  for(const [host,name] of [['claude','Claude Code'],['codex','Codex'],['opencode','OpenCode']]){
    const badge=page.locator('[data-health-host="'+host+'"]');
    assert.equal(await badge.innerText(),'OK');
    await badge.focus();await page.keyboard.press('Enter');
    await page.waitForFunction(n=>globalThis.document.getElementById('host-health-dialog').open
      &&globalThis.document.getElementById('host-health-title').textContent===n+' health',name);
    assert.match(await page.locator('#host-health-summary').innerText(),/OK · Local checks/);
    assert.equal(await page.locator('#host-health-checks li').count(),5);
    assert.equal(await page.locator('#host-health-connect').isDisabled(),true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(h=>!globalThis.document.getElementById('host-health-dialog').open
      &&globalThis.document.activeElement===globalThis.document.querySelector('[data-health-host="'+h+'"]'),host);
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
  await page.screenshot({path:path.join(SHOTS,'health-details-desktop.png'),animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth>globalThis.innerWidth),false);
  await page.screenshot({path:path.join(SHOTS,'health-details-mobile.png'),animations:'disabled'});
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{
    globalThis.renderSourceHealth({codex:{status:'degraded',reason:'parse-yield-partial'},codexLedger:{status:'ok'}});
    globalThis.document.getElementById('area-overview').hidden=true;
    globalThis.document.getElementById('panel-usage').hidden=false;
  });
  await page.locator('.usage-source-details summary').click();
  assert.match(await page.locator('.source-diagnostics').innerText(),/parse-yield-partial/);
  assert.equal(await page.locator('[data-health-host="codex"] .sp-status').innerText(),'OK');
  const unassessed=report();
  unassessed.hosts.claude={...unassessed.hosts.claude,checks:{...checks,configuration:{state:'unknown',reason:'Configuration was not assessed.'}}};
  await page.evaluate(data=>globalThis.renderHostReadiness(data),unassessed);
  assert.equal(await page.locator('[data-health-host="claude"] .sp-status').innerText(),'Unknown');
  const iconColors=await page.evaluate(() => ['light','dark'].map(theme=>{
    globalThis.document.documentElement.setAttribute('data-theme',theme);
    const chip=globalThis.document.querySelector('[data-health-host="codex"] .live-host');
    return {theme,fill:globalThis.getComputedStyle(chip.querySelector('path')).fill,background:globalThis.getComputedStyle(chip).backgroundColor};
  }));
  for(const row of iconColors) {
    console.log(`Codex icon ${row.theme}: ${row.fill} on ${row.background}, ${contrast(row.fill,row.background).toFixed(2)}:1`);
    assert.ok(contrast(row.fill,row.background)>=3,
      `Codex icon ${row.theme}: ${row.fill} on ${row.background}, ratio ${contrast(row.fill,row.background).toFixed(2)}:1`);
  }
  await page.evaluate(()=>globalThis.renderHostReadiness(null));
  assert.equal(await page.locator('[data-health-host="codex"] .sp-status').innerText(),'Unknown');
  assert.equal(errors.length,0,errors.join('\n'));
});

// ADR-0053 amendment (2026-09-26): management is reported, not treated as health.
const unmanagedReport = () => {
  const data = report();
  data.hosts.claude = { ...data.hosts.claude, management: { state: 'managed', label: 'Managed by ak' }, participation: { participating: true, hint: null } };
  data.hosts.codex = { ...data.hosts.codex, status: 'unmanaged', label: 'Found, not managed', localStatus: 'attention',
    management: { state: 'found', label: 'Found, not managed' }, canCheckConnection: false,
    connectionUnavailable: 'Connection checks run only for hosts managed by ak.',
    participation: { participating: false, hint: 'ak host pick --host claude,codex' },
    checks: { ...checks, authentication: { state: 'fail', reason: 'Codex reports no configured authentication.' },
      integration: { state: 'pass', reason: 'No known blocking transport configuration conflict.', fyi: true } } };
  data.hosts.opencode = { ...data.hosts.opencode, status: 'not-installed', label: 'Not installed', localStatus: 'attention',
    management: { state: 'not-installed', label: 'Not installed' }, canCheckConnection: false,
    connectionUnavailable: 'Connection checks run only for hosts managed by ak.',
    participation: { participating: false, hint: 'ak host pick --host claude,opencode' },
    checks: { installation: { state: 'fail', reason: 'The host executable is not available on PATH.' } } };
  return data;
};

test('unmanaged hosts read their management state everywhere, with information-only checks and a complete enable hint', async t => {
  const browser = await launchChrome();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://health.test/**', async route => {
    const url = new URL(route.request().url());
    if(url.pathname.startsWith('/api/host-health/')){
      requests.push(url.pathname);
      return route.fulfill({contentType:'application/json',body:JSON.stringify(unmanagedReport())});
    }
    return route.fulfill({contentType:'text/html',body:renderPage({name:'Health fixture',version:'test'}).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')});
  });
  await page.goto('http://health.test/');
  await page.addScriptTag({content:`${esc.toString()}\nfunction authHeaders(){return {'x-dash-token':'fixture'};}\n${source('usage')}\nfunction refreshRunning(){return false;}\nfunction startRefresh(strength){(window.__refreshCalls ||= []).push(strength);return Promise.resolve(true); }\n${source('host-readiness')}\nwireHostHealth();`});
  await page.evaluate(data=>globalThis.renderHostReadiness(data),unmanagedReport());

  // Header pills: health for the managed host, the management words otherwise, never amber.
  assert.equal(await page.locator('[data-health-host="claude"] .sp-status').innerText(),'OK');
  assert.match(await page.locator('[data-health-host="claude"]').getAttribute('aria-label'),/Managed by ak/);
  assert.equal(await page.locator('[data-health-host="codex"] .sp-status').innerText(),'Found, not managed');
  assert.equal(await page.locator('[data-health-host="codex"]').getAttribute('data-status'),'unmanaged');
  assert.equal(await page.locator('[data-health-host="opencode"] .sp-status').innerText(),'Not installed');
  assert.equal(await page.locator('[data-health-host="opencode"]').getAttribute('data-status'),'not-installed');

  // Details: the checks still ran and are shown; wiring is FYI; the paid check stays managed-only.
  await page.locator('[data-health-host="codex"]').click();
  assert.match(await page.locator('#host-health-summary').innerText(),/^Found, not managed · Local checks/);
  assert.equal(await page.locator('#host-health-checks li').count(),5);
  assert.match(await page.locator('#host-health-checks li[data-check-key="authentication"]').innerText(),/Needs attention/);
  assert.match(await page.locator('#host-health-checks li[data-check-key="integration"]').innerText(),/FYI/);
  assert.equal(await page.locator('#host-health-consent').isDisabled(),true);
  assert.equal(await page.locator('#host-health-connect').isDisabled(),true);
  assert.match(await page.locator('#host-health-eligibility').innerText(),/managed by ak/);
  assert.match(await page.locator('#host-health-participation').innerText(),/not participating/i);
  assert.equal(await page.locator('#host-health-participation code').innerText(),'ak host pick --host claude,codex');
  assert.equal(await page.locator('#host-health-participation [data-copy]').getAttribute('data-copy'),'ak host pick --host claude,codex');
  assert.equal(await page.locator('#host-health-run-refresh').innerText(),'Refresh');
  await page.locator('#host-health-run-refresh').click();
  assert.deepEqual(await page.evaluate(() => globalThis.__refreshCalls), ['local']);
  assert.deepEqual(requests, []);
  await page.keyboard.press('Escape');

  // Participation view (Overview → Hosts & Routing): one row per host, the hint copyable text.
  await page.evaluate(()=>{globalThis.document.getElementById('area-overview').hidden=false;globalThis.document.getElementById('panel-hosts').hidden=false;});
  await page.evaluate(data=>globalThis.renderHostParticipation(data),unmanagedReport());
  assert.equal(await page.locator('#host-participation-note').innerText(),'1 of 3 managed by ak');
  assert.equal(await page.locator('#host-participation').isHidden(),false);
  assert.equal(await page.locator('#host-participation-list li').count(),3);
  assert.match(await page.locator('#host-participation-list li[data-host="claude"]').innerText(),/Managed by ak/);
  const codexRow = await page.locator('#host-participation-list li[data-host="codex"]').innerText();
  assert.match(codexRow,/Found, not managed/);
  assert.match(codexRow,/not participating/i);
  assert.match(codexRow,/ak host pick --host claude,codex/);
  assert.match(await page.locator('#host-participation-list li[data-host="opencode"]').innerText(),/Not installed/);
  await page.evaluate(()=>globalThis.renderHostParticipation(null));
  assert.equal(await page.locator('#host-participation').isHidden(),true,'no readiness report → no participation claims');

  // About host cards read the same words, from the same report.
  assert.deepEqual(await page.evaluate(data=>globalThis.aboutHostChip('codex',data),unmanagedReport()),
    {state:'unmanaged',word:'Found, not managed',detail:'Not participating: ak routes no work to this host. To include it: ak host pick --host claude,codex'});
  assert.equal(await page.evaluate(data=>globalThis.aboutHostChip('opencode',data).word,unmanagedReport()),'Not installed');
  assert.equal(await page.evaluate(data=>globalThis.aboutHostChip('claude',data).word,unmanagedReport()),'Managed by ak');
  assert.equal(await page.evaluate(()=>globalThis.aboutHostChip('codex',null)),null,'no report → About keeps its row join');
  await page.addScriptTag({content:`var RANK={fail:3,warn:2,ok:1,info:0,unknown:0};\n${source('about')}`});
  const aboutFor=(key,rows,data)=>page.evaluate(([key,rows,data])=>globalThis.aboutState({detectionKey:key,category:'hosts'},{rows,hostReadiness:data}),[key,rows,data]);
  const unmanagedCard=await aboutFor('hosts.codex',[],unmanagedReport());
  assert.equal(unmanagedCard.state,'unmanaged','an unmanaged host is neither "state unknown" nor a warning');
  assert.equal(unmanagedCard.word,'Found, not managed');
  assert.match(unmanagedCard.detail.message,/ak host pick --host claude,codex/);
  const okRow={subsystem:'hosts',level:'ok',message:'claude 2.1.3 (npm)',fix:null};
  const warnRow={subsystem:'hosts',level:'warn',message:'claude auth: none (unknown)',fix:'claude login'};
  assert.deepEqual(await aboutFor('hosts.claude',[okRow],unmanagedReport()).then(st=>[st.state,st.word]),['ok','Managed by ak']);
  const managedWarn=await aboutFor('hosts.claude',[okRow,warnRow],unmanagedReport());
  assert.deepEqual([managedWarn.state,managedWarn.word,managedWarn.detail.message],['warn','Managed by ak','claude auth: none (unknown)']);
  assert.deepEqual(await aboutFor('hosts.claude',[okRow],null).then(st=>[st.state,st.word]),['ok','installed'],'no report → the row join is unchanged');

  await page.setViewportSize({width:390,height:844});
  await page.evaluate(data=>globalThis.renderHostReadiness(data),unmanagedReport());
  assert.equal(await page.evaluate(()=>globalThis.document.documentElement.scrollWidth>globalThis.innerWidth),false);
  await page.screenshot({path:path.join(SHOTS,'health-unmanaged-mobile.png'),animations:'disabled'});
  assert.equal(errors.length,0,errors.join('\n'));
});

test('a dialog close that lands after the user moved on does not steal focus back', async t => {
  const browser = await launchChrome();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://health.test/**', route => route.fulfill({ contentType: 'text/html',
    body: renderPage({ name: 'Health fixture', version: 'test' }).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') }));
  await page.goto('http://health.test/');
  await page.addScriptTag({ content: `${esc.toString()}\nfunction authHeaders(){return {};}\n${source('usage')}\nfunction refreshRunning(){return false;}\nfunction startRefresh(strength){(window.__refreshCalls ||= []).push(strength);return Promise.resolve(true); }\nfunction refreshRunning(){return false;}\nfunction startRefresh(strength){(window.__refreshCalls ||= []).push(strength);return Promise.resolve(true); }\n${source('host-readiness')}\nwireHostHealth();` });
  await page.evaluate(data => globalThis.renderHostReadiness(data), report());
  await page.locator('[data-health-host="claude"]').click();
  // The race, made deterministic: close the dialog and move focus in the SAME
  // task, then wait for the queued `close` event itself. This listener is added
  // after wireHostHealth's, so it runs after the product handler has acted.
  const focused = await page.evaluate(async () => {
    const dialog = globalThis.document.getElementById('host-health-dialog');
    const next = globalThis.document.querySelector('[data-health-host="codex"]');
    const closeEvent = new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
    dialog.close();
    next.focus();
    await closeEvent;
    const active = globalThis.document.activeElement;
    return active && active.getAttribute('data-health-host');
  });
  assert.equal(focused, 'codex');
  assert.deepEqual(errors, []);
});
