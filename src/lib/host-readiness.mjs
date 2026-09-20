// Scoped local health plus explicit, short-lived provider connection evidence.
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { loadKitConfig } from './config.mjs';
import { inspectHostAlignment } from './host-alignment.mjs';
import { collectHostSetup } from './host-readiness-probes.mjs';
import { createHostHealthSnapshot } from './host-health-evidence.mjs';

const HOSTS = ['claude', 'codex', 'opencode'];
const LABELS = { ok: 'OK', attention: 'Attention', unknown: 'Unknown', disabled: 'Disabled', checking: 'Checking' };
const unknown = () => ({ state: 'unknown', reason: 'Check unavailable' });
const BLOCKERS = {
  'retired-codex-mcp': 'Retired Codex transport configured; review with ak host align',
  'misplaced-claude-companion': 'Claude companion enabled in Codex; review with ak host align',
};
const idleConnection = () => ({ state: 'not-run', reason: 'Connection test has not been run.' });
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refused = (message, status = 409) => Object.assign(new Error(message), { status });
const nativeConnection = async options => (await import('./host-health-connected.mjs')).checkHostConnection(options);

/** @param {any} input */
export function summarizeHostReadiness({ host, enabled, setup = {}, findings = [], connection = idleConnection() }) {
  const checks = Object.fromEntries(['installation', 'configuration', 'model', 'authentication'].map(key => [key, setup[key] ?? unknown()]));
  const alignment = findings.filter(finding => finding.host === host);
  const blocked = alignment.find(finding => BLOCKERS[finding.code]);
  checks.integration = blocked
    ? { state: 'fail', reason: BLOCKERS[blocked.code] }
    : alignment.some(finding => finding.code === 'config-unassessed')
      ? { state: 'unknown', reason: 'Transport configuration could not be assessed' }
      : { state: 'pass', reason: 'No known blocking transport configuration conflict; optional tool connectivity is separate.' };
  const values = Object.values(checks);
  const localStatus = values.some(check => check.state === 'fail') ? 'attention'
    : values.every(check => check.state === 'pass') ? 'ok' : 'unknown';
  const connected = ['pass', 'fail', 'unknown', 'running'].includes(connection.state);
  const status = !enabled ? 'disabled' : connection.state === 'running' ? 'checking'
    : localStatus === 'attention' || connection.state === 'fail' ? 'attention'
      : connected && connection.state === 'unknown' ? 'unknown' : localStatus;
  return { host, status, label: LABELS[status], level: connected ? 'connected' : 'local',
    localStatus, checks: enabled ? checks : {}, target: setup.target ?? null,
    connection, canCheckConnection: enabled && localStatus !== 'attention' && checks.installation.state === 'pass' };
}

/** One dashboard, one project, one in-flight paid check. Native output is not
 * persisted. Local cache invalidates on observed input changes; connected proof
 * expires after 15 minutes and never survives changed inputs or a server restart.
 * @param {any} [options] */
export function createHostReadinessReader({ cwd = process.cwd(), cacheMs = 60_000, now = Date.now,
  connectionMaxAgeMs = 15 * 60_000, loadConfig = loadKitConfig,
  inspectAlignment = inspectHostAlignment, probe = collectHostSetup,
  snapshot = createHostHealthSnapshot(), connectionProbe = nativeConnection,
} = {}) {
  let cached = null, pending = null, pendingKey = null, active = null, closed = false;
  const proofs = new Map(), tokens = new Map();
  const controller = new AbortController();
  function inputs() {
    const cfg = loadConfig();
    const observed = snapshot({ cwd, cfg });
    return { cfg, ...observed, key: fingerprint([observed.key, cfg]) };
  }
  function decorate(base) {
    const hosts = {};
    for (const host of HOSTS) {
      const entry = base.entries[host];
      const proof = proofs.get(host);
      const same = proof?.key === entry.key;
      const fresh = same && now() - proof.at < connectionMaxAgeMs;
      const connection = active?.host === host ? { state: 'running', reason: 'Connection check is running.' }
        : fresh ? proof.result : proof ? { state: same ? 'expired' : 'changed', reason: same
          ? 'Previous connection check expired; local checks remain available.' : 'Configuration changed; run a new connection check.', checkedAt: proof.result.checkedAt } : idleConnection();
      hosts[host] = { ...summarizeHostReadiness({ ...entry, connection }), evidenceKey: tokens.get(host)?.key === entry.key ? tokens.get(host).token : undefined,
        checkedAt: base.checkedAt, canCheckConnection: false };
      hosts[host].canCheckConnection = !closed && !active && base.complete
        && entry.enabled && hosts[host].localStatus !== 'attention'
        && hosts[host].checks.installation?.state === 'pass';
      hosts[host].connectionUnavailable = hosts[host].canCheckConnection ? null
        : active ? 'Another connection check is running.' : !entry.enabled ? 'This host is disabled.'
          : !base.complete ? 'Some local configuration inputs could not be bounded for a connection check.'
            : 'Review the local setup checks before testing a connection.';
    }
    return { checkedAt: base.checkedAt, scope: 'Dashboard launch directory', project: path.basename(cwd), hosts };
  }
  async function collect(input) {
    let findings;
    try { findings = inspectAlignment({ projectRoots: [cwd] }).findings; }
    catch { findings = HOSTS.map(host => ({ host, code: 'config-unassessed' })); }
    const entries = {};
    await Promise.all(HOSTS.map(async host => {
      const enabled = input.cfg.integrations?.hosts?.[host] === true;
      let setup = {};
      if (enabled) { try { setup = await probe({ host, cwd }); } catch { /* sanitized unknown */ } }
      const key = fingerprint([input.key, host, setup, findings.filter(f => f.host === host).map(f => f.code)]);
      entries[host] = { host, enabled, setup, findings, key };
    }));
    // Never attach a successful check to configuration changed mid-probe.
    const after = inputs();
    if (after.key !== input.key) throw refused('Configuration changed during local checks');
    const at = now();
    const value = { entries, complete: input.complete, checkedAt: new Date(at).toISOString() };
    if (pendingKey === input.key) {
      for (const host of HOSTS) {
        const key = entries[host].key;
        if (tokens.get(host)?.key !== key) tokens.set(host, { key, token: randomBytes(32).toString('hex') });
      }
      cached = { at, key: input.key, value };
    }
    return value;
  }
  async function read({ force = false } = {}) {
    if (closed) return null;
    let input;
    try { input = inputs(); } catch { return null; }
    if (!force && cached?.key === input.key && now() - cached.at < cacheMs) return decorate(cached.value);
    if (pending && pendingKey === input.key) return decorate(await pending);
    pendingKey = input.key;
    const task = collect(input);
    pending = task;
    try { return decorate(await task); } finally { if (pending === task) { pending = null; pendingKey = null; } }
  }
  read.checkConnection = async ({ host, confirm, evidenceKey, signal } = /** @type {any} */ ({})) => {
    if (!HOSTS.includes(host)) throw refused('Unknown host', 400);
    if (confirm !== true) throw refused('Explicit connection-check confirmation required', 400);
    if (closed || active) throw refused('A connection check is already running or the dashboard is closed');
    const current = await read({ force: true });
    // Re-check after awaiting local probes; two requests may have raced.
    if (active) throw refused('A connection check is already running');
    const entry = current?.hosts?.[host];
    if (!entry?.canCheckConnection) throw refused('Host prerequisites are unavailable');
    if (!evidenceKey || entry.evidenceKey !== evidenceKey) throw refused('Health evidence is stale; refresh before checking');
    const key = tokens.get(host).key;
    tokens.set(host, { key, token: randomBytes(32).toString('hex') }); // consume confirmation
    active = { host };
    try {
      let result;
      const checkSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try { result = await connectionProbe({ host, cwd, ...(entry.target?.model ? { model: host === 'opencode' && entry.target.provider ? entry.target.provider + '/' + entry.target.model : entry.target.model } : {}), confirm: true, signal: checkSignal }); }
      catch { result = { state: 'unknown', reason: 'Connection check could not complete.' }; }
      const refreshed = await read({ force: true });
      if (!refreshed || tokens.get(host)?.key !== key) throw refused('Configuration changed during the connection check');
      if (checkSignal.aborted) result = { state: 'unknown', reason: 'Connection check was cancelled.' };
      const state = ['pass', 'fail', 'unknown'].includes(result?.state) ? result.state : 'unknown';
      const checkedAt = new Date(now()).toISOString();
      proofs.set(host, { key, at: now(), result: { state, checkedAt,
        reason: typeof result?.reason === 'string' ? result.reason : 'The connection check could not establish a result.',
        model: result?.model ?? entry.target?.model ?? null, scope: 'provider-inference',
        integrations: { state: 'not-checked', reason: 'This check tests provider inference. Optional MCP tool connections are not exercised.' },
      } });
    } finally { active = null; }
    return read();
  };
  read.close = () => { closed = true; controller.abort(); };
  return read;
}
