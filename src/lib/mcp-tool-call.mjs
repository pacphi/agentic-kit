// Bounded MCP tool calls over an explicit stdio invocation: initialize, then
// each call strictly in order (a later call may depend on an earlier write),
// then the owned process group is killed. Unlike mcp-probe.mjs this DOES call
// tools, so it is only for isolated fixtures the caller created, never for a
// user's live corpus. Stderr is discarded; results carry parsed tool payloads.
//
// The result is returned only once the server has exited and its stdout pipe
// has closed, as mcp-probe.mjs does. Killing is not exiting: on Windows,
// taskkill runs as its own process, and until the server tree is gone it
// holds its working directory and any database it opened, so a caller that
// removes the fixture folder right away (ak status --refresh=live --only
// memory) fails with
// EPERM. Waiting for 'close' rather than 'exit' also waits for a child the
// server started that inherited the pipe (a cmd shim's node process).
import { spawn } from 'node:child_process';
import { resolveShim, killProcessTree } from './exec.mjs';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** How long the killed server may take to exit before the call reports
 *  cleanup-timeout instead of its session status. */
const EXIT_GRACE_MS = 5_000;

function validate({ command, args, calls, timeoutMs, exitGraceMs }) {
  const okCalls = Array.isArray(calls) && calls.every((call) => typeof call?.name === 'string' && call.name);
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string') || !okCalls
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || !Number.isInteger(exitGraceMs) || exitGraceMs < 1 || exitGraceMs > 60_000) {
    throw new TypeError('Invalid MCP tool-call invocation or deadline');
  }
}

function toResult(response) {
  if (response.error) return { ok: false, error: String(response.error.message ?? 'JSON-RPC error') };
  const text = response.result?.content?.[0]?.text;
  if (response.result?.isError) return { ok: false, error: String(text ?? 'tool error') };
  try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: text }; }
}

/** `cleanup-timeout`: the session ended but the killed server had not exited
 *  within `exitGraceMs`; the results it gave are kept.
 *  @returns {Promise<{status:'ok'|'timeout'|'exited'|'spawn-error'|'output-limit'|'cleanup-timeout', results:Array<null|{ok:boolean,data?:unknown,error?:string}>}>} */
export async function callMcpTools({
  command, args = [], cwd, env = {}, calls, timeoutMs = 60_000, exitGraceMs = EXIT_GRACE_MS,
}) {
  validate({ command, args, calls, timeoutMs, exitGraceMs });
  return new Promise((resolve) => {
    const merged = { ...process.env, ...env };
    const invocation = resolveShim(command, args, { env: merged });
    const child = spawn(invocation.command, invocation.args, {
      cwd, env: merged, shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const results = calls.map(() => null);
    let buffer = '';
    let bytes = 0;
    let next = 0;
    let settled = false;
    let initialized = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessTree(child);
      // A child that never started (spawn-error) or has already exited has
      // its exit code set; anything else is waited for, within a bounded grace.
      if (child.exitCode !== null || child.signalCode !== null) { resolve({ status, results }); return; }
      const grace = setTimeout(() => resolve({ status: 'cleanup-timeout', results }), exitGraceMs);
      child.once('close', () => { clearTimeout(grace); resolve({ status, results }); });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const sendNext = () => {
      if (next >= calls.length) { finish('ok'); return; }
      const { name, arguments: callArgs = {} } = calls[next];
      send({ id: next + 2, method: 'tools/call', params: { name, arguments: callArgs } });
    };
    const onResponse = (response) => {
      if (response.id === 1 && !initialized) {
        initialized = true; // a repeated initialize reply must not re-run the first call
        send({ method: 'notifications/initialized' });
        sendNext();
      } else if (response.id === next + 2) {
        results[next] = toResult(response);
        next += 1;
        sendNext();
      }
    };
    child.stdin.on('error', () => finish('exited'));
    child.on('error', () => finish('spawn-error'));
    child.on('close', () => finish('exited'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) { finish('output-limit'); return; }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1 && !settled) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response?.jsonrpc === '2.0') onResponse(response);
      }
    });
    send({ id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agentic-kit-tool-call', version: '1' },
    } });
  });
}
