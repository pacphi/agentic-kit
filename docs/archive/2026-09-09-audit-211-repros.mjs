// Synthetic, opt-in documentation-audit reproduction against the current checkout.
// Baseline findings: 67fb5c0 (2026-09-09). This is not a CI gate or a host probe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { parseSession } = await import('../../src/lib/usage-opencode.mjs');
const { parseCodex } = await import('../../src/lib/usage-parsers.mjs');
const { sessionPayload } = await import('../../src/lib/usage-aggregate.mjs');
const { costOf } = await import('../../src/lib/pricing.mjs');
const { undoAqeRouter } = await import('../../src/lib/aqe-router.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-audit-synthetic-'));
const T = Date.parse('2026-09-09T12:00:00Z');
const results = [];
try {
  const dbFile = path.join(tmp, 'opencode.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT, time_created INTEGER);
    CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT, session_id TEXT, message_id TEXT, data TEXT);`);
  const s = db.prepare('INSERT INTO session VALUES (?, ?, ?, NULL, ?)');
  const m = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  function addCase(id, costs) {
    s.run(id, tmp, id, T);
    for (const [i, c] of costs.entries()) m.run(`${id}-${i}`, id, T+i*1000,
      JSON.stringify({role:'assistant', modelID:'gpt-5.6-sol', providerID:'openai',
      time:{created:T+i*1000}, tokens:{input:1000000,output:0,cache:{read:0,write:0}},
      ...(c === 'absent' ? {} : {cost:c})}));
  }
  addCase('null-cost',[null]);
  addCase('missing-cost',['absent']);
  addCase('mixed-cost',[0.25,'absent']);
  db.close();
  for (const [id, expected] of [['null-cost',4],['missing-cost',4],['mixed-cost',4.25]]) {
    const parsed = parseSession({dbFile,id});
    if (!parsed) throw new Error(`parse failed ${id}`);
    const actual = sessionPayload(parsed.session,parsed.turns,{costOf}).meta.cost;
    results.push({issue:'OpenCode cost coverage',case:id,inputTokens:parsed.session.usage[0].input,
      retainedCostObserved:parsed.session.usage[0].costObserved,expectedCostWithMissingEstimated:expected,
      actualCost:actual,pass:actual===expected});
  }
  const evt=(type,payload,i=0)=>({type,timestamp:new Date(T+i*1000).toISOString(),payload});
  const ctxRaw=[evt('session_meta',{id:'ctx-synthetic',cwd:tmp,thread_source:'user'}),
    evt('event_msg',{type:'task_started',model_context_window:200000},1),
    evt('event_msg',{type:'token_count',info:{last_token_usage:{input_tokens:100000},
      total_token_usage:{input_tokens:100000,output_tokens:1,cached_input_tokens:0}}},2),
    evt('event_msg',{type:'agent_message',message:'synthetic reply'},3)].map(JSON.stringify).join('\n');
  const ctx = parseCodex(ctxRaw,{id:'ctx-synthetic'}).session;
  const js=fs.readFileSync(`${root}/src/lib/dashboard/client/usage.mjs`,'utf8');
  const snippet=js.slice(js.indexOf('  function ctxChip(sx){'),js.indexOf('  function sessionChips(sx){'));
  const ctxChip=vm.runInNewContext(`(${snippet.trim()})`,{esc:String,fmtTok:String});
  results.push({issue:'Session context chip',input:ctx.ctxLastTokens,window:ctx.ctxWindow,
    evidenceState:ctx.contextEvidence.state,pairedSamples:ctx.contextEvidence.pressure?.samples??null,
    expected:'No pressure percentage for independently observed input/window',actualHtml:ctxChip(ctx),pass:ctxChip(ctx)===''});
  const project=path.join(tmp,'project');fs.mkdirSync(path.join(project,'.git'),{recursive:true});
  const routerDir=path.join(project,'.agentic-qe');fs.mkdirSync(routerDir);
  const routerFile=path.join(routerDir,'llm-config.json');
  const prior={defaultProvider:'gemini',userKey:'original'};
  const current={_managedBy:'agentic-kit',defaultProvider:'openai',userKey:'edited-after-setup',newUserKey:'keep-me'};
  fs.writeFileSync(routerFile,JSON.stringify(current));fs.writeFileSync(`${routerFile}.bak`,JSON.stringify(prior));
  const outcome=undoAqeRouter(project),after=JSON.parse(fs.readFileSync(routerFile,'utf8'));
  results.push({issue:'Legacy router undo',before:current,outcome,after,
    expected:'Preserve later user edits or refuse drift',actualLostKeys:Object.keys(current).filter(key=>!(key in after)),
    pass:after.newUserKey===current.newUserKey&&after.userKey===current.userKey});
  const rollRoot=path.join(tmp,'rollouts');const dayDir=path.join(rollRoot,'2026','09','09');fs.mkdirSync(dayDir,{recursive:true});
  const rateRaw=[evt('session_meta',{id:'price-synthetic',cwd:tmp,thread_source:'user'}),
    evt('turn_context',{model:'gpt-5.6-sol'},1),
    evt('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:1000000,output_tokens:0,cached_input_tokens:0}}},2),
    evt('event_msg',{type:'agent_message',message:'synthetic reply'},3)].map(JSON.stringify).join('\n');
  fs.writeFileSync(path.join(dayDir,'rollout-price-synthetic.jsonl'),rateRaw);
  const diagnostic=JSON.parse(execFileSync(process.execPath,[`${root}/scripts/codex-usage-diagnostic.mjs`,'--root',rollRoot,'--json'],{encoding:'utf8'}));
  const modernPrice=sessionPayload(parseCodex(rateRaw,{id:'price-synthetic'}).session,[],{costOf}).meta.cost;
  results.push({issue:'Legacy diagnostic pricing',model:'gpt-5.6-sol',inputTokens:1000000,
    currentParserPrice:modernPrice,diagnosticPrice:diagnostic.tokens.afterFix_excludingSubagentReplays.cost,
    pass:modernPrice===diagnostic.tokens.afterFix_excludingSubagentReplays.cost});
  const humanOutput=execFileSync(process.execPath,[`${root}/scripts/codex-usage-diagnostic.mjs`,'--root',rollRoot],{encoding:'utf8'});
  results.push({issue:'Legacy diagnostic privacy',claims:humanOutput.split('\n').filter(x=>/No prompts|safe to paste/.test(x)),
    actualPathLine:humanOutput.split('\n').find(x=>x.startsWith('Rollout files scanned root:'))??null,
    pass:!humanOutput.includes(rollRoot)});
  fs.rmSync(path.join(dayDir,'rollout-price-synthetic.jsonl'));
  const replayRaw=[evt('session_meta',{id:'child-synthetic',cwd:tmp,thread_source:'subagent'}),
    evt('session_meta',{id:'parent-synthetic',cwd:tmp,thread_source:'user'},1),
    evt('turn_context',{model:'gpt-5.6-sol'},2),
    evt('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:1000000,output_tokens:0,cached_input_tokens:0}}},3),
    evt('event_msg',{type:'agent_message',message:'synthetic reply'},4)].map(JSON.stringify).join('\n');
  fs.writeFileSync(path.join(dayDir,'rollout-child-synthetic.jsonl'),replayRaw);
  const replayDiag=JSON.parse(execFileSync(process.execPath,[`${root}/scripts/codex-usage-diagnostic.mjs`,'--root',rollRoot,'--json'],{encoding:'utf8'}));
  const currentReplay=parseCodex(replayRaw,{id:'child-synthetic'}).session;
  results.push({issue:'Legacy diagnostic replay',currentThreadSource:currentReplay.threadSource,
    currentUsageRows:currentReplay.usage.length,diagnosticThreadSources:replayDiag.threadSourceCounts,
    diagnosticAfterTokens:replayDiag.tokens.afterFix_excludingSubagentReplays.total,
    pass:replayDiag.threadSourceCounts.subagent===1&&replayDiag.tokens.afterFix_excludingSubagentReplays.total===0});
  const primarySources=['src/lib/usage-opencode.mjs','src/lib/usage-parsers.mjs','src/lib/usage-aggregate.mjs','src/lib/pricing.mjs','src/lib/aqe-router.mjs','src/lib/provider-ownership.mjs','src/lib/usage-cost.mjs','src/lib/dashboard/client/usage.mjs','scripts/codex-usage-diagnostic.mjs'];
  const sourceDigests=Object.fromEntries(primarySources.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
  console.log(JSON.stringify({referenceBaseline:'67fb5c0',sourceCheckout:'current checkout',sourceDigests,syntheticOnly:true,results},null,2).split(tmp).join('<temporary-root>'));
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
