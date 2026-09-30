import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessScope } from '../live/aqe-live-lock-process.mjs';
import { createMcpSession } from '../live/aqe-mcp-session.mjs';
import { spawnEnv } from './helpers/home-sandbox.mjs';

async function fixture(script, check, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-aqe-mcp-protocol-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const scope = createProcessScope(new AbortController().signal);
  let session;
  try {
    const run = scope.launch(process.execPath, ['-e', script], { cwd: root, env: spawnEnv(home) }, { pipeInput: true });
    session = createMcpSession(run, { timeoutMs: 2000, ...options });
    await check(session);
  } finally {
    session?.dispose();
    await scope.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const responder = (tools = '[{name:"aqe_health",inputSchema:{type:"object"}}]') => `
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const r=JSON.parse(line);if(!r.id)return;
const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,serverInfo:{name:'fixture',version:'1'}}:{tools:${tools}};
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`;

test('MCP discovery proves protocol and tools before reporting readiness', async () => {
  await fixture(responder(), async (session) => {
    assert.deepEqual(await session.discover(), { protocolVersion: '2025-03-26',
      serverInfo: { name: 'fixture', version: '1' }, toolCount: 1 });
  });
});

test('MCP discovery rejects malformed tool schemas', async () => {
  await fixture(responder('[{name:"aqe_health"}]'), async (session) => {
    await assert.rejects(session.discover(), /tools\/list schema/);
  });
});

test('MCP discovery rejects a child that exits instead of replying', async () => {
  await fixture('process.stdin.resume();process.stdin.once("data",()=>process.exit(0))', async (session) => {
    await assert.rejects(session.discover(), /closed before request/);
  });
});

test('MCP discovery has a bounded deadline when an alive child never replies', async () => {
  await fixture('process.stdin.resume()', async (session) => {
    await assert.rejects(session.discover(), /initialize timed out/);
  }, { timeoutMs: 100 });
});

test('MCP discovery bounds output even without a newline', async () => {
  await fixture('process.stdin.resume();process.stdin.once("data",()=>process.stdout.write("x".repeat(1024)))', async (session) => {
    await assert.rejects(session.discover(), /output limit/);
  }, { maxOutputBytes: 256 });
});
