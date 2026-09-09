import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRows, groupCard } from '../../src/lib/dashboard/groups.mjs';

test('context rows share one card while retaining severity and original rows', () => {
  const rows = [{subsystem:'codex-context',level:'warn',message:'drift'},
    {subsystem:'codex-context/model',level:'info',message:'model detail'}];
  const groups = groupRows(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].level, 'warn');
  assert.deepEqual(groups[0].rows, rows);
});
test('structured context renders host differences and model columns once behind disclosure', () => {
  const report = {hosts:[{host:'codex',label:'Codex',managed:true,source:'native-catalog-and-user-config',
    observedAt:'2026-09-09T15:00:00Z',cacheFetchedAt:'2026-09-09T14:00:00Z',configuredRequest:1000000,
    compaction:{configuredThreshold:800000},models:[{model:'sample',nativeWindow:200000,maximumWindow:1000000,effectiveWindow:950000}],
    limitations:['Running session unverified']}, {host:'claude',label:'Claude',managed:false,models:[],limitations:['Native controls not inspected']} ]};
  const html = groupCard(groupRows([{subsystem:'codex-context',level:'ok',message:'old repeated label',contextReport:report}])[0]);
  assert.match(html, /<details/);
  assert.match(html, /Maximum/);
  assert.match(html, /950,000/);
  assert.match(html, /Claude/);
  assert.match(html, /unknown/i);
  assert.doesNotMatch(html, /old repeated label/);
});
test('legacy context facts and remediation remain accessible without structured metadata', () => {
  const html = groupCard(groupRows([{subsystem:'codex-context',level:'warn',message:'unavailable',fix:'repair'}])[0]);
  assert.match(html,/unavailable/);
  assert.match(html,/repair/);
});
