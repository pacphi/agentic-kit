import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {esc} from '../../src/lib/dashboard/groups.mjs';
const source=fs.readFileSync(new URL('../../src/lib/dashboard/client/usage-context-hooks.mjs',import.meta.url),'utf8')
 .replace(/^import .*;$/gm,'').replace(/\bexport /g,'');
const scope=vm.createContext({esc});
vm.runInContext(source+'\nglobalThis.api={ctxTokens,contextHostCard};',scope);
const {ctxTokens,contextHostCard}=scope.api;
test('missing token evidence is not rendered as zero',()=>{
 for(const value of [null,undefined,'',NaN])assert.equal(ctxTokens(value),'—');
 assert.equal(ctxTokens(0),'0');
});
test('input-only history explains missing pressure and leaves missing window blank',()=>{
 const html=contextHostCard('claude',{coverage:{sessions:1000,inputMeasured:1000,windowMeasured:0,pressureMeasured:0,state:'partial'},
 inputTokens:{peak:{p90:326000}},windowTokens:null,pressureBps:null});
 assert.match(html,/Input only/);assert.match(html,/326K/);
 assert.match(html,/median window<\/dt><dd>—/);
 assert.doesNotMatch(html,/role="meter"/);
 assert.match(html,/without a recorded context window/);
});
test('no sessions is distinct from sessions lacking context measurements',()=>{
 const empty=contextHostCard('opencode',{coverage:{sessions:0,inputMeasured:0,windowMeasured:0,pressureMeasured:0,state:'not-observed'}});
 assert.match(empty,/No sessions/);assert.match(empty,/No sessions in the selected timeframe/);
 const missing=contextHostCard('opencode',{coverage:{sessions:5,inputMeasured:0,windowMeasured:0,pressureMeasured:0,state:'not-recorded'}});
 assert.match(missing,/Not recorded/);assert.doesNotMatch(missing,/No sessions in/);
});
test('partial paired coverage preserves measured pressure without claiming every session was measured',()=>{
 const html=contextHostCard('codex',{coverage:{sessions:12,inputMeasured:12,windowMeasured:4,pressureMeasured:4,state:'partial'},
 pressureBps:{peak:{p90:9130}},windowTokens:{median:258000},inputTokens:{peak:{p90:236000}}});
 assert.match(html,/91.3%/);assert.match(html,/258K/);assert.match(html,/Sessions with pressure/);
 assert.match(html,/4 of 12 sessions/);
});
