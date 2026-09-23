// Own only one environment value, never an AQE registration or a user's config.
import fs from 'node:fs';
import path from 'node:path';
import { contextHome } from './codex-context-config.mjs';
import { aqeTomlEnvironment } from './aqe-embedding-toml.mjs';
import { recognizedAqeTransport, parseEmbeddingJson } from './aqe-embedding-transport.mjs';
import { claudeUserMcpPath, projectAqeDir, repoRoot } from './paths.mjs';
import { planOwnedEnv, applyOwnedEnv, readRegularConfig as readRegular } from './owned-env-projection.mjs';

export const AQE_ENDPOINT_KEY = 'AQE_EMBEDDER_ENDPOINT';
const receiptPath = file => `${file}.agentic-kit-aqe-embedding.json`;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const state = env => Object.hasOwn(env, AQE_ENDPOINT_KEY)
  ? { present: true, value: env[AQE_ENDPOINT_KEY] } : { present: false };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Pure; unmanaged intentionally leaves inherited host configuration alone. */
export function aqeEmbeddingProjectionEnv(cfg) {
  const intent = cfg?.aqeEmbedding;
  if (cfg?.aqe === false || !intent || intent.mode === 'unmanaged') return {};
  if (intent.mode === 'in-process') return { [AQE_ENDPOINT_KEY]: '' };
  if (intent.mode !== 'endpoint' || typeof intent.endpoint !== 'string' || !intent.endpoint.trim()
    || /[\r\n\0]/.test(intent.endpoint)) throw new TypeError('invalid AQE embedding projection intent');
  return { [AQE_ENDPOINT_KEY]: intent.endpoint };
}

function jsonEnvironment(source, target) {
  const doc = source === null ? {} : parseEmbeddingJson(source);
  if (!plain(doc)) throw new Error('configuration is not an object');
  let container = doc;
  if (target.kind === 'mcp') {
    const registration = doc.mcpServers?.['agentic-qe'];
    if (!registration) return { missing: true };
    if (!plain(registration) || !recognizedAqeTransport(registration.command, registration.args)) {
      throw new Error('unrecognized AQE MCP transport preserved');
    }
    container = registration;
  }
  if (container.env !== undefined && !plain(container.env)) throw new Error('environment is not an object');
  const env = container.env ?? {};
  return { current: state(env), replace(next) {
    container.env ??= {};
    if (next.present) container.env[AQE_ENDPOINT_KEY] = next.value;
    else {
      delete container.env[AQE_ENDPOINT_KEY];
      if (Object.keys(container.env).length === 0) delete container.env;
    }
    return JSON.stringify(doc, null, 2) + '\n';
  } };
}

// Project scope is the enclosing git repository (paths.repoRoot), the same gate
// every other project-scoped writer uses. Outside a repository (e.g. running from
// ~/.claude or $HOME) there is no project to project into: project targets are
// kept only for receipt-based cleanup of values an earlier version wrote there.
// The AQE MCP registration is required only in a project AQE initialized.
function targets(cfg, cwd, codexHome) {
  const hosts = cfg.integrations?.hosts ?? { claude: true };
  const root = repoRoot(cwd);
  const base = root ?? cwd;
  const project = root !== null;
  const aqeProject = project && fs.existsSync(projectAqeDir(root));
  const result = [];
  // Include disabled targets only for receipt-based cleanup. Never fabricate a registration.
  const add = (file, kind, enabled, required = false, boundary = base) => {
    if (enabled || fs.existsSync(receiptPath(file))) result.push({ file, kind, enabled, required, boundary });
  };
  add(path.join(base, '.mcp.json'), 'mcp', project && !!hosts.claude, aqeProject);
  add(path.join(base, '.claude', 'settings.local.json'), 'settings', project && !!hosts.claude);
  add(path.join(base, '.codex', 'config.toml'), 'toml', project && !!hosts.codex);
  const userCodex = path.join(codexHome, 'config.toml');
  if (path.resolve(userCodex) !== path.resolve(base, '.codex', 'config.toml')) add(userCodex, 'toml', !!hosts.codex, false, codexHome);
  return result;
}

function aqeEditor(target) {
  return (source) => {
    const editor = target.kind === 'toml' ? aqeTomlEnvironment(source) : jsonEnvironment(source, target);
    if (editor.missing) return { missing: true };
    return {
      get: (key) => (key === AQE_ENDPOINT_KEY ? editor.current : { present: false }),
      render: (next) => editor.replace(next[AQE_ENDPOINT_KEY] ?? { present: false }),
    };
  };
}
const AQE_OPTS = (target) => ({ receiptSuffix: '.agentic-kit-aqe-embedding.json',
  format: { single: AQE_ENDPOINT_KEY }, editorFor: aqeEditor(target) });

/** Spawn-free; inspection and reconciliation share the exact same planning logic.
 * @param {any} cfg @param {string} cwd @param {any} options */
export function inspectAqeEmbeddingProjections(cfg, cwd = process.cwd(), options = {}) {
  return reconcileAqeEmbeddingProjections(cfg, cwd, { ...options, dryRun: true });
}

/** Before a deliberately authorized AQE initializer rewrites its tables, relinquish
 * only unchanged receipt-owned values. A failed result must abort initialization.
 * @param {any} cfg @param {string} cwd @param {any} options */
export function prepareAqeEmbeddingInitialization(cfg, cwd = process.cwd(), options = {}) {
  return reconcileAqeEmbeddingProjections({ ...cfg, aqeEmbedding: { mode: 'unmanaged' } }, cwd, options);
}

const projectEntry = (doc, root) => (root === null ? undefined
  : Object.entries(doc.projects ?? {}).find(([key]) => path.resolve(key) === root)?.[1]);

function claudePrecedenceFindings(cfg, root, userFile, desired) {
  const hosts = cfg.integrations?.hosts ?? { claude: true };
  if (!hosts.claude || !desired.present) return [];
  try {
    const source = readRegular(userFile);
    if (source === null) return [];
    const doc = parseEmbeddingJson(source);
    if (!plain(doc) || (doc.projects !== undefined && !plain(doc.projects))) throw new Error('invalid Claude MCP configuration preserved');
    const project = projectEntry(doc, root);
    const local = project?.mcpServers?.['agentic-qe'];
    const user = doc.mcpServers?.['agentic-qe'];
    const findings = [];
    for (const [scope, entry] of [['local', local], ['user', user]]) {
      if (entry === undefined) continue;
      if (!plain(entry) || !recognizedAqeTransport(entry.command, entry.args)
        || (entry.env !== undefined && !plain(entry.env))) {
        findings.push({ file: userFile, scope, status: 'conflict', changed: false, reason: 'unrecognized Claude AQE override preserved' });
        continue;
      }
      const actual = state(entry.env ?? {});
      const conflict = actual.present ? !same(actual, desired) : scope === 'local';
      findings.push({ file: userFile, scope, status: conflict ? 'conflict' : 'observed', changed: false,
        reason: conflict ? 'Claude AQE override endpoint differs or is unverified; preserved' : 'Claude AQE override observed without conflicting endpoint' });
    }
    return findings;
  } catch { return [{ file: userFile, scope: 'user', status: 'conflict', changed: false, reason: 'Claude MCP precedence cannot be safely inspected' }]; }
}

/** @param {any} cfg @param {string} cwd @param {any} options */
export function reconcileAqeEmbeddingProjections(cfg, cwd = process.cwd(), {
  dryRun = false, codexHome = contextHome(), claudeUserFile = claudeUserMcpPath(),
} = {}) {
  if (cfg.aqe === false) return { ok: true, changed: false, detail: 'AQE disabled; projections skipped', findings: [] };
  const desired = state(aqeEmbeddingProjectionEnv(cfg));
  const root = repoRoot(cwd);
  const findings = claudePrecedenceFindings(cfg, root === null ? null : path.resolve(root), claudeUserFile, desired);
  for (const target of targets(cfg, path.resolve(cwd), codexHome)) {
    try {
      const plan = planOwnedEnv(target, { [AQE_ENDPOINT_KEY]: desired }, AQE_OPTS(target));
      if (plan.changed && !dryRun) applyOwnedEnv(plan, { backupTag: 'aqe' });
      findings.push({ file: plan.file, status: plan.status, changed: plan.changed });
    } catch (error) { findings.push({ file: target.file, status: 'conflict', changed: false, reason: error.message }); }
  }
  const ok = findings.every(f => !['conflict', 'missing-registration'].includes(f.status));
  const changed = findings.some(f => f.changed);
  return { ok, changed, detail: ok ? (changed ? 'AQE embedding environment projections updated' : 'AQE embedding projections converged or unmanaged')
    : 'AQE embedding projection conflicts or missing registrations require reconciliation', findings };
}
