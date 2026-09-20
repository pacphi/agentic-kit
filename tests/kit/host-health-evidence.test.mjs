import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostHealthSnapshot } from '../../src/lib/host-health-evidence.mjs';

test('evidence changes with configuration, credentials, environment and scope without exposing them', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ak-health-evidence-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json'),env={PATH:'',API_KEY:'SECRET'};
  const snapshot=createHostHealthSnapshot({env,inputPaths:()=>[file]});
  const options={cwd:dir,cfg:{enabled:true}};
  const absent=snapshot(options);
  fs.writeFileSync(file,'{"model":"first"}');
  const first=snapshot(options);
  assert.notEqual(first.key,absent.key);
  assert.deepEqual(first,snapshot(options));
  fs.writeFileSync(file,'{"model":"second"}');
  assert.notEqual(snapshot(options).key,first.key);
  const before=snapshot(options);env.API_KEY='NEW_SECRET';
  assert.notEqual(snapshot(options).key,before.key);
  assert.notEqual(snapshot({...options,cwd:path.join(dir,'other')}).key,snapshot(options).key);
  assert.ok(!JSON.stringify(snapshot(options)).includes('SECRET'));
  assert.match(snapshot(options).key,/^[a-f0-9]{64}$/);
});

test('unbounded or non-file sources prevent source-bound connected claims', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ak-health-bound-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const snapshot=createHostHealthSnapshot({env:{PATH:''},inputPaths:()=>[dir]});
  assert.equal(snapshot({cwd:dir,cfg:{}}).complete,false);
  const file=path.join(dir,'large');fs.writeFileSync(file,'x'.repeat(2*1024*1024+1));
  const large=createHostHealthSnapshot({env:{PATH:''},inputPaths:()=>[file]});
  assert.equal(large({cwd:dir,cfg:{}}).complete,false);
});

test('Claude usage bookkeeping does not invalidate health but transport changes do', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ak-health-claude-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'.claude.json');
  const snapshot=createHostHealthSnapshot({env:{PATH:''},inputPaths:()=>[file]});
  const write=count=>fs.writeFileSync(file,JSON.stringify({startupCount:count,mcpServers:{},projects:{[dir]:{lastCost:count}}}));
  write(1);const original=snapshot({cwd:dir,cfg:{}});
  write(2);assert.deepEqual(snapshot({cwd:dir,cfg:{}}),original);
  fs.writeFileSync(file,JSON.stringify({mcpServers:{new:{command:'tool'}},projects:{}}));
  assert.notEqual(snapshot({cwd:dir,cfg:{}}).key,original.key);
});
