import {
  MAX_CONFIG_BYTES, MAX_MODELS, diagnostic, modelRecord, sourceRecord,
} from './index.mjs';
import { discoverAnthropicPublicCatalog } from './anthropic-catalog.mjs';

const ALIAS_ENV = Object.freeze({
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
});

function parseSettings(raw, field) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return structuredClone(raw);
  const text = String(raw);
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new TypeError(`${field}-too-large`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new TypeError(`${field}-invalid-json`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError(`${field}-schema`);
  return parsed;
}

const boundedModel = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
  ? value : null;

export function discoverClaude({
  settingsRaw, managedSettingsRaw, capturedAt, scope = {}, scopeKey, environment = {},
} = /** @type {any} */ ({})) {
  const publicCatalog = discoverAnthropicPublicCatalog({ capturedAt, scope, scopeKey });
  let settings;
  let managed;
  try {
    settings = parseSettings(settingsRaw, 'settings');
    managed = parseSettings(managedSettingsRaw, 'managed-settings');
  } catch (error) {
    const source = sourceRecord({ id: 'claude-config', owner: 'claude', scope, scopeKey, capturedAt, complete: false, status: 'unsupported-schema', schema: 'claude-settings-v1', diagnostics: ['unsupported-schema'] });
    return {
      status: 'partial', source, sources: [publicCatalog.source], models: publicCatalog.models,
      diagnostics: [diagnostic('unsupported-schema', error.message)],
    };
  }

  const env = { ...(settings.env && typeof settings.env === 'object' ? settings.env : {}), ...environment };
  const configured = boundedModel(managed.model) ?? boundedModel(environment.ANTHROPIC_MODEL)
    ?? boundedModel(settings.model);
  const allowed = Array.isArray(managed.availableModels)
    ? managed.availableModels.filter(boundedModel).slice(0, MAX_MODELS) : [];
  const complete = !Array.isArray(managed.availableModels) || managed.availableModels.length <= MAX_MODELS;
  const source = sourceRecord({ id: 'claude-config', owner: 'claude', scope, scopeKey, capturedAt, complete, schema: 'claude-settings-v1' });
  const publicAliasTargets = new Map(publicCatalog.models.flatMap((model) => (
    model.aliases.map(({ name, resolvesTo }) => [name, resolvesTo])
  )));
  const canonicalTarget = (reference) => publicAliasTargets.get(reference) ?? reference;
  const records = new Map();
  const add = (reference, states = {}) => {
    const alias = Object.hasOwn(ALIAS_ENV, reference) ? reference : null;
    const configuredTarget = alias ? boundedModel(env[ALIAS_ENV[alias]]) ?? reference : reference;
    const target = canonicalTarget(configuredTarget);
    if (!boundedModel(target)) return;
    const prior = records.get(target);
    const aliases = prior?.aliases ?? [];
    if (alias && !aliases.some((entry) => entry.name === alias)) {
      aliases.push({ name: alias, resolvesTo: target, provenance: 'configured', observedAt: source.capturedAt });
    }
    records.set(target, modelRecord({
      host: 'claude', provider: null, modelId: target, scopeId: source.scopeId,
      aliases, source, states: { ...(prior?.states ?? {}), ...states, entitled: 'unknown' },
    }));
  };
  for (const model of allowed) add(model, { policyAllowed: true, discoverable: true });
  if (configured) add(configured, { configured: true, effective: true,
    policyAllowed: allowed.length
      ? allowed.some((reference) => canonicalTarget(reference) === canonicalTarget(configured))
      : 'unknown' });

  return {
    status: complete && publicCatalog.source.status === 'complete' ? 'complete' : 'partial',
    source, sources: [publicCatalog.source],
    models: [...records.values(), ...publicCatalog.models],
    diagnostics: complete ? [] : [diagnostic('model-cap', `availableModels exceeds ${MAX_MODELS}`)],
  };
}
