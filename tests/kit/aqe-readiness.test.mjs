import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aqeEmbeddingConfiguration, classifyAqeStartup, probeAqeBrowser } from '../../src/lib/aqe-readiness.mjs';
import { probeMcp } from '../../src/lib/mcp-probe.mjs';
import { verifyMcp } from '../../src/commands/x/verify.mjs';

test('missing transformer package is distinct from endpoint configuration and live readiness', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqe-config-test-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    assert.equal(aqeEmbeddingConfiguration({ packageRoot: root, env: {} }).status, 'missing-backend');
    assert.equal(aqeEmbeddingConfiguration({ packageRoot: root, env: { AQE_EMBEDDER_ENDPOINT: 'http://127.0.0.1:8089' } }).status, 'configured-unverified');
    assert.equal(aqeEmbeddingConfiguration({ packageRoot: root, env: { AQE_EMBEDDER_ENDPOINT: 'https://user:secret@example.com' } }).status, 'invalid-endpoint');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('successful exit never conceals embedding or RVF initialization failure', () => {
  assert.equal(classifyAqeStartup({ code: 1 }).status, 'failed');
  assert.equal(classifyAqeStartup({ code: 0, stderr: 'ReasoningBank prewarm failed' }).status, 'degraded');
  assert.equal(classifyAqeStartup({ code: 0, stdout: 'FsyncFailed' }).status, 'failed');
  assert.equal(classifyAqeStartup({ code: 0, stderr: 'locked by a live process; FsyncFailed' }).status, 'degraded');
  assert.equal(classifyAqeStartup({ code: 0 }).status, 'observed');
});

test('browser CLI present with missing payload is not ready and does not invoke installation', async () => {
  const calls = [];
  const result = await probeAqeBrowser({ runner: async (cmd, args) => {
    calls.push([cmd, ...args]); return { code: args[0] === '--version' ? 0 : 1 };
  } });
  assert.equal(result.status, 'missing-payload');
  assert.deepEqual(calls, [['vibium', '--version'], ['vibium', 'is-installed']]);
});

test('MCP probe completes actual initialize and discovery without tool execution', async () => {
  const script = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2024-11-05'}:{tools:[{name:'test'}]}})+'\\n')}});`;
  const result = await probeMcp({ command: process.execPath, args: ['-e', script], timeoutMs: 3000 });
  assert.equal(result.status, 'ready');
  assert.equal(result.toolCount, 1);
});

test('MCP probe has one bounded deadline for silent transports', async () => {
  const result = await probeMcp({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 });
  assert.equal(result.status, 'timeout');
  assert.equal(result.phase, 'initialize');
});

test('MCP verification uses effective project command and environment instead of a global assumption', async () => {
  const calls = [];
  const result = await verifyMcp({ cwd: '/project', runner: async () => ({ code: 0, stdout: JSON.stringify([
    { name: 'agentic-qe', enabled: true, transport: { type: 'stdio', command: 'npx', args: ['-y', 'agentic-qe@latest', 'mcp'], env: { AQE_V3_MODE: 'true' } } },
    { name: 'ruvnet-brain', enabled: true, transport: { type: 'stdio', command: 'node', args: ['/brain/server.mjs'] } },
  ]) }), probe: async (call) => { calls.push(call); return { status: 'ready', elapsedMs: 1, toolCount: 1 }; } });
  assert.equal(result, true);
  assert.equal(calls[0].command, 'npx');
  assert.equal(calls[0].env.AQE_V3_MODE, 'true');
  assert.equal(calls[0].cwd, '/project');
});
