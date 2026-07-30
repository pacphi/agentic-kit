// Supervised OpenCode execution candidate (ADR-0018). This is intentionally
// separate from opencode.mjs, which owns managed configuration lifecycle. It
// never writes user configuration or passes the CLI's dangerous --auto flag.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { have, resolveShim } from '../exec.mjs';
import { validateExecutionAdapter, validateWorkerResult } from './schema.mjs';

const TEMPLATE_PATH = fileURLToPath(new URL('../../templates/opencode-worker-prompt.md', import.meta.url));
const LOOPBACK = '127.0.0.1';
const USERNAME = 'opencode';
/** S3: cap on the SSE per-line accumulator (mirrors the subprocess 256 KB cap). */
const MAX_SSE_BUFFER = 256 * 1024;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const defaultSecret = () => randomBytes(24).toString('base64url');

function defaultReservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const { port } = /** @type {{port:number}} */ (server.address());
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForChildClose(child, timeoutMs) {
  if (!child?.once || child.exitCode != null || child.signalCode != null) return true;
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve) => child.once('close', () => resolve(true))),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Terminate only the direct server child. A TERM that does not produce a close
 * event becomes explicit orphan evidence after one bounded KILL fallback. */
async function stopChild(child, { terminationGraceMs, forceGraceMs }) {
  if (!child?.kill || child.exitCode != null || child.signalCode != null) return { stopped: true };
  if (!child.once) {
    try { child.kill('SIGTERM'); } catch { return { stopped: false }; }
    return { stopped: true };
  }
  try { child.kill('SIGTERM'); } catch { return { stopped: false }; }
  if (await waitForChildClose(child, terminationGraceMs)) return { stopped: true };
  try { child.kill('SIGKILL'); } catch { return { stopped: false }; }
  return { stopped: await waitForChildClose(child, forceGraceMs) };
}

function templateText(readFileSync = fs.readFileSync) {
  return readFileSync(TEMPLATE_PATH, 'utf8');
}

/** Render the template used only in this request; it is not copied into a
 * user's OpenCode config, agents, commands, or project files. */
export function renderOpenCodeWorkerPrompt(worker, { template = templateText() } = {}) {
  if (!worker || typeof worker !== 'object') throw new TypeError('worker is required');
  if (typeof worker.prompt !== 'string' || !worker.prompt.trim()) throw new TypeError('worker.prompt is required');
  const metadata = [
    `worker: ${worker.id ?? 'unknown'}`,
    `activity: ${worker.activity ?? 'unknown'}`,
    `role: ${worker.role ?? 'unknown'}`,
    `configured model: ${worker.configuredModel ?? 'default'}`,
  ].join('\n');
  // Replacer functions, not string replacement: a prompt/model containing
  // `$&`, `` $` ``, or `$'` would otherwise be interpreted as replacement
  // metachars and silently corrupt the rendered prompt (#88).
  return template.replace('{{task}}', () => worker.prompt).replace('{{metadata}}', () => metadata);
}

function basicHeaders(password) {
  return {
    authorization: `Basic ${Buffer.from(`${USERNAME}:${password}`).toString('base64')}`,
    accept: 'application/json, text/event-stream',
  };
}

async function responseJson(response, operation) {
  if (!response?.ok) throw new Error(`${operation} failed with HTTP ${response?.status ?? 'unknown'}`);
  try { return await response.json(); } catch { throw new Error(`${operation} returned invalid JSON`); }
}

async function requestJson(fetchFn, endpoint, password, pathname,
  { method = 'GET', body } = /** @type {{method?:string, body?:any}} */ ({})) {
  const headers = basicHeaders(password);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetchFn(`${endpoint}${pathname}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return responseJson(response, `${method} ${pathname}`);
}

/** Bounded POST for teardown calls (/abort, /instance/dispose): a wedged
 *  server must not hang the runner's cancel/cleanup path (#88). 10 s is far
 *  above any loopback round-trip; the caller's own try/catch records the
 *  final truth either way. */
async function requestNoContent(fetchFn, endpoint, password, pathname,
  { method = 'POST', body, signal, timeoutMs = 10_000 } = /** @type {{method?:string, body?:any, signal?:AbortSignal, timeoutMs?:number}} */ ({})) {
  const headers = basicHeaders(password);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${endpoint}${pathname}`, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    if (!response?.ok) throw new Error(`${method} ${pathname} failed with HTTP ${response?.status ?? 'unknown'}`);
  } finally { clearTimeout(timer); }
}

/** opencode serve's prompt_async schema takes `model` as an OBJECT
 *  `{providerID, modelID}` or null — a bare string is a 400 ("Expected object
 *  | null, got …"). The runner's configured model travels as one
 *  `provider/model` string (routing.mjs), so split on the FIRST slash here
 *  (provider ids never contain '/'; model ids may, e.g. openrouter). A model
 *  with no provider prefix falls back to the server's own configured default
 *  (model omitted) rather than guessing a provider. */
function serveModelFor(configuredModel) {
  if (typeof configuredModel !== 'string' || !configuredModel.includes('/')) return null;
  const slash = configuredModel.indexOf('/');
  return { providerID: configuredModel.slice(0, slash), modelID: configuredModel.slice(slash + 1) };
}

async function requestWithin(fetchFn, endpoint, password, pathname, options, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      requestNoContent(fetchFn, endpoint, password, pathname, { ...options, signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        const error = Object.assign(new Error(`${options.method ?? 'POST'} ${pathname} timed out`), { code: 'ETIMEDOUT' });
        reject(error);
      }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Parse the OS-assigned port from the child's stdout ("listening on
 *  http://127.0.0.1:<port>"). Bounded wait; stdout is consumed (never left
 *  buffering) and a child that dies before reporting fails honestly. */
async function boundPortFromStdout(child, { attempts = 100 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let n = 0;
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { cleanup(); resolve(Number(m[1])); }
    };
    const onExit = () => { cleanup(); reject(new Error(`OpenCode server exited before reporting its port (code ${child.exitCode ?? 'unknown'})`)); };
    const onError = (error) => {
      cleanup();
      reject(new Error(`OpenCode server failed before reporting its port: ${error?.message ?? error}`));
    };
    const tick = () => {
      if (++n >= attempts) { cleanup(); reject(new Error('OpenCode server did not report its port in time')); }
      else timer = setTimeout(tick, 50);
    };
    let timer = setTimeout(tick, 50);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off?.('data', onData);
      child.stderr?.off?.('data', onData);
      child.off?.('exit', onExit);
      child.off?.('error', onError);
    };
    child.stdout.on('data', onData);
    child.stderr?.on?.('data', onData);
    child.once?.('exit', onExit);
    child.once?.('error', onError);
  });
}

/** @param {any} fetchFn @param {string} endpoint @param {string} password @param {{ attempts?: number, wait?: (ms: any) => Promise<any>, child?: any }} [opts] */
async function waitForHealth(fetchFn, endpoint, password, { attempts = 40, wait = delay, child } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // A dead child (EADDRINUSE, crash, missing binary) fails fast with the
    // exit code instead of polling into the timeout (S2 defense-in-depth).
    if (child && child.exitCode != null) {
      throw new Error(`OpenCode server exited during health check (code ${child.exitCode})`);
    }
    try {
      const health = await requestJson(fetchFn, endpoint, password, '/global/health');
      if (health?.healthy === true) return health;
      lastError = new Error('health response was not healthy');
    } catch (error) { lastError = error; }
    await wait(50);
  }
  throw new Error(`OpenCode server did not become healthy: ${lastError?.message ?? 'unknown error'}`);
}

function normalizeEvent(value) {
  return value?.payload ?? value;
}

/** Read only the first terminal session event. The SSE parsing is deliberately
 * tolerant of chunk boundaries but rejects malformed data rather than inventing
 * completion. */
async function waitForTerminalEvent(response, sessionId, { signal } = /** @type {{signal?:AbortSignal}} */ ({})) {
  if (!response?.ok || !response.body?.getReader) throw new Error('GET /global/event did not return an SSE body');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener?.('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  const consume = async (line) => {
    if (line.startsWith('data:')) { data.push(line.slice(5).trimStart()); return null; }
    if (line !== '' || data.length === 0) return null;
    const raw = data.join('\n');
    data = [];
    let event;
    try { event = normalizeEvent(JSON.parse(raw)); } catch { throw new Error('OpenCode SSE event was malformed'); }
    const properties = event?.properties ?? {};
    if (event?.type === 'permission.updated' && properties.sessionID === sessionId) return { type: 'permission', permission: properties };
    if (event?.type === 'session.error' && (!properties.sessionID || properties.sessionID === sessionId)) return { type: 'error', error: properties.error ?? null };
    if (event?.type === 'session.idle' && properties.sessionID === sessionId) return { type: 'idle' };
    if (event?.type === 'session.status' && properties.sessionID === sessionId && properties.status?.type === 'idle') return { type: 'idle' };
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      // S3: the per-line accumulator is capped like the 256 KB subprocess cap —
      // a line that never terminates cannot grow memory without bound.
      if (buffer.length > MAX_SSE_BUFFER) {
        await reader.cancel();
        throw new Error(`OpenCode SSE line exceeded the ${MAX_SSE_BUFFER}-byte cap — protocol error, not a hang`);
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const terminal = await consume(line);
        if (terminal) { await reader.cancel(); return terminal; }
      }
      if (done) break;
    }
    throw new Error(signal?.aborted ? 'OpenCode SSE stream cancelled' : 'OpenCode SSE stream ended before the session became terminal');
  } finally {
    signal?.removeEventListener?.('abort', abort);
  }
}

function assistantFrom(messages) {
  const candidates = Array.isArray(messages) ? messages : [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const info = candidates[i]?.info;
    if (info?.role === 'assistant') return info;
  }
  return null;
}

function errorCategory(error) {
  if (error?.name === 'ProviderAuthError') return 'auth_required';
  if (error?.name === 'ProtocolError') return 'protocol_error';
  return 'worker_error';
}

function terminalResult(state, observation, clock) {
  const endedAt = clock();
  const startedAt = state.startedAt;
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const assistant = observation.assistant ?? null;
  let status = 'succeeded';
  let exitCategory = 'success';
  let failure = null;
  if (observation.type === 'permission') {
    status = 'blocked'; exitCategory = 'permission_required'; failure = { permission: observation.permission?.id ?? null };
  } else if (observation.type === 'timeout') {
    status = 'timed_out'; exitCategory = 'timeout'; failure = { reason: 'timeout' };
  } else if (observation.type === 'cancelled') {
    status = 'cancelled'; exitCategory = 'cancelled'; failure = { reason: 'cancelled' };
  } else if (observation.type === 'orphaned') {
    status = 'failed'; exitCategory = 'orphaned'; failure = { reason: 'owned OpenCode server did not terminate' };
  } else if (observation.type === 'error' || assistant?.error) {
    const error = observation.error ?? assistant?.error ?? null;
    status = 'failed'; exitCategory = errorCategory(error); failure = error ?? { reason: 'OpenCode session failed' };
  } else if (observation.type !== 'idle') {
    status = 'failed'; exitCategory = 'protocol_error'; failure = { reason: 'unknown terminal event' };
  }
  return validateWorkerResult({
    workerId: state.worker.id, activity: state.worker.activity, role: state.worker.role, host: 'opencode',
    status, exitCategory, startedAt, endedAt, durationMs,
    provider: assistant?.providerID ?? null,
    providerProvenance: assistant?.providerID ? 'observed' : 'unknown',
    configuredModel: state.worker.configuredModel ?? null,
    observedModel: assistant?.modelID ?? null,
    sessionId: state.sessionId ?? null,
    transcriptRefs: state.sessionId ? [`opencode://session/${state.sessionId}`] : [],
    failure, usage: assistant?.tokens ? { tokens: assistant.tokens, cost: assistant.cost ?? null } : null,
  });
}

/**
 * Create a fully injectable OpenCode worker adapter. Invoked by `ak run`
 * (the canonical executor) for opencode-routed workers; routing capability
 * itself is gated by the host registry (canRouteActivities, #82).
 */
export function createOpenCodeExecutionAdapter({
  fetchFn = globalThis.fetch, spawnFn = nodeSpawn, haveFn = have, reservePort = defaultReservePort,
  resolveFn = resolveShim, secret = defaultSecret, wait = delay, clock = nowIso,
  terminationGraceMs = 1_500, forceGraceMs = 1_500, teardownTimeoutMs = 10_000,
} = {}) {
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn is required');
  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 1) throw new TypeError('terminationGraceMs must be a positive integer');
  if (!Number.isInteger(forceGraceMs) || forceGraceMs < 1) throw new TypeError('forceGraceMs must be a positive integer');
  if (!Number.isInteger(teardownTimeoutMs) || teardownTimeoutMs < 1) throw new TypeError('teardownTimeoutMs must be a positive integer');
  const adapter = {
    id: 'opencode-server',
    async readiness() {
      const installed = await haveFn('opencode');
      return installed ? { ready: true } : { ready: false, exitCategory: 'cli_unavailable' };
    },
    async prepare({ worker, cwd = process.cwd() } = /** @type {{worker?:any,cwd?:string}} */ ({})) {
      if (worker?.host !== 'opencode') throw new TypeError('OpenCode adapter requires an opencode worker');
      if (!path.isAbsolute(cwd)) throw new TypeError('OpenCode worker cwd must be absolute');
      return { worker, cwd, prompt: renderOpenCodeWorkerPrompt(worker), startedAt: clock() };
    },
    async launch(state, { timeoutMs = 120_000 } = {}) {
      const password = secret();
      // Port assignment WITHOUT the probe-bind-release race (S2): the child
      // binds :0 itself and reports the OS-assigned port on stdout, so a
      // squatter can never win a freed port against us (a rogue server would
      // not know the ephemeral password anyway — but prompts/credentials must
      // never reach a server we did not spawn). reservePort remains the
      // fallback for injected children with no readable stdout (tests).
      const invocation = resolveFn('opencode', ['serve', '--hostname', LOOPBACK, '--port', '0']);
      if (typeof invocation?.command !== 'string' || !Array.isArray(invocation.args)) {
        throw new TypeError('OpenCode command resolver returned an invalid invocation');
      }
      if (invocation.resolved === false) {
        throw new Error('OpenCode command has no safe Windows invocation');
      }
      const child = spawnFn(invocation.command, invocation.args, {
        cwd: state.cwd,
        env: { ...process.env, OPENCODE_SERVER_USERNAME: USERNAME, OPENCODE_SERVER_PASSWORD: password },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let port;
      try {
        port = child?.stdout && typeof child.stdout.on === 'function'
          ? await boundPortFromStdout(child)
          : await reservePort();
      } catch (error) {
        await stopChild(child, { terminationGraceMs, forceGraceMs });
        throw error;
      }
      const endpoint = `http://${LOOPBACK}:${port}`;
      try {
        await waitForHealth(fetchFn, endpoint, password, { wait, child });
        const session = await requestJson(fetchFn, endpoint, password, '/session', {
          method: 'POST', body: { title: `agentic-kit ${state.worker.id}` },
        });
        if (typeof session?.id !== 'string' || !session.id) throw new Error('OpenCode created a session without an id');
        const headers = basicHeaders(password);
        const eventAbort = new AbortController();
        const eventResponse = await fetchFn(`${endpoint}/global/event`, { headers, signal: eventAbort.signal });
        const terminal = waitForTerminalEvent(eventResponse, session.id, { signal: eventAbort.signal });
        // Every path that abandons this promise without observe() consuming it
        // (a prompt post that throws, cancel/cleanup teardown) would otherwise
        // leave its socket-close rejection unhandled — Node's default turns
        // that into a process crash AFTER the run verdict. A no-op second
        // consumer keeps teardown honest; observe() still sees the rejection.
        terminal.catch(() => {});
        const model = serveModelFor(state.worker.configuredModel);
        await requestWithin(fetchFn, endpoint, password, `/session/${encodeURIComponent(session.id)}/prompt_async`, {
          body: { agent: 'build', ...(model ? { model } : {}), parts: [{ type: 'text', text: state.prompt }] },
        }, timeoutMs);
        return { ...state, endpoint, password, child, sessionId: session.id, terminal, eventAbort };
      } catch (error) {
        await stopChild(child, { terminationGraceMs, forceGraceMs });
        throw error;
      }
    },
    async observe(state) {
      try {
        const observation = await state.terminal;
        if (observation.type === 'permission') {
          await requestNoContent(fetchFn, state.endpoint, state.password, `/session/${encodeURIComponent(state.sessionId)}/abort`, { timeoutMs: teardownTimeoutMs });
        }
        if (observation.type !== 'idle') return observation;
        const messages = await requestJson(fetchFn, state.endpoint, state.password, `/session/${encodeURIComponent(state.sessionId)}/message`);
        return { ...observation, assistant: assistantFrom(messages) };
      } catch (error) {
        return { type: 'error', error: { name: 'ProtocolError', data: { message: error.message } } };
      }
    },
    interpret(state, observation) { return terminalResult(state, observation, clock); },
    async cancel(state) {
      state?.eventAbort?.abort();
      if (state?.sessionId) {
        try { await requestNoContent(fetchFn, state.endpoint, state.password, `/session/${encodeURIComponent(state.sessionId)}/abort`, { timeoutMs: teardownTimeoutMs }); } catch { /* cleanup records the final truth */ }
      }
      const stopped = await stopChild(state?.child, { terminationGraceMs, forceGraceMs });
      return stopped.stopped ? { type: 'cancelled' } : { type: 'cancelled', orphaned: true };
    },
    async cleanup(state) {
      state?.eventAbort?.abort();
      if (state?.endpoint) {
        try { await requestNoContent(fetchFn, state.endpoint, state.password, '/instance/dispose', { timeoutMs: teardownTimeoutMs }); } catch { /* child termination remains the fallback */ }
      }
      const stopped = await stopChild(state?.child, { terminationGraceMs, forceGraceMs });
      return stopped.stopped ? { cleaned: true } : { cleaned: false, orphaned: true };
    },
  };
  return validateExecutionAdapter(adapter);
}

export const OPENCODE_EXECUTION_ADAPTER = createOpenCodeExecutionAdapter();
