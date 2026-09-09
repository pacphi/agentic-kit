// Static observations of the selected Claude user plugin, independent of the
// marketplace checkout and KB release. Never loads plugin code or repairs it.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir } from './paths.mjs';

const ID = 'ruvnet-brain@ruvnet-brain';
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const within = (root, file) => file.startsWith(`${root}${path.sep}`);

function payloadFile(root, relative) {
  const file = path.join(root, relative);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !within(root, fs.realpathSync(file))) {
    throw new Error(`${relative} is not a regular file inside the selected payload`);
  }
  return file;
}

/** User-scope enablement only; project and managed-policy overrides are unknown. */
export function inspectClaudeBrainPlugin({ claudeRoot = claudeDir() } = {}) {
  const result = {
    registration: 'absent', scope: 'user', enabled: null,
    registryVersion: null, payloadVersion: null, hookEvents: [], issues: [],
    evidence: 'static-registry-and-files', runtimeVerified: false,
  };
  if (!path.isAbsolute(claudeRoot)) {
    result.registration = 'invalid'; result.issues.push('Claude config root is not absolute'); return result;
  }
  try {
    const enabled = readJson(path.join(claudeRoot, 'settings.json'))?.enabledPlugins?.[ID];
    if (typeof enabled === 'boolean') result.enabled = enabled;
  } catch { /* No claim about enablement when settings are unavailable. */ }
  let records;
  try {
    const registry = readJson(path.join(claudeRoot, 'plugins', 'installed_plugins.json'));
    if (!object(registry) || !object(registry.plugins)) throw new Error('invalid registry');
    records = registry.plugins[ID];
    if (records == null) return result;
    if (!Array.isArray(records)) throw new Error('invalid plugin records');
  } catch (error) {
    if (error.code === 'ENOENT' && result.enabled !== true) return result;
    result.registration = 'invalid'; result.issues.push('Claude plugin registry is missing or invalid'); return result;
  }
  const users = records.filter((r) => object(r) && r.scope === 'user');
  if (users.length !== 1) {
    result.registration = 'invalid'; result.issues.push('Expected one unambiguous user plugin registration'); return result;
  }
  const record = users[0];
  result.registration = 'present';
  result.registryVersion = typeof record.version === 'string' ? record.version : null;
  let root;
  try {
    if (typeof record.installPath !== 'string' || !path.isAbsolute(record.installPath)) throw new Error('invalid path');
    const cache = fs.realpathSync(path.join(claudeRoot, 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain'));
    root = fs.realpathSync(record.installPath);
    if (!within(cache, root)) throw new Error('outside cache');
  } catch {
    result.registration = 'invalid'; result.issues.push('Selected payload is missing or outside the managed Brain cache'); return result;
  }
  try {
    const manifest = readJson(payloadFile(root, '.claude-plugin/plugin.json'));
    if (manifest?.name !== 'ruvnet-brain' || typeof manifest.version !== 'string') throw new Error('invalid manifest');
    result.payloadVersion = manifest.version;
    if (manifest.hooks !== undefined && manifest.hooks !== './hooks/hooks.json') {
      result.issues.push('Explicit plugin hook declaration is outside the verified retirement contract');
    }
    if (result.registryVersion !== manifest.version) result.issues.push('Registry and selected payload versions differ');
  } catch { result.issues.push('Selected plugin manifest is missing or invalid'); }
  try { payloadFile(root, 'commands/rvbc.md'); }
  catch { result.issues.push('Selected payload lacks the current regular commands/rvbc.md entry'); }
  // Inspect independently: a missing command must not hide retired hook events.
  try {
    const hooks = readJson(payloadFile(root, 'hooks/hooks.json'))?.hooks;
    if (!object(hooks)) throw new Error('invalid hooks');
    result.hookEvents = Object.keys(hooks);
    if (result.hookEvents.length) result.issues.push(`Selected payload declares automatic hooks outside the audited 4.3.16 retirement baseline: ${result.hookEvents.join(', ')}`);
  } catch { result.issues.push('Automatic hook retirement is unverified: missing or invalid hook manifest'); }
  return result;
}
