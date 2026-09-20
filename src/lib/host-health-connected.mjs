// Explicit, bounded provider-inference checks. Never called by dashboard polling.
// Sources: native --help + https://code.claude.com/docs/en/cli-reference,
// https://developers.openai.com/codex/config-reference/,
// https://opencode.ai/docs/{cli,config,permissions}/.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveShim } from './exec.mjs';
import { parseLocalJsonc } from './host-readiness-local.mjs';

const HOSTS = new Set(['claude', 'codex', 'opencode']);
const MAX_BUFFER = 256 * 1024;
const CODEX_REQUIRED_FEATURES = ['plugins', 'hooks', 'apps', 'shell_tool'];
const CODEX_FEATURES = ['plugins', 'remote_plugin', 'hooks', 'apps', 'shell_tool',
  'multi_agent', 'skill_mcp_dependency_install', 'browser_use',
  'computer_use', 'code_mode', 'code_mode_host', 'image_generation', 'workspace_dependencies'];
const REQUIRED_FLAGS = {
  claude: ['--safe-mode', '--print', '--output-format', '--tools', '--strict-mcp-config', '--mcp-config', '--settings', '--no-session-persistence', '--disable-slash-commands', '--permission-mode'],
  codex: ['--json', '--sandbox', '--ephemeral', '--disable'],
  opencode: ['--pure', '--agent', '--format'],
};

// Keep subprocesses in an owned group and terminate the group on every exit
// path, including caller cancellation. No shell, detached background worker,
// raw diagnostics, or inference retry is permitted by this adapter.
async function runNative(command, args, { cwd, env, timeout, maxBuffer, input, signal }) {
  if (signal?.aborted) return { code: 1, stdout: '', stderr: 'aborted' };
  const invocation = resolveShim(command, args, { env });
  if (!invocation.resolved) return { code: 1, stdout: '', stderr: 'No safe Windows invocation' };
  return new Promise((resolve) => {
    let child;
    try { child = spawn(invocation.command, invocation.args, {
      cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    }); } catch { resolve({ code: 1, stdout: '', stderr: 'spawn unavailable' }); return; }
    let stdout = '', stderr = '', bytes = 0, finished = false, failure = '';
    const kill = () => {
      if (!child.pid) return;
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
        killer.on('error', () => child.kill('SIGKILL'));
      }
    };
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(cleanup);
      signal?.removeEventListener('abort', abort);
      kill();
      resolve({ code: failure ? 1 : code ?? 1, stdout, stderr: failure || stderr });
    };
    let cleanup;
    const stop = reason => {
      if (finished || failure) return;
      failure = reason; kill();
      cleanup = setTimeout(() => finish(1), 2000);
    };
    const abort = () => stop('aborted');
    const timer = setTimeout(() => stop('timed out'), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk, errorStream) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) { stop('maxBuffer exceeded'); return; }
      if (errorStream) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stdout.on('data', chunk => collect(chunk, false));
    child.stderr.on('data', chunk => collect(chunk, true));
    child.on('error', () => { failure = 'spawn unavailable'; finish(1); });
    child.on('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}

function receipt(state, reason, model) {
  return {
    state, reason, checkedAt: new Date().toISOString(), scope: 'provider-inference',
    model: model || null,
    integrations: { state: 'not-checked', reason: 'MCP integrations are excluded from this provider check; no connectivity claim is made.' },
  };
}
function parse(text) { try { return JSON.parse(text); } catch { return null; } }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function safeId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) && !value.startsWith('-'); }
function safeModel(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}(?:\[1m\])?$/.test(value); }
function flagsPresent(help, flags) { return flags.every(flag => new RegExp(`(^|[\\s,])${flag}(?=[\\s,=]|$)`, 'm').test(help)); }

async function codexIsolation(invoke) {
  const features = await invoke('codex', ['features', 'list']);
  if (features.code !== 0) return null;
  const present = new Set(features.stdout.split('\n').map(line => line.trim().split(/\s+/)[0]));
  if (!CODEX_REQUIRED_FEATURES.every(name => present.has(name))) return null;
  // Missing optional features are absent capabilities, not failed health.
  // unified_exec is intentionally omitted: recent hosts pin it on; the
  // shell_tool gate and read-only sandbox bound shell authority instead.
  const selectedFeatures = CODEX_FEATURES.filter(name => present.has(name));
  const args = selectedFeatures.flatMap(name => ['--disable', name]);
  const verifiedFeatures = await invoke('codex', ['features', 'list', ...args]);
  if (verifiedFeatures.code !== 0 || !selectedFeatures.every(name =>
    new RegExp(`^${name}\\s+.+\\s+false$`, 'm').test(verifiedFeatures.stdout))) return null;
  const listed = await invoke('codex', ['mcp', 'list', '--json', ...args]);
  const servers = parse(listed.stdout);
  if (listed.code !== 0 || !Array.isArray(servers) || servers.length > 200
    || servers.some(server => typeof server?.name !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(server.name))) return null;
  // Codex's dotted CLI override parser treats quoted components literally,
  // unlike a TOML file. Only validated bare keys are safe here.
  for (const server of servers) args.push('-c', `mcp_servers.${server.name}.enabled=false`);
  // Verify that the native effective roster actually honors the overrides.
  const verified = await invoke('codex', ['mcp', 'list', '--json', ...args]);
  const disabled = parse(verified.stdout);
  if (verified.code !== 0 || !Array.isArray(disabled)
    || disabled.some(server => server?.enabled !== false)) return null;
  return args;
}

function denyOnly(value) {
  return value === 'deny' || (object(value) && value['*'] === 'deny'
    && Object.values(value).every(rule => rule === 'deny'));
}

function isolatedOpenCode(config, agentName) {
  if (!object(config) || !object(config.mcp) || !denyOnly(config.permission)) return false;
  const agent = config.agent?.[agentName];
  return Object.values(config.mcp).every(server => object(server) && server.enabled === false)
    && object(agent) && denyOnly(agent.permission) && agent.steps === 1
    && agent.mode === 'primary' && config.share === 'disabled' && config.autoupdate === false;
}

async function opencodeIsolation(invoke, nonce, env) {
  // --pure prevents external plugin loading. Config inspection itself may
  // write ordinary host caches; the explicit connection action discloses this.
  const configResult = await invoke('opencode', ['debug', 'config', '--pure'], {
    env: { ...env, OPENCODE_DISABLE_AUTOUPDATE: 'true' },
  });
  const config = parse(configResult.stdout);
  if (configResult.code !== 0 || !object(config) || (config.mcp !== undefined && !object(config.mcp))) return null;
  const mcp = {};
  for (const key of Object.keys(config.mcp || {})) {
    if (!safeId(key)) return null;
    Object.defineProperty(mcp, key, { value: { enabled: false }, enumerable: true });
  }
  const inherited = env.OPENCODE_CONFIG_CONTENT ? parseLocalJsonc(env.OPENCODE_CONFIG_CONTENT) : {};
  if (!object(inherited)) return null;
  const agentName = `ak-health-${nonce}`;
  const override = { ...inherited, mcp: { ...(inherited.mcp || {}), ...mcp },
    share: 'disabled', autoupdate: false, permission: 'deny',
    agent: { ...(inherited.agent || {}), [agentName]: { description: 'Bounded provider health check', mode: 'primary', permission: 'deny', steps: 1 } } };
  const isolatedEnv = { ...env, OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_CONFIG_CONTENT: JSON.stringify(override) };
  // Managed/organization settings load after inline overrides. Verify the
  // effective result, rather than treating our requested restriction as proof.
  const verified = await invoke('opencode', ['debug', 'config', '--pure'], { env: isolatedEnv });
  const effective = parse(verified.stdout);
  if (verified.code !== 0 || !isolatedOpenCode(effective, agentName)) return null;
  return { agentName, env: isolatedEnv };

}

function nativeArguments(host, model, isolation) {
  const modelArgs = model ? ['--model', model] : [];
  if (host === 'claude') return ['--safe-mode', '--print', '--output-format', 'json',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-session-persistence', '--permission-mode', 'dontAsk',
    ...modelArgs, '--settings', '{"disableAllHooks":true}'];
  if (host === 'codex') return ['exec', '--json', '--ephemeral', '--sandbox', 'read-only',
    ...isolation, '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    ...modelArgs, '-'];
  return ['run', '--pure', '--format', 'json', '--agent', isolation.agentName, ...modelArgs];
}

function completed(host, stdout, challenge) {
  const document = parse(stdout.trim());
  const events = object(document) ? [document] : stdout.trim().split('\n').filter(Boolean).map(parse);
  if (!events.length || events.some(event => !object(event))) return 'unknown';
  if (events.some(event => event.type === 'error' || event.type === 'turn.failed'
    || (event.type === 'result' && event.is_error === true))) return 'fail';
  if (host === 'claude') return events.some(event => event.type === 'result'
    && event.subtype === 'success' && event.is_error === false
    && event.result?.trim() === challenge) ? 'pass' : 'unknown';
  if (host === 'codex') {
    if (events.some(event => ['mcp_tool_call', 'command_execution', 'file_change', 'web_search'].includes(event.item?.type))) return 'unknown';
    return events.some(event => event.type === 'turn.completed')
      && events.some(event => event.type === 'item.completed' && event.item?.type === 'agent_message'
        && event.item.text?.trim() === challenge) ? 'pass' : 'unknown';
  }
  if (events.some(event => event.type === 'tool_use')) return 'unknown';
  return events.some(event => event.type === 'step_finish' && event.part?.reason === 'stop')
    && events.some(event => event.type === 'text' && event.part?.text?.trim() === challenge) ? 'pass' : 'unknown';
}

/** A provider-only check with explicit consent. No raw stdout/stderr escapes.
 * The caller binds this receipt to its own current project/config fingerprint.
 * Native caches/session stores may change; normal managed policy still applies.
 * @param {{host:string,cwd:string,model?:string,confirm?:boolean,timeoutMs?:number,signal?:AbortSignal,
 * env?:NodeJS.ProcessEnv,run?:Function}} options
 */
export async function checkHostConnection({ host, cwd, model, confirm = false,
  timeoutMs = 60_000, env = process.env, signal, run = runNative }) {
  if (!HOSTS.has(host) || typeof cwd !== 'string' || !path.isAbsolute(cwd)
    || (model !== undefined && !safeModel(model)) || !Number.isInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid host connection check options');
  const result = (state, reason) => receipt(state, reason, model);
  if (confirm !== true) return result('unknown', 'Explicit confirmation is required before a connection check that may incur inference costs.');
  const deadline = Date.now() + timeoutMs;
  const invoke = async (command, args, overrides = {}) => {
    const remaining = deadline - Date.now();
    if (signal?.aborted) return { code: 1, stdout: '', stderr: 'aborted' };
    if (remaining <= 0) return { code: 1, stdout: '', stderr: 'timed out' };
    return run(command, args, { cwd, env, signal, timeout: remaining, maxBuffer: MAX_BUFFER, input: '', ...overrides });
  };
  try {
    const helpArgs = host === 'claude' ? ['--help'] : [host === 'codex' ? 'exec' : 'run', '--help'];
    const help = await invoke(host, helpArgs);
    if (help.code !== 0 || !flagsPresent(`${help.stdout}\n${help.stderr}`, REQUIRED_FLAGS[host])) {
      return result('unknown', 'This host does not expose the supported bounded connection-check capabilities.');
    }
    const nonce = randomBytes(12).toString('hex');
    /** @type {any} */
    let isolation = [];
    if (host === 'codex') isolation = await codexIsolation(invoke);
    if (host === 'opencode') isolation = await opencodeIsolation(invoke, nonce, env);
    if (isolation === null) return result('unknown', 'Unable to establish tool and integration isolation for the connection check.');
    const challenge = `AK_HEALTH_${nonce}`;
    const input = `Connection health check. Do not use tools or inspect files. Respond with exactly this single token and nothing else: ${challenge}`;
    const response = await invoke(host, nativeArguments(host, model, isolation), {
      input, ...(host === 'opencode' ? { env: isolation.env } : {}),
    });
    if (response.code !== 0) {
      if (/timed out|timeout|abort|maxBuffer|ENOENT|spawn unavailable|No safe Windows invocation/i.test(response.stderr || '')) {
        return result('unknown', /timed out|timeout/i.test(response.stderr) ? 'Connection check timed out.' : 'Connection check could not complete within its execution limits.');
      }
      return result('fail', 'The native host reported an unsuccessful connection check. Run its native diagnostics for details.');
    }
    const state = completed(host, response.stdout, challenge);
    return result(state, state === 'pass' ? 'The provider completed the bounded health challenge.'
      : state === 'fail' ? 'The native host reported an unsuccessful provider request.'
        : 'No supported, completed health response was observed; connection remains unverified.');
  } catch {
    return result('unknown', 'The connection check could not be completed.');
  }
}
