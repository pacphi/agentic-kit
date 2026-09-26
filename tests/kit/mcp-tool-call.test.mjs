import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callMcpTools } from '../../src/lib/mcp-tool-call.mjs';

// A real stdio JSON-RPC server. Tools: `echo` returns its arguments plus a global
// call counter, `plain` non-JSON text, `boom` a JSON-RPC error, `bad` an isError result, `hang` never
// answers (and records its pid), `quit` exits without answering. MODE injects
// protocol misbehaviour: dupinit, stray, garbage, chunk, flood.
const SERVER = `
const fs = require('node:fs');
const path = require('node:path');
const rl = require('node:readline').createInterface({ input: process.stdin });
const mode = process.env.MODE;
let calls = 0;
const write = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const answer = (m) => {
  if (mode === 'stray') write({ id: 99, result: { content: [{ type: 'text', text: '{"stray":true}' }] } });
  if (mode === 'garbage') process.stdout.write('this is not json\\n');
  if (mode === 'chunk') {
    const line = JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n';
    process.stdout.write(line.slice(0, 15));
    setTimeout(() => process.stdout.write(line.slice(15)), 30);
    return;
  }
  write(m);
};
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    const reply = { id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } };
    write(reply);
    if (mode === 'dupinit') write(reply);
    return;
  }
  if (msg.method !== 'tools/call') return;
  calls += 1;
  const { name, arguments: args } = msg.params;
  if (name === 'hang') { fs.writeFileSync(path.join(__dirname, 'hang.pid'), String(process.pid)); return; }
  if (name === 'quit') process.exit(0);
  if (name === 'boom') return answer({ id: msg.id, error: { code: -32000, message: 'nope' } });
  if (name === 'plain') return answer({ id: msg.id, result: { content: [{ type: 'text', text: 'hello world' }] } });
  if (name === 'bad') return answer({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'bad tool' }] } });
  if (mode === 'flood') { process.stdout.write('x'.repeat(3 * 1024 * 1024)); return; }
  answer({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ seen: args, order: calls }) }] } });
});
`;

function fixture(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-mcp-call-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'server.cjs');
  fs.writeFileSync(file, SERVER);
  return { command: process.execPath, args: [file], cwd: dir, env: mode ? { MODE: mode } : {}, dir };
}

const echo = (key) => ({ name: 'echo', arguments: { key } });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('calls run sequentially and each result is the parsed tool payload', async (t) => {
  const out = await callMcpTools({ ...fixture(t), calls: [echo('a'), echo('b')] });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.results.map((r) => [r.ok, r.data.seen.key, r.data.order]), [[true, 'a', 1], [true, 'b', 2]]);
});

test('a JSON-RPC error fails only that call and later calls still run', async (t) => {
  const out = await callMcpTools({ ...fixture(t), calls: [{ name: 'boom', arguments: {} }, echo('after')] });
  assert.equal(out.status, 'ok');
  assert.equal(out.results[0].ok, false);
  assert.match(out.results[0].error, /nope/);
  assert.equal(out.results[1].data.seen.key, 'after');
});

test('a tool that answers in plain text is returned as text, not a crash', async (t) => {
  const out = await callMcpTools({ ...fixture(t), calls: [{ name: 'plain', arguments: {} }, echo('next')] });
  assert.equal(out.status, 'ok');
  assert.deepEqual([out.results[0].ok, out.results[0].data], [true, 'hello world']);
  assert.equal(out.results[1].ok, true, 'the session survives a non-JSON answer');
});

test('an isError tool result is a failed call carrying the tool text', async (t) => {
  const out = await callMcpTools({ ...fixture(t), calls: [{ name: 'bad', arguments: {} }, echo('next')] });
  assert.deepEqual([out.results[0].ok, out.results[0].error], [false, 'bad tool']);
  assert.equal(out.results[1].ok, true);
});

test('an unanswered call times out, keeps earlier results, and the server process is really killed', async (t) => {
  const f = fixture(t);
  const started = Date.now();
  const out = await callMcpTools({ ...f, timeoutMs: 3000, calls: [echo('first'), { name: 'hang', arguments: {} }, echo('never')] });
  assert.equal(out.status, 'timeout');
  assert.equal(out.results[0].data.seen.key, 'first');
  assert.equal(out.results[1], null);
  assert.equal(out.results[2], null);
  assert.ok(Date.now() - started < 15_000, 'bounded by the deadline, not by the server');
  const pid = Number(fs.readFileSync(path.join(f.dir, 'hang.pid'), 'utf8'));
  for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false, 'a timed-out MCP server must not be left running');
});

test('a server that exits mid-session reports exited with the answers it gave', async (t) => {
  const out = await callMcpTools({ ...fixture(t), calls: [echo('one'), { name: 'quit', arguments: {} }, echo('never')] });
  assert.equal(out.status, 'exited');
  assert.equal(out.results[0].data.seen.key, 'one');
  assert.equal(out.results[1], null);
  assert.equal(out.results[2], null);
});

test('a server that cannot start reports spawn-error instead of throwing', async (t) => {
  const out = await callMcpTools({ ...fixture(t), command: path.join(os.tmpdir(), 'no-such-mcp-binary'), args: [],
    calls: [echo('x')] });
  if (process.platform === 'win32') assert.ok(['spawn-error', 'exited'].includes(out.status), out.status);
  else assert.equal(out.status, 'spawn-error');
  assert.equal(out.results[0], null);
});

test('a duplicated initialize reply does not run any call twice', async (t) => {
  const out = await callMcpTools({ ...fixture(t, 'dupinit'), calls: [echo('a'), echo('b')] });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.results.map((r) => r.data.order), [1, 2], 'a write must be executed exactly once');
});

test('a response with an unrelated id is ignored rather than taken as the answer', async (t) => {
  const out = await callMcpTools({ ...fixture(t, 'stray'), calls: [echo('a'), echo('b')] });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.results.map((r) => r.data.seen.key), ['a', 'b']);
});

test('non-JSON noise on stdout is skipped', async (t) => {
  const out = await callMcpTools({ ...fixture(t, 'garbage'), calls: [echo('a')] });
  assert.equal(out.status, 'ok');
  assert.equal(out.results[0].data.seen.key, 'a');
});

test('a JSON line split across chunks is reassembled', async (t) => {
  const out = await callMcpTools({ ...fixture(t, 'chunk'), calls: [echo('a'), echo('b')] });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.results.map((r) => r.data.seen.key), ['a', 'b']);
});

test('runaway output is cut off at the limit', async (t) => {
  const out = await callMcpTools({ ...fixture(t, 'flood'), calls: [echo('a')] });
  assert.equal(out.status, 'output-limit');
  assert.equal(out.results[0], null);
});

test('malformed invocations are rejected before anything is spawned', async () => {
  await assert.rejects(callMcpTools({ command: '', calls: [] }), TypeError);
  await assert.rejects(callMcpTools({ command: 'x', calls: [{ arguments: {} }] }), TypeError);
  await assert.rejects(callMcpTools({ command: 'x', calls: [], timeoutMs: 999_999 }), TypeError);
  await assert.rejects(callMcpTools({ command: 'x', args: [1], calls: [] }), TypeError);
});
