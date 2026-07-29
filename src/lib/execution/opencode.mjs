// Supervised OpenCode execution candidate (ADR-0018). This is intentionally
// separate from opencode.mjs, which owns managed configuration lifecycle. It
// never writes user configuration or passes the CLI's dangerous --auto flag.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { have } from '../exec.mjs';
import { validateExecutionAdapter, validateWorkerResult } from './schema.mjs';

const TEMPLATE_PATH = fileURLToPath(new URL('../../templates/opencode-worker-prompt.md', import.meta.url));
const LOOPBACK = '127.0.0.1';
const USERNAME = 'opencode';

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
  return template.replace('{{task}}', worker.prompt).replace('{{metadata}}', metadata);
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

async function requestNoContent(fetchFn, endpoint, password, pathname,
  { method = 'POST', body, signal } = /** @type {{method?:string, body?:any, signal?:AbortSignal}} */ ({})) {
  const headers = basicHeaders(password);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetchFn(`${endpoint}${pathname}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
  });
  if (!response?.ok) throw new Error(`${method} ${pathname} failed with HTTP ${response?.status ?? 'unknown'}`);
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

async function waitForHealth(fetchFn, endpoint, password, { attempts = 40, wait = delay } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
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
 * Create a fully injectable OpenCode worker adapter. No command invokes this
 * adapter yet; its presence does not change OpenCode's routing capability.
 */
export function createOpenCodeExecutionAdapter({
  fetchFn = globalThis.fetch, spawnFn = nodeSpawn, haveFn = have, reservePort = defaultReservePort,
  secret = defaultSecret, wait = delay, clock = nowIso, terminationGraceMs = 1_500, forceGraceMs = 1_500,
} = {}) {
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn is required');
  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 1) throw new TypeError('terminationGraceMs must be a positive integer');
  if (!Number.isInteger(forceGraceMs) || forceGraceMs < 1) throw new TypeError('forceGraceMs must be a positive integer');
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
      const port = await reservePort();
      const password = secret();
      const endpoint = `http://${LOOPBACK}:${port}`;
      const child = spawnFn('opencode', ['serve', '--hostname', LOOPBACK, '--port', String(port)], {
        cwd: state.cwd,
        env: { ...process.env, OPENCODE_SERVER_USERNAME: USERNAME, OPENCODE_SERVER_PASSWORD: password },
        stdio: 'ignore',
      });
      try {
        await waitForHealth(fetchFn, endpoint, password, { wait });
        const session = await requestJson(fetchFn, endpoint, password, '/session', {
          method: 'POST', body: { title: `agentic-kit ${state.worker.id}` },
        });
        if (typeof session?.id !== 'string' || !session.id) throw new Error('OpenCode created a session without an id');
        const headers = basicHeaders(password);
        const eventAbort = new AbortController();
        const eventResponse = await fetchFn(`${endpoint}/global/event`, { headers, signal: eventAbort.signal });
        const terminal = waitForTerminalEvent(eventResponse, session.id, { signal: eventAbort.signal });
        await requestWithin(fetchFn, endpoint, password, `/session/${encodeURIComponent(session.id)}/prompt_async`, {
          body: { agent: 'build', ...(state.worker.configuredModel ? { model: state.worker.configuredModel } : {}), parts: [{ type: 'text', text: state.prompt }] },
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
          await requestNoContent(fetchFn, state.endpoint, state.password, `/session/${encodeURIComponent(state.sessionId)}/abort`);
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
        try { await requestNoContent(fetchFn, state.endpoint, state.password, `/session/${encodeURIComponent(state.sessionId)}/abort`); } catch { /* cleanup records the final truth */ }
      }
      const stopped = await stopChild(state?.child, { terminationGraceMs, forceGraceMs });
      return stopped.stopped ? { type: 'cancelled' } : { type: 'cancelled', orphaned: true };
    },
    async cleanup(state) {
      state?.eventAbort?.abort();
      if (state?.endpoint) {
        try { await requestNoContent(fetchFn, state.endpoint, state.password, '/instance/dispose'); } catch { /* child termination remains the fallback */ }
      }
      const stopped = await stopChild(state?.child, { terminationGraceMs, forceGraceMs });
      return stopped.stopped ? { cleaned: true } : { cleaned: false, orphaned: true };
    },
  };
  return validateExecutionAdapter(adapter);
}

export const OPENCODE_EXECUTION_ADAPTER = createOpenCodeExecutionAdapter();
