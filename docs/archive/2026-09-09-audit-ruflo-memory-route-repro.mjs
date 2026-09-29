import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
// Run with the installed @claude-flow/cli/dist/src directory as argv[2].
// Only a newly created temporary corpus is read/written; it is removed at end.
const base=process.argv[2];
if(!base||!fs.existsSync(path.join(base,'memory/memory-initializer.js')))throw Error('Pass the installed @claude-flow/cli/dist/src directory');
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'ruflo-3196-'));
fs.mkdirSync(path.join(sandbox,'.swarm'));
const env={...process.env,CLAUDE_FLOW_MEMORY_PATH:path.join(sandbox,'.swarm'),CLAUDE_FLOW_ENCRYPT_AT_REST:'0',RUFLO_DAEMON_AUTOSTART:'0',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'};
delete env.CLAUDE_FLOW_DB_PATH; delete env.CLAUDE_FLOW_DISABLE_BRIDGE;
const mod=relative=>JSON.stringify(pathToFileURL(path.join(base,relative)).href);
function run(label,code){
 const result=spawnSync(process.execPath,['--input-type=module','-e',`${code}\nconst {shutdownBridge}=await import(${mod('memory/memory-bridge.js')});await shutdownBridge();process.exit(0);`],{cwd:sandbox,env,encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024});
 const lines=result.stdout?.split('\n').filter(s=>s.startsWith('PROBE:'))??[];
 console.log(JSON.stringify({label,exit:result.status,error:result.error?.message,result:lines.map(s=>JSON.parse(s.slice(6)))}));
 if(result.status!==0||lines.length!==1)throw Error('probe failed');
 return JSON.parse(lines[0].slice(6));
}
try{
const put=run('CLI-shaped store with explicit resolved path',`const {storeEntry,resolveDbPath}=await import(${mod('memory/memory-initializer.js')}); const r=await storeEntry({key:'cli-key',namespace:'route-proof',value:'synthetic-cli-value',dbPath:resolveDbPath(),generateEmbeddingFlag:false,upsert:true});console.log('PROBE:'+JSON.stringify({success:r.success,dbPath:r.dbPath,error:r.error}));`);
if(!put.success)throw Error('seed write failed');
const mcpGet=run('actual MCP retrieve handler fresh process',`const {memoryTools}=await import(${mod('mcp-tools/memory-tools.js')});const r=await memoryTools.find(t=>t.name==='memory_retrieve').handler({key:'cli-key',namespace:'route-proof'});console.log('PROBE:'+JSON.stringify(r));`);
const mcpPut=run('actual MCP store handler fresh process',`const {memoryTools}=await import(${mod('mcp-tools/memory-tools.js')});const r=await memoryTools.find(t=>t.name==='memory_store').handler({key:'mcp-key',namespace:'route-proof',value:'synthetic-mcp-value'});console.log('PROBE:'+JSON.stringify(r));`);
if(!mcpPut.success)throw Error('MCP seed write failed');
const cliGet=run('CLI-shaped retrieve default fresh process',`const {getEntry,resolveDbPath}=await import(${mod('memory/memory-initializer.js')});const r=await getEntry({key:'mcp-key',namespace:'route-proof',dbPath:resolveDbPath()});console.log('PROBE:'+JSON.stringify({found:r.found}));`);
const explicitGet=run('CLI-shaped retrieve explicit sibling fresh process',`const {getEntry}=await import(${mod('memory/memory-initializer.js')});const r=await getEntry({key:'mcp-key',namespace:'route-proof',dbPath:${JSON.stringify(path.join(sandbox,'.swarm/agentdb-memory.db'))}});console.log('PROBE:'+JSON.stringify({found:r.found}));`);
console.log(JSON.stringify({splitReproduced:mcpGet.found===false&&cliGet.found===false&&explicitGet.found===true}));
for(const name of ['memory.db','agentdb-memory.db']){const db=new DatabaseSync(path.join(sandbox,'.swarm',name),{readOnly:true});console.log(JSON.stringify({file:name,keys:db.prepare("SELECT key FROM memory_entries WHERE namespace='route-proof' AND (status='active' OR status IS NULL) ORDER BY key").all()}));db.close();}
}finally{fs.rmSync(sandbox,{recursive:true,force:true});}
