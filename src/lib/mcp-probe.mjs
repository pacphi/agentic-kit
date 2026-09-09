// Bounded MCP discovery against an explicit stdio invocation. No tool calls,
// repository content, environment values, or stderr are returned in receipts.
import { spawn } from 'node:child_process';
import { resolveShim } from './exec.mjs';

/** @param {{command:string,args?:string[],cwd?:string,env?:NodeJS.ProcessEnv,timeoutMs?:number}} options */
export function probeMcp({ command, args = [], cwd, env = {}, timeoutMs = 30_000 }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args)
    || args.some((arg) => typeof arg !== 'string')
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError('Invalid MCP probe invocation or deadline');
  }
  return new Promise((resolve) => {
    const started = performance.now();
    const mergedEnv = { ...process.env, ...env };
    const invocation = resolveShim(command, args, { env: mergedEnv });
    const child = spawn(invocation.command, invocation.args, {
      cwd, env: mergedEnv, shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let bytes = 0;
    let stderrBytes = 0;
    let initializedMs = null;
    let finished = false;
    const elapsed = () => Math.round(performance.now() - started);
    const finish = (status, extra = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Kill the probe's owned group, including model workers it started.
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      } else if (child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
        killer.on('error', () => child.kill('SIGKILL'));
      }
      const receipt = { status, initializedMs, elapsedMs: elapsed(), stderrBytes, ...extra };
      // Wait for pipe closure after terminating the owned child before reporting.
      // A bounded cleanup timeout is an explicit failure, never a ready receipt.
      if (child.exitCode !== null || child.signalCode !== null) resolve(receipt);
      else {
        const cleanup = setTimeout(() => resolve({ ...receipt, status: 'cleanup-timeout' }), 2000);
        child.once('close', () => { clearTimeout(cleanup); resolve(receipt); });
      }
    };
    const timer = setTimeout(() => finish('timeout', { phase: initializedMs == null ? 'initialize' : 'tools/list' }), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    child.stdin.on('error', () => finish('transport-error'));
    child.on('error', () => finish('spawn-error'));
    child.on('close', () => finish('exited'));
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) { finish('output-limit'); return; }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1 && !finished) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response?.jsonrpc !== '2.0') continue;
        if (response.id === 1 && initializedMs == null) {
          if (response.error || !response.result?.protocolVersion) { finish('protocol-error'); return; }
          initializedMs = elapsed();
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (response.id === 2 && initializedMs != null) {
          const tools = response.result?.tools;
          if (response.error || !Array.isArray(tools) || tools.some((tool) => typeof tool?.name !== 'string')) {
            finish('protocol-error'); return;
          }
          finish('ready', { toolCount: tools.length });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agentic-kit-probe', version: '1' },
    } });
  });
}
