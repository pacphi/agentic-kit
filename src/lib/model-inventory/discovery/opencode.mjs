import { run } from '../../exec.mjs';
import {
  MAX_COMMAND_BYTES, MAX_MODELS, diagnostic, modelRecord, sourceRecord,
} from './index.mjs';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+@-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:+@/-]*)?$/;
const VARIANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function selection(value) {
  let ref = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    ref = typeof value.providerID === 'string' && typeof value.model === 'string'
      ? `${value.providerID}/${value.model}` : null;
  }
  if (typeof ref !== 'string' || ref.length > 576) return null;
  const hash = ref.lastIndexOf('#');
  const id = hash > 0 ? ref.slice(0, hash) : ref;
  const variant = hash > 0 ? ref.slice(hash + 1) : null;
  return MODEL_ID.test(id) && (!variant || VARIANT.test(variant)) ? { id, variant } : null;
}

function configuredRefs(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) throw new TypeError('config-too-large');
  let config;
  try { config = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw); } catch { throw new TypeError('config-invalid-json'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config-schema');
  const refs = [config.model];
  for (const agent of Object.values(config.agent && typeof config.agent === 'object' ? config.agent : {})) {
    if (agent && typeof agent === 'object') refs.push(agent.model);
  }
  return refs.map(selection).filter(Boolean)
    .filter((entry, index, all) => all.findIndex(({ id, variant }) => id === entry.id && variant === entry.variant) === index);
}

export function discoverOpenCode({ raw, configRaw, capturedAt, scope = {}, scopeKey, online = false } = /** @type {any} */ ({})) {
  const text = String(raw ?? '');
  const source = sourceRecord({ id: 'opencode-models', owner: 'opencode', scope, scopeKey, capturedAt, complete: true, schema: 'opencode-models-lines-v1' });
  if (Buffer.byteLength(text) > MAX_COMMAND_BYTES) {
    source.complete = false;
    source.status = 'unsupported';
    source.diagnostics = ['output-too-large'];
    return { status: 'unsupported', source, models: [], diagnostics: [diagnostic('output-too-large', `output exceeds ${MAX_COMMAND_BYTES}`)], networkUsed: online };
  }
  const diagnostics = [];
  let configured = [];
  try { configured = configuredRefs(configRaw); } catch (error) {
    source.complete = false;
    source.status = 'partial';
    diagnostics.push(diagnostic('unsupported-config-schema', error.message));
  }
  const ids = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const id = line.trim();
    if (!id) continue;
    if (!MODEL_ID.test(id) || id.length > 512) {
      diagnostics.push(diagnostic('invalid-model-id', `line ${index + 1} is invalid`));
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_MODELS) break;
  }
  const complete = diagnostics.length === 0 && ids.length < MAX_MODELS;
  source.complete = complete;
  source.status = complete ? 'complete' : 'partial';
  source.diagnostics = diagnostics.map(({ code }) => code);
  const configuredIds = configured.map(({ id }) => id);
  const allIds = [...new Set([...ids, ...configuredIds])];
  const models = allIds.map((qualified) => {
    const slash = qualified.indexOf('/');
    const provider = slash > 0 ? qualified.slice(0, slash) : null;
    const modelId = slash > 0 ? qualified.slice(slash + 1) : qualified;
    return modelRecord({
      host: 'opencode', provider, modelId, scopeId: source.scopeId, displayName: qualified, source,
      states: {
        configured: configuredIds.includes(qualified), effective: configRaw !== undefined && configured[0]?.id === qualified,
        discoverable: ids.includes(qualified) ? true : 'unknown', entitled: 'unknown',
      }, variant: { configuredVariants: configured.filter(({ id }) => id === qualified)
        .map(({ variant }) => variant).filter(Boolean) },
    });
  });
  return { status: complete ? 'complete' : 'partial', source, models, diagnostics, networkUsed: online };
}

export async function collectOpenCode({
  runner = run, online = false, provider, configRaw, capturedAt, scope = {}, scopeKey, timeout = 30_000,
} = /** @type {any} */ ({})) {
  const providerArg = typeof provider === 'string' && provider.length <= 256 ? provider : null;
  const args = ['models', ...(providerArg ? [providerArg] : []), ...(online ? ['--refresh'] : [])];
  const result = await runner('opencode', args, { timeout, maxBuffer: MAX_COMMAND_BYTES, shell: false });
  if (result.code !== 0) {
    const source = sourceRecord({ id: 'opencode-models', owner: 'opencode', scope, scopeKey, capturedAt, complete: false, status: 'unavailable', schema: 'opencode-models-lines-v1', diagnostics: ['command-failed'] });
    return { status: 'unavailable', source, models: [], diagnostics: [diagnostic('command-failed', result.stderr || 'opencode models failed')], networkUsed: online };
  }
  return discoverOpenCode({ raw: result.stdout, configRaw, capturedAt, scope, scopeKey, online });
}
