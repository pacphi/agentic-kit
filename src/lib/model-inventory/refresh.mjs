import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as paths from '../paths.mjs';
import { run } from '../exec.mjs';
import { discoverModels } from './discovery/index.mjs';
import { collectModelBindings } from './bindings.mjs';
import { collectObservedModels } from './observed.mjs';
import { readOrCreateModelScopeKey } from './store.mjs';
import { MODEL_INVENTORY_SCHEMA_VERSION, modelIdentityKey, normalizeSnapshot } from './contracts.mjs';
import { modelRecord, scopeFingerprint } from './discovery/index.mjs';
import { MODEL_DISCOVERY_REGISTRY } from '../adapters/registries.mjs';

const CONTACT = Object.freeze({
  'claude-config': 'Claude local settings', 'codex-cache': 'Codex local model cache',
  'opencode-models': 'opencode catalog', 'ollama-catalog': 'local Ollama daemon',
});
const MODEL_ENV = Object.freeze([
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]);

function readOptional(file, readFileFn) {
  if (!file) return undefined;
  try { return readFileFn(file, 'utf8'); } catch { return undefined; }
}

const DISCOVERY_OPTIONS = Object.freeze({
  'claude-config': ({ base, inputs, readFileFn, processEnvironment }) => ({
    ...base,
    settingsRaw: inputs.claude?.settingsRaw ?? readOptional(paths.claudeSettingsPath(), readFileFn),
    managedSettingsRaw: inputs.claude?.managedSettingsRaw
      ?? readOptional(paths.claudeManagedSettingsPath(), readFileFn),
    environment: inputs.claude?.environment ?? Object.fromEntries(MODEL_ENV
      .filter((name) => typeof processEnvironment?.[name] === 'string')
      .map((name) => [name, processEnvironment[name]])),
  }),
  'codex-cache': ({ base, inputs, readFileFn }) => ({
    ...base,
    cacheRaw: inputs.codex?.cacheRaw ?? readOptional(path.join(paths.codexDir(), 'models_cache.json'), readFileFn),
    configRaw: inputs.codex?.configRaw ?? readOptional(path.join(paths.codexDir(), 'config.toml'), readFileFn),
  }),
  'opencode-models': ({ base, inputs, runner, online }) => ({
    ...base, runner, online, provider: inputs.opencode?.provider,
    configRaw: inputs.opencode?.configRaw, catalogRaw: inputs.opencode?.catalogRaw,
    fetchFn: inputs.opencode?.fetchFn,
  }),
  'ollama-catalog': ({ base, runner }) => ({ ...base, runner }),
});

function descriptorResult(result, descriptor, online) {
  return {
    ...result,
    source: {
      ...result.source,
      owner: descriptor.ownerId,
      ownerType: descriptor.ownerType,
      transport: descriptor.transport,
      network: descriptor.network,
      mode: online && descriptor.network === 'explicit' ? 'online' : 'local',
    },
  };
}

export async function refreshModelDiscovery({
  owners = MODEL_DISCOVERY_REGISTRY.map(({ ownerId }) => ownerId), descriptors = MODEL_DISCOVERY_REGISTRY,
  online = false, runner = run, readFileFn = fs.readFileSync, processEnvironment = process.env,
  cwd = process.cwd(), inputs = {}, capturedAt, scope = {}, scopeKey,
} = /** @type {any} */ ({})) {
  const fingerprintKey = scopeKey ?? readOrCreateModelScopeKey();
  const results = {};
  const contacts = [];
  const selected = owners.map((owner) => descriptors.find((descriptor) => descriptor.ownerId === owner));
  if (selected.some((descriptor) => !descriptor)) {
    const index = selected.findIndex((descriptor) => !descriptor);
    throw new TypeError(`unsupported model discovery owner: ${String(owners[index])}`);
  }
  for (const descriptor of selected) {
    const owner = descriptor.ownerId;
    const buildOptions = DISCOVERY_OPTIONS[descriptor.id];
    if (!buildOptions) throw new TypeError(`unsupported model discovery descriptor: ${descriptor.id}`);
    contacts.push(descriptor.id === 'opencode-models' && online
      ? 'OpenCode and Models.dev catalogues'
      : (CONTACT[descriptor.id] ?? descriptor.id));
    const ownerScope = { ...scope, ...(descriptor.scope === 'project' ? { project: cwd } : {}) };
    const base = { capturedAt, scope: ownerScope, scopeKey: fingerprintKey };
    const options = buildOptions({ base, inputs, readFileFn, processEnvironment, runner, online, cwd });
    results[owner] = descriptorResult(await discoverModels(owner, options), descriptor, online);
  }
  return { generatedAt: capturedAt ?? new Date().toISOString(), online, contacts, results };
}

export async function collectModelInventory({
  config = {}, aqeConfig, rufloConfig, discoveryOptions = {}, readIndexFn, indexOptions, scope = {}, scopeKey,
} = /** @type {any} */ ({})) {
  const fingerprintKey = scopeKey ?? readOrCreateModelScopeKey();
  const [discovery, observed] = await Promise.all([
    refreshModelDiscovery({ ...discoveryOptions, scope: discoveryOptions.scope ?? scope, scopeKey: fingerprintKey }),
    collectObservedModels({ readIndexFn, indexOptions, scope, scopeKey: fingerprintKey }),
  ]);
  return {
    generatedAt: new Date().toISOString(), discovery,
    bindings: collectModelBindings({ config, aqeConfig, rufloConfig }), observed,
  };
}

function mergeModels(records) {
  const merged = new Map();
  for (const record of records) {
    const identity = modelIdentityKey(record.key);
    const prior = merged.get(identity);
    if (!prior) { merged.set(identity, structuredClone(record)); continue; }
    const evidence = [...prior.evidence, ...record.evidence]
      .filter((entry, index, all) => all.findIndex(({ id }) => id === entry.id) === index);
    const dimensions = {};
    for (const name of Object.keys(prior.dimensions)) {
      const values = [prior.dimensions[name], record.dimensions[name]];
      const value = values.some((entry) => entry?.value === true) ? true
        : values.every((entry) => entry?.value === false) ? false : null;
      dimensions[name] = {
        value,
        evidenceRefs: [...new Set(values.flatMap((entry) => entry?.evidenceRefs ?? []))],
      };
    }
    merged.set(identity, {
      ...prior,
      displayName: prior.displayName || record.displayName,
      aliases: [...prior.aliases, ...record.aliases]
        .filter((entry, index, all) => all.findIndex(({ name, resolvesTo }) => name === entry.name && resolvesTo === entry.resolvesTo) === index),
      variant: { ...prior.variant, ...record.variant },
      lifecycle: record.lifecycle?.state !== 'unknown' ? record.lifecycle : prior.lifecycle,
      capabilities: { ...prior.capabilities, ...record.capabilities },
      dimensions, evidence,
    });
  }
  return [...merged.values()];
}

function rescopeRecord(record, fingerprint) {
  return {
    ...structuredClone(record),
    key: { ...record.key, scopeId: fingerprint },
    evidence: (record.evidence ?? []).map((entry) => ({ ...entry, scopeFingerprint: fingerprint })),
    edges: (record.edges ?? []).map((edge) => ({ ...edge, scopeFingerprint: fingerprint })),
  };
}

function bindingReferencesModel(binding, model) {
  if (!binding.host || binding.host !== model.key.host) return false;
  if (binding.provider && model.key.provider && binding.provider !== model.key.provider) return false;
  const refs = new Set([
    model.key.modelId,
    model.key.provider ? `${model.key.provider}/${model.key.modelId}` : null,
    ...(model.aliases ?? []).map(({ name }) => name),
  ].filter(Boolean));
  return [binding.configured, binding.effective].filter(Boolean).some((ref) => refs.has(ref));
}

function bindingEvidence(binding, model, field, capturedAt, fingerprint) {
  return {
    id: `evidence:${createHash('sha256').update([
      binding.id, model.key.host, model.key.provider ?? '', model.key.modelId, field, capturedAt,
    ].join('\n')).digest('hex').slice(0, 24)}`,
    field: `dimensions.${field}`, source: binding.source ?? 'kit.json', class: 'configured',
    capturedAt, freshness: 'fresh', completeness: 'complete', scopeFingerprint: fingerprint, refs: [],
  };
}

function applyBindings(models, bindings, capturedAt, fingerprint) {
  const result = [...models];
  for (const binding of bindings) {
    const configured = binding.configured ?? binding.modelRef;
    const effective = binding.effective;
    if (!binding.host || (!configured && !effective)) continue;
    let matches = result.filter((model) => bindingReferencesModel(binding, model));
    if (!matches.length && configured) {
      let provider = binding.provider ?? null;
      let modelId = configured;
      if (!provider && binding.host === 'opencode' && configured.includes('/')) {
        [provider, modelId] = [configured.slice(0, configured.indexOf('/')), configured.slice(configured.indexOf('/') + 1)];
      }
      const source = {
        id: `binding:${binding.source ?? 'local-config'}`, capturedAt, complete: true,
        freshness: 'current', evidenceClass: 'configured',
      };
      const record = modelRecord({
        host: binding.host, provider, modelId, scopeId: fingerprint, source,
        states: { configured: true, effective: effective ? true : 'unknown' },
      });
      result.push(record);
      matches = [record];
    }
    for (const model of matches) {
      const establishedFields = /** @type {Array<[string, boolean]>} */ ([
        ['configured', Boolean(configured)], ['effective', Boolean(effective)],
      ]);
      for (const [field, established] of establishedFields) {
        if (!established) continue;
        const evidence = bindingEvidence(binding, model, field, capturedAt, fingerprint);
        if (!model.evidence.some(({ id }) => id === evidence.id)) model.evidence.push(evidence);
        model.dimensions[field] = {
          value: true,
          evidenceRefs: [...new Set([...(model.dimensions[field]?.evidenceRefs ?? []), evidence.id])],
        };
      }
    }
  }
  return result;
}

export function composeModelSnapshot(collection, {
  scope = {}, scopeKey, capturedAt = collection?.generatedAt ?? new Date().toISOString(),
} = /** @type {any} */ ({})) {
  const discoveryResults = Object.values(collection?.discovery?.results ?? {});
  const profileFingerprints = Object.fromEntries(discoveryResults
    .filter((result) => result?.source?.scopeFingerprint)
    .map((result) => [result.source.owner ?? result.source.id, result.source.scopeFingerprint]));
  const hosts = Object.keys(collection?.discovery?.results ?? {}).sort();
  const fingerprint = scopeFingerprint('inventory', { ...scope, hosts: hosts.join(',') }, scopeKey);
  const sources = [...discoveryResults.map(({ source }) => source), collection?.observed?.source]
    .filter(Boolean)
    .map((source) => ({ ...source, scopeFingerprint: fingerprint, scopeId: fingerprint }));
  const discoveredAndObserved = mergeModels([
    ...discoveryResults.flatMap(({ models }) => models ?? []),
    ...(collection?.observed?.models ?? []),
  ].map((record) => rescopeRecord(record, fingerprint)));
  const bindings = collection?.bindings?.bindings ?? [];
  const models = applyBindings(discoveredAndObserved, bindings, capturedAt, fingerprint);
  const diagnostics = [
    ...discoveryResults.flatMap(({ diagnostics }) => diagnostics ?? []),
    ...(collection?.observed?.diagnostics ?? []),
    ...(collection?.bindings?.diagnostics ?? []),
  ].map((entry) => typeof entry === 'string' ? entry : entry.code).filter(Boolean);
  const digestInput = JSON.stringify({ capturedAt, fingerprint, sources, models, bindings });
  return normalizeSnapshot({
    schemaVersion: MODEL_INVENTORY_SCHEMA_VERSION,
    snapshotId: `models:${createHash('sha256').update(digestInput).digest('hex').slice(0, 20)}`,
    capturedAt,
    scope: { fingerprint, machine: null, project: null, hosts, profileFingerprints },
    sources, models, bindings, changes: [], opportunities: [], diagnostics: [...new Set(diagnostics)],
  });
}

/** @param {any} options */
export async function collectModelSnapshot(options = {}) {
  const scopeKey = options.scopeKey ?? readOrCreateModelScopeKey();
  const capturedAt = options.discoveryOptions?.capturedAt ?? new Date().toISOString();
  const collection = await collectModelInventory({
    ...options, scopeKey,
    discoveryOptions: { ...options.discoveryOptions, capturedAt },
  });
  return composeModelSnapshot(collection, { scope: options.scope, scopeKey, capturedAt });
}
