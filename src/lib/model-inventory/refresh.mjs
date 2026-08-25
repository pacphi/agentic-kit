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
import { scopeFingerprint } from './discovery/index.mjs';

const DEFAULT_OWNERS = Object.freeze(['claude', 'codex', 'opencode', 'ollama']);
const CONTACT = Object.freeze({
  claude: 'Claude local settings', codex: 'Codex local model cache',
  opencode: 'opencode catalog', ollama: 'local Ollama daemon',
});

function readOptional(file, readFileFn) {
  try { return readFileFn(file, 'utf8'); } catch { return undefined; }
}

export async function refreshModelDiscovery({
  owners = DEFAULT_OWNERS, online = false, runner = run, readFileFn = fs.readFileSync,
  cwd = process.cwd(), inputs = {}, capturedAt, scope = {}, scopeKey,
} = /** @type {any} */ ({})) {
  const fingerprintKey = scopeKey ?? readOrCreateModelScopeKey();
  const results = {};
  const contacts = [];
  for (const owner of owners) {
    if (!DEFAULT_OWNERS.includes(owner)) throw new TypeError(`unsupported model discovery owner: ${String(owner)}`);
    contacts.push(CONTACT[owner]);
    const ownerScope = { ...scope, ...(owner === 'opencode' ? { project: cwd } : {}) };
    let options = { capturedAt, scope: ownerScope, scopeKey: fingerprintKey };
    if (owner === 'claude') {
      options = {
        ...options,
        settingsRaw: inputs.claude?.settingsRaw ?? readOptional(paths.claudeSettingsPath(), readFileFn),
        managedSettingsRaw: inputs.claude?.managedSettingsRaw,
        environment: inputs.claude?.environment ?? {},
      };
    } else if (owner === 'codex') {
      options = {
        ...options,
        cacheRaw: inputs.codex?.cacheRaw ?? readOptional(path.join(paths.codexDir(), 'models_cache.json'), readFileFn),
        configRaw: inputs.codex?.configRaw ?? readOptional(path.join(paths.codexDir(), 'config.toml'), readFileFn),
      };
    } else if (owner === 'opencode') {
      options = {
        ...options, runner, online, provider: inputs.opencode?.provider,
        configRaw: inputs.opencode?.configRaw ?? readOptional(path.join(cwd, 'opencode.json'), readFileFn),
      };
    } else {
      options = { ...options, runner };
    }
    results[owner] = await discoverModels(owner, options);
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

export function composeModelSnapshot(collection, {
  scope = {}, scopeKey, capturedAt = collection?.generatedAt ?? new Date().toISOString(),
} = {}) {
  const discoveryResults = Object.values(collection?.discovery?.results ?? {});
  const profileFingerprints = Object.fromEntries(discoveryResults
    .filter((result) => result?.source?.scopeFingerprint)
    .map((result) => [result.source.owner ?? result.source.id, result.source.scopeFingerprint]));
  const hosts = Object.keys(collection?.discovery?.results ?? {}).sort();
  const fingerprint = scopeFingerprint('inventory', { ...scope, hosts: hosts.join(',') }, scopeKey);
  const sources = [...discoveryResults.map(({ source }) => source), collection?.observed?.source]
    .filter(Boolean)
    .map((source) => ({ ...source, scopeFingerprint: fingerprint, scopeId: fingerprint }));
  const models = mergeModels([
    ...discoveryResults.flatMap(({ models }) => models ?? []),
    ...(collection?.observed?.models ?? []),
  ]);
  const bindings = collection?.bindings?.bindings ?? [];
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

export async function collectModelSnapshot(options = {}) {
  const scopeKey = options.scopeKey ?? readOrCreateModelScopeKey();
  const capturedAt = options.discoveryOptions?.capturedAt ?? new Date().toISOString();
  const collection = await collectModelInventory({
    ...options, scopeKey,
    discoveryOptions: { ...options.discoveryOptions, capturedAt },
  });
  return composeModelSnapshot(collection, { scope: options.scope, scopeKey, capturedAt });
}
