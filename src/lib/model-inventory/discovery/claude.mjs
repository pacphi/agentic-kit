import {
  MAX_CONFIG_BYTES, MAX_MODELS, diagnostic, modelRecord, sourceRecord,
} from './index.mjs';
import { discoverAnthropicPublicCatalog } from './anthropic-catalog.mjs';

const ALIAS_ENV = Object.freeze({
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
});
const CLAUDE_MODEL_CONFIG_URL = 'https://code.claude.com/docs/en/model-config';
const EXTENDED_CONTEXT_SUFFIX = '[1m]';

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

function parseModelReference(reference) {
  const extended = reference.endsWith(EXTENDED_CONTEXT_SUFFIX);
  const modelId = extended ? reference.slice(0, -EXTENDED_CONTEXT_SUFFIX.length) : reference;
  return {
    modelId,
    variant: extended ? { contextWindow: 1_000_000 } : {},
  };
}

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
  const source = sourceRecord({
    id: 'claude-config', owner: 'claude', scope, scopeKey, capturedAt, complete,
    schema: 'claude-settings-v1', refs: [CLAUDE_MODEL_CONFIG_URL],
  });
  const publicAliasTargets = new Map(publicCatalog.models.flatMap((model) => (
    model.aliases.map(({ name, resolvesTo }) => [name, resolvesTo])
  )));
  const canonicalTarget = (reference) => {
    const { modelId } = parseModelReference(reference);
    return publicAliasTargets.get(modelId) ?? modelId;
  };
  const records = new Map();
  const add = (reference, states = {}) => {
    const selected = parseModelReference(reference);
    const alias = Object.hasOwn(ALIAS_ENV, selected.modelId) ? selected.modelId : null;
    const configuredReference = alias
      ? boundedModel(env[ALIAS_ENV[alias]]) ?? selected.modelId : selected.modelId;
    const configuredTarget = parseModelReference(configuredReference);
    const target = canonicalTarget(configuredTarget.modelId);
    if (!boundedModel(target)) return;
    const prior = records.get(target);
    const aliases = [...(prior?.aliases ?? [])];
    const selector = reference !== target ? reference : null;
    if (selector && !aliases.some((entry) => entry.name === selector)) {
      aliases.push({
        name: selector, resolvesTo: target, provenance: 'configured', observedAt: source.capturedAt,
      });
    }
    records.set(target, modelRecord({
      host: 'claude', provider: null, modelId: target, scopeId: source.scopeId,
      aliases, source,
      variant: { ...(prior?.variant ?? {}), ...configuredTarget.variant, ...selected.variant },
      states: { ...(prior?.states ?? {}), ...states, entitled: 'unknown' },
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
