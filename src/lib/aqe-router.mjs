// aqe-router.mjs — the ONE definition of the AQE-router convergence pipeline:
// `.agentic-qe/llm-config.json`'s fallback chain, default provider, external
// provider declarations/activations, and `agentOverrides` projection.
// Extracted from providers.mjs (ADR-0037) so that 1,000+ line file stays under
// its max-lines budget; providers.mjs re-imports `applyAqeRouter`,
// `aqeRouterDrift`, and `undoAqeRouter` so every existing external import path
// (`./providers.mjs`) keeps working unchanged.
//
// Five surfaces used to be braided together in one function, sharing mutable
// accumulators with implicit cross-surface feedback: `externalActive`
// (computed while reconciling external providers) constrained what the
// fallback-chain/default-provider/agentOverrides surfaces below it could
// safely reference, and `projected`/`staleOverrides` had to be recomputed
// after that same fact became known. Each surface below is a
// `(next, ctx) => {detail, error, changed, ctx?}` step, folded left-to-right
// over one shared `next` draft; a surface returns an optional `ctx` PATCH
// (applied before the next surface runs) instead of closing over an outer
// `let` — the one real cross-surface dependency (externalActive -> the
// refined `projected`/`staleOverrides`) is the only patch actually used, so
// it stays a single, explicit, ordered hand-off rather than several loose
// mutable accumulators.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './paths.mjs';
import { readJson, writeJsonWithBackup } from './settings.mjs';
import { configuredPolicyToAgentOverrides, AGENT_ACTIVITY_MAP } from './routing.mjs';
import { admittedAqeProviders } from './adapters/aqe-provider.mjs';
import {
  AQE_OWNERSHIP_KEY, EXTERNAL_PROVIDERS_MIN_AQE, stableValue, declarationHash, plainRecord,
  aqeExternalProviders, aqeRouterFile, aqeSupportsExternalProviders, aqeSupportsAgentOverrides,
  aqeSelectableChainProviderTypes, credentialGaps,
} from './providers.mjs';

// See providers.mjs's own `mergeRouterConfig`/`applyProviders` comments for
// why every field here is a REQUIRED scalar default, not an optional one:
//   - mergeRouterConfig deep-merges `providers` but SHALLOW-replaces
//     `fallbackChain` → ak must write a COMPLETE chain (these scalar defaults).
//   - the router iterates `entry.models` → each entry needs populated models.
//   - aqe refuses to persist apiKey → ak writes only `enabled` per provider;
//     keys stay in the env.
const AQE_CHAIN_DEFAULTS = { maxRetries: 3, retryDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 5000 };
const AQE_MANAGED_TAG = 'agentic-kit';

function admittedProviderRecord(id) {
  const records = admittedAqeProviders();
  return (Array.isArray(records) ? records : Object.values(records ?? {}))
    .find((entry) => (entry.id ?? entry.providerId ?? entry.type) === id) ?? null;
}

function exactlyOwnedDefault(config, receiptKey) {
  const provider = config?.defaultProvider;
  const receipt = plainRecord(config?.[AQE_OWNERSHIP_KEY]?.[receiptKey]);
  return typeof provider === 'string' && receipt?.provider === provider
    && receipt.writtenHash === declarationHash(provider)
    ? provider
    : null;
}

function setDefaultOwnership(config, receiptKey, provider) {
  const ownership = { ...(plainRecord(config[AQE_OWNERSHIP_KEY]) ?? {}) };
  ownership[receiptKey] = { provider, writtenHash: declarationHash(provider) };
  config[AQE_OWNERSHIP_KEY] = ownership;
}

function clearDefaultOwnership(config, receiptKey) {
  const ownership = { ...(plainRecord(config[AQE_OWNERSHIP_KEY]) ?? {}) };
  delete ownership[receiptKey];
  if (Object.keys(ownership).length) config[AQE_OWNERSHIP_KEY] = ownership;
  else delete config[AQE_OWNERSHIP_KEY];
}

const exactlyOwnedExternalDefault = (config) => exactlyOwnedDefault(config, 'externalDefaultProvider');
const exactlyOwnedFallbackDefault = (config) => exactlyOwnedDefault(config, 'fallbackDefaultProvider');
const setExternalDefaultOwnership = (config, provider) =>
  setDefaultOwnership(config, 'externalDefaultProvider', provider);
const setFallbackDefaultOwnership = (config, provider) =>
  setDefaultOwnership(config, 'fallbackDefaultProvider', provider);
const clearExternalDefaultOwnership = (config) =>
  clearDefaultOwnership(config, 'externalDefaultProvider');
const clearFallbackDefaultOwnership = (config) =>
  clearDefaultOwnership(config, 'fallbackDefaultProvider');

/** One `desired` entry whose live declaration differs from what ak last wrote:
 *  user-owned now. Its activation keeps an exact receipt only when it still
 *  matches what ak wrote, so a later revoke can still remove the minimal
 *  record ak created without ever touching the edited declaration. */
function reconcileConflictingDeclaration(id, prior, currentActivation, receipts) {
  if (prior?.providerWrittenHash && currentActivation !== undefined
    && declarationHash(currentActivation) === prior.providerWrittenHash) {
    receipts[id] = { providerWrittenHash: prior.providerWrittenHash };
  } else {
    delete receipts[id];
  }
}

/** Activation bookkeeping for one accepted declaration. AQE 3.13.12's MCP
 *  router asks whether any providers are enabled BEFORE it loads
 *  externalProviders (the load is what registers them) — a minimal owned
 *  `providers[id].enabled` record breaks that bootstrap cycle, so ak owns one
 *  only when the id had NO prior activation; a user-owned or already-enabled
 *  activation is left alone (and usable only once genuinely enabled). */
function reconcileProviderActivation(id, currentProviders, prior, nextReceipt) {
  const currentActivation = currentProviders[id];
  const priorActivationHash = prior?.providerWrittenHash;
  const activationHash = currentActivation === undefined ? null : declarationHash(currentActivation);
  if (currentActivation === undefined) {
    currentProviders[id] = { enabled: true };
    nextReceipt.providerWrittenHash = declarationHash(currentProviders[id]);
    return { added: true, ok: true };
  }
  if (currentActivation?.enabled === true) {
    if (priorActivationHash && activationHash === priorActivationHash) {
      nextReceipt.providerWrittenHash = priorActivationHash;
    }
    return { added: false, ok: true };
  }
  return { added: false, ok: false };
}

/** One `desired[id]` entry: accept it, flag it as a conflict, or reconcile its
 *  activation. Mutates `state`'s collections in place. */
function reconcileDesiredProvider(id, declaration, priorReceipts, state) {
  const { current, currentProviders, receipts } = state;
  const prior = priorReceipts[id];
  const currentDeclaration = current[id];
  const currentHash = currentDeclaration === undefined ? null : declarationHash(currentDeclaration);
  if (currentDeclaration !== undefined && (!prior || currentHash !== prior.writtenHash)) {
    state.conflicts.push(id);
    state.unavailable.add(id);
    reconcileConflictingDeclaration(id, prior, currentProviders[id], receipts);
    return;
  }
  current[id] = declaration;
  const record = admittedProviderRecord(id);
  const nextReceipt = {
    hostId: record?.hostId ?? record?.host ?? record?.manifestId ?? null,
    contentHash: record?.contentHash ?? record?.integrity ?? null,
    writtenHash: declarationHash(declaration),
  };
  if (currentDeclaration === undefined) state.added.push(id);

  const activation = reconcileProviderActivation(id, currentProviders, prior, nextReceipt);
  if (activation.ok) {
    state.active.add(id);
    if (activation.added) state.activationsAdded.push(id);
  } else {
    state.conflicts.push(`${id} (providers.${id}.enabled is not true)`);
    state.unavailable.add(id);
  }
  receipts[id] = nextReceipt;
}

/** One `priorReceipts[id]` entry no longer in `desired`: retire it, pruning
 *  the declaration/activation ak wrote when they are still exactly what it
 *  wrote (a user edit is preserved, not silently deleted). */
function retireStaleProvider(id, receipt, state) {
  const { current, currentProviders, receipts } = state;
  state.retired.push(id);
  const currentDeclaration = current[id];
  if (currentDeclaration !== undefined && declarationHash(currentDeclaration) === receipt.writtenHash) {
    delete current[id];
    state.pruned.push(id);
  }
  const currentActivation = currentProviders[id];
  if (receipt.providerWrittenHash && currentActivation !== undefined
    && declarationHash(currentActivation) === receipt.providerWrittenHash) {
    delete currentProviders[id];
    state.activationsPruned.push(id);
  }
  delete receipts[id];
}

/** Compare the live admitted declarations with the exact values ak previously
 * wrote. Foreign entries and user-edited owned entries are never overwritten or
 * removed. Returned `active` ids are safe to reference from defaults/chains. */
function reconcileExternalProviders(existing, desired = aqeExternalProviders()) {
  const current = { ...(existing.externalProviders ?? {}) };
  const currentProviders = { ...(existing.providers ?? {}) };
  // Ownership metadata is advisory proof, never trusted input. A null/array/
  // primitive receipt proves nothing and must be dropped rather than crashing
  // sync or authorizing deletion of user values.
  const rawReceipts = plainRecord(existing[AQE_OWNERSHIP_KEY]?.externalProviders) ?? {};
  const priorReceipts = Object.fromEntries(Object.entries(rawReceipts)
    .filter(([, receipt]) => plainRecord(receipt)));
  const state = {
    current,
    currentProviders,
    receipts: { ...priorReceipts },
    active: new Set(),
    conflicts: [],
    unavailable: new Set(),
    retired: [],
    pruned: [],
    added: [],
    activationsAdded: [],
    activationsPruned: [],
  };

  for (const [id, declaration] of Object.entries(desired)) {
    reconcileDesiredProvider(id, declaration, priorReceipts, state);
  }
  for (const [id, receipt] of Object.entries(priorReceipts)) {
    if (id in desired) continue;
    retireStaleProvider(id, receipt, state);
  }

  return {
    externalProviders: state.current,
    providers: state.currentProviders,
    receipts: state.receipts,
    active: state.active,
    conflicts: state.conflicts,
    unavailable: [...state.unavailable],
    retired: state.retired,
    pruned: state.pruned,
    added: state.added,
    activationsAdded: state.activationsAdded,
    activationsPruned: state.activationsPruned,
  };
}

/** Map kit.json `aqeFallback` entries → a complete aqe FallbackChain. Priority
 *  descends by list order (first = highest). Entries carry provider + models. */
function buildChain(entries) {
  return {
    id: AQE_MANAGED_TAG,
    entries: entries.map((e, i) => ({
      provider: e.provider,
      models: e.models ?? [],
      enabled: true,
      priority: 100 - i * 10,
      maxAttempts: 2,
      timeoutMs: 30000,
    })),
    ...AQE_CHAIN_DEFAULTS,
  };
}

/** The externalProviders surface's own detail line — split out only to keep
 *  that surface's branch count (five independent `?  : ''` clauses) legible
 *  and under the reconciler's own complexity budget. */
function formatExternalProvidersDetail(externalActive, reconciled) {
  return `externalProviders: ${externalActive.size} managed`
    + (reconciled.added.length ? ` (${reconciled.added.length} added)` : '')
    + (reconciled.pruned.length ? ` (${reconciled.pruned.length} stale owned pruned)` : '')
    + (reconciled.activationsAdded.length ? ` (${reconciled.activationsAdded.length} MCP activation added)` : '')
    + (reconciled.activationsPruned.length ? ` (${reconciled.activationsPruned.length} stale activation pruned)` : '')
    + (reconciled.conflicts.length ? ` (⚠ conflicts preserved: ${reconciled.conflicts.join(', ')})` : '');
}

/** Surface 1/4: reconcile admitted external-provider declarations/activations
 *  against the live file, prune anything that became unavailable from the
 *  fallback chain/defaultProvider, and refine `projected`/`staleOverrides` for
 *  the surfaces after it (their safe-to-reference set depends on which
 *  external ids ended up active here). */
function reconcileExternalProvidersSurface(next, ctx) {
  const {
    existing, desiredExternal, hasExternal, hasOwnedExternal, externalSupported,
    hasManagedFallback, ownedFallbackDefault, ownedExternalDefault,
    priorOverrides, managedOverrideKeys, projected: priorProjected,
  } = ctx;
  let externalActive = new Set();
  let error = null;
  let changed = false;
  const detail = [];

  if (hasExternal || hasOwnedExternal) {
    // A downgrade must remove only unchanged entries we previously wrote,
    // plus their dangling references. Keeping declarations that this AQE
    // version cannot understand would strand every router startup on drift.
    const reconciled = reconcileExternalProviders(existing, externalSupported ? desiredExternal : {});
    externalActive = reconciled.active;
    if (Object.keys(reconciled.externalProviders).length) next.externalProviders = reconciled.externalProviders;
    else delete next.externalProviders;
    if (Object.keys(reconciled.providers).length) next.providers = reconciled.providers;
    else delete next.providers;
    const ownership = { ...(plainRecord(next[AQE_OWNERSHIP_KEY]) ?? {}) };
    if (!ownedExternalDefault) delete ownership.externalDefaultProvider;
    if (Object.keys(reconciled.receipts).length) ownership.externalProviders = reconciled.receipts;
    else delete ownership.externalProviders;
    if (Object.keys(ownership).length) next[AQE_OWNERSHIP_KEY] = ownership;
    else delete next[AQE_OWNERSHIP_KEY];
    if (reconciled.conflicts.length) {
      error = `refused conflicting foreign/user-edited external provider ids: ${reconciled.conflicts.join(', ')}`;
    }
    detail.push(formatExternalProvidersDetail(externalActive, reconciled));
    if (hasExternal && !externalSupported) {
      error = `external providers need agentic-qe >=${EXTERNAL_PROVIDERS_MIN_AQE}`;
      detail.push(`externalProviders: disabled (${error})`);
    }
    const unavailableExternal = new Set([...reconciled.unavailable, ...reconciled.retired]);
    if (hasManagedFallback && next.fallbackChain?.entries) {
      next.fallbackChain = {
        ...next.fallbackChain,
        entries: next.fallbackChain.entries.filter((entry) => !unavailableExternal.has(entry.provider)),
      };
      if (next.fallbackChain.entries.length === 0) delete next.fallbackChain;
    }
    if (unavailableExternal.has(next.defaultProvider)
      && (ownedFallbackDefault === next.defaultProvider || ownedExternalDefault === next.defaultProvider)) {
      delete next.defaultProvider;
      clearExternalDefaultOwnership(next);
      clearFallbackDefaultOwnership(next);
    }
    changed = reconciled.added.length > 0 || reconciled.pruned.length > 0
      || reconciled.activationsAdded.length > 0 || reconciled.activationsPruned.length > 0
      || Object.keys(desiredExternal).some((id) => existing.externalProviders?.[id]
        && declarationHash(existing.externalProviders[id]) !== declarationHash(desiredExternal[id]));
  }

  // Admission/version/conflict filtering can make a previously projected
  // external route inactive. Recompute from the safe projection so ak-owned
  // overrides never retain an unusable id — this runs regardless of whether
  // the branch above executed (externalActive then defaults to empty).
  const projected = Object.fromEntries(Object.entries(priorProjected).filter(([, entry]) =>
    !(entry.provider in desiredExternal) || externalActive.has(entry.provider)));
  const staleOverrides = Object.keys(priorOverrides)
    .filter((agent) => managedOverrideKeys.has(agent) && !(agent in projected));

  return {
    detail, error, changed, ctx: { externalActive, projected, staleOverrides },
  };
}

/** Surface 2/4: retire a previously-written managed fallback chain (and its
 *  derived default) once the canonical `aqeFallback` intent goes empty. */
function reconcileFallbackRetirementSurface(next, ctx) {
  const {
    hasChain, hasManagedFallback, ownedFallbackDefault, ownedExternalDefault,
  } = ctx;
  if (hasChain || !hasManagedFallback) return null;
  // An empty canonical fallback intent retires the tagged chain ak previously
  // wrote. Its derived default belongs to the same projection and must not
  // survive independently; provider declarations/activations remain available
  // for explicit selection, routes, or a future chain.
  delete next.fallbackChain;
  if (ownedFallbackDefault) {
    delete next.defaultProvider;
    if (ownedExternalDefault) clearExternalDefaultOwnership(next);
  }
  clearFallbackDefaultOwnership(next);
  return { detail: 'chain: managed fallback retired', changed: true };
}

/** Surface 3/4: decide `defaultProvider` and which of the two ownership
 *  receipts (external vs. fallback-chain-derived) it carries, across the
 *  three ways it can change: explicit deselection, chain-derived assignment
 *  (which also builds/validates the active chain itself), and an explicit
 *  project-local external selection. */
function reconcileDefaultProviderSurface(next, ctx) {
  const {
    cfg, existing, chain, selectedProvider, hasChain, desiredExternal, externalActive, ownedExternalDefault,
  } = ctx;
  const detail = [];
  let error = null;
  let changed = false;

  // `aqeProvider: null` is an explicit deselection. Retire only an exact
  // external default that ak previously wrote, while leaving the admitted
  // declaration and MCP activation intact for routes or future selection.
  // A configured fallback chain owns default selection independently and is
  // handled below; it must not be erased by primary-provider deselection.
  if (!hasChain && selectedProvider === null && ownedExternalDefault) {
    delete next.defaultProvider;
    clearExternalDefaultOwnership(next);
    detail.push(`defaultProvider: ${ownedExternalDefault} retired`);
    changed = true;
  }

  if (hasChain) {
    const selectable = new Set(aqeSelectableChainProviderTypes());
    const valid = chain.filter((e) => e?.provider && selectable.has(e.provider)
      && (!(e.provider in desiredExternal) || externalActive.has(e.provider)));
    if (valid.length === 0) {
      // A bad chain must NOT block the independent agentOverrides projection — the
      // Activity routing is validated separately. Record it and carry on.
      error = 'no valid providers in fallback chain';
      detail.push(`chain: ⚠ ${error}`);
    } else {
      const requestedDefault = cfg.providers.aqeProvider;
      const requestedUnavailable = requestedDefault in desiredExternal && !externalActive.has(requestedDefault);
      next.defaultProvider = requestedUnavailable ? valid[0].provider : requestedDefault ?? valid[0].provider;
      setFallbackDefaultOwnership(next, next.defaultProvider);
      next.providers = { ...(next.providers ?? existing.providers ?? {}) };
      for (const e of valid) {
        if (!(e.provider in desiredExternal)) next.providers[e.provider] = { ...(existing.providers?.[e.provider] ?? {}), enabled: true };
      }
      next.fallbackChain = buildChain(valid);
      if (next.defaultProvider in desiredExternal && externalActive.has(next.defaultProvider)) {
        setExternalDefaultOwnership(next, next.defaultProvider);
      } else if (ownedExternalDefault) {
        clearExternalDefaultOwnership(next);
      }
      const emptyModels = valid.filter((e) => !e.models || e.models.length === 0).map((e) => e.provider);
      // Warn, never refuse: the user may export the key later, and silently
      // dropping a rung is worse than writing one that is currently inert (#54).
      const gaps = credentialGaps(valid);
      detail.push(`chain: ${valid.map((e) => e.provider).join(' → ')}`
        + (emptyModels.length ? ` (⚠ no models for: ${emptyModels.join(', ')})` : '')
        + (gaps.length ? ` (⚠ no credential for: ${gaps.map((g) => `${g.provider} — needs ${g.missing.join(', ')}`).join('; ')})` : ''));
      changed = true;
    }
  }

  // External provider selection is project-local by contract: AQE discovers it
  // from this file only. managedEnv deliberately never exports an external id
  // into project or user host settings.
  if (selectedProvider && selectedProvider in desiredExternal) {
    if (externalActive.has(selectedProvider)) {
      next.defaultProvider = selectedProvider;
      setExternalDefaultOwnership(next, selectedProvider);
      detail.push(`defaultProvider: ${selectedProvider} (project-local external)`);
      changed = true;
    } else {
      error ??= `external default '${selectedProvider}' is not safely managed`;
    }
  }

  return { detail, error, changed };
}

/** Surface 4/4: project `routing.routes` into aqe's `agentOverrides`, merged
 *  with (not replacing) foreign entries, pruning only the ak-owned entries
 *  the current projection no longer names (`ctx.staleOverrides`, refined by
 *  surface 1 against the final external-availability set). */
function reconcileAgentOverridesSurface(next, ctx) {
  const {
    existing, desiredExternal, priorOverrides, projected, staleOverrides, hasPolicy, agentOverridesSupported,
  } = ctx;
  if ((agentOverridesSupported && Object.keys(projected).length) || staleOverrides.length) {
    // MERGE, don't replace: ak owns only the curated agent-types it projects;
    // preserve foreign entries (aqe's own defaults or a hand-added agent). The
    // projector drops non-constructible providers (mirrors sanitizeAgentOverrides)
    // and only ever emits {provider, model} — no apiKey.
    next.agentOverrides = { ...priorOverrides };
    for (const agent of staleOverrides) delete next.agentOverrides[agent];
    if (agentOverridesSupported) Object.assign(next.agentOverrides, projected);
    // An override naming a provider is inert until that provider is ENABLED in
    // this same file: aqe enables from env keys or the `providers` map, and a
    // subscription host-CLI provider (codex, claude-code) has no env key at
    // all — so ak-projected codex overrides sat dead and warned on every aqe
    // startup (#108 phase 3). Enable exactly the providers the projection
    // references — merge-not-clobber, writing nothing beyond `enabled`.
    const referenced = agentOverridesSupported
      ? [...new Set(Object.values(projected).map((entry) => entry.provider))]
      : [];
    if (referenced.length) {
      next.providers = { ...(next.providers ?? existing.providers ?? {}) };
      for (const provider of referenced) {
        if (!(provider in desiredExternal)) next.providers[provider] = { ...(next.providers[provider] ?? {}), enabled: true };
      }
    }
    return {
      changed: true,
      detail: `agentOverrides: ${agentOverridesSupported ? Object.keys(projected).length : 0} agents`
        + (referenced.length ? ` (providers enabled: ${referenced.join(', ')})` : '')
        + (staleOverrides.length ? ` (${staleOverrides.length} stale ak entries pruned)` : '')
        + (!agentOverridesSupported ? ' (new projection skipped; needs agentic-qe ≥ 3.13.1)' : ''),
    };
  }
  if (hasPolicy && !agentOverridesSupported) return { detail: 'agentOverrides: skipped (needs agentic-qe ≥ 3.13.1)' };
  if (hasPolicy && Object.keys(projected).length === 0) return { detail: 'agentOverrides: skipped (no safely constructible providers)' };
  return null;
}

const AQE_ROUTER_SURFACES = [
  reconcileExternalProvidersSurface,
  reconcileFallbackRetirementSurface,
  reconcileDefaultProviderSurface,
  reconcileAgentOverridesSurface,
];

/** Fold an ordered list of `(draft, ctx) => {detail, error, changed, ctx?}`
 *  surface reconcilers over one draft, left to right. A surface's own `ctx`
 *  patch (if any) is applied before the next surface runs — the only
 *  sanctioned channel for one surface's output to inform a later one (see the
 *  section comment above AQE_ROUTER_SURFACES). `draft`/`ctx` are mutated in
 *  place as usual; returns the accumulated {details, changed, error}. */
function foldSurfaces(surfaces, draft, ctx) {
  const details = [];
  let changed = false;
  let error = null;
  for (const reconcile of surfaces) {
    const result = reconcile(draft, ctx);
    if (!result) continue;
    if (result.detail) {
      if (Array.isArray(result.detail)) details.push(...result.detail);
      else details.push(result.detail);
    }
    if (result.changed) changed = true;
    if (result.error) error ??= result.error;
    if (result.ctx) Object.assign(ctx, result.ctx);
  }
  return { details, changed, error };
}

/** True when nothing in `cfg`/the on-disk file requires any router surface to
 *  run — the router file is left untouched (and unread beyond this check). */
function aqeRouterHasNothingToApply({
  hasChain, hasPolicy, hasExternal, hasOwnedExternal, hasManagedFallback,
  hasExternalDefaultReceipt, hasFallbackDefaultReceipt, staleOverrides,
}) {
  return !hasChain && !hasPolicy && !hasExternal && !hasOwnedExternal && !hasManagedFallback
    && !hasExternalDefaultReceipt && !hasFallbackDefaultReceipt && staleOverrides.length === 0;
}

/** Exact receipts never regain authority. If a user changes the default away
 *  from the value ak wrote (external default), or the managed fallback chain
 *  that derived a default is gone or no longer owned, relinquish that receipt
 *  immediately — changing it back later is still a user write and cannot
 *  resurrect it. Runs before any surface, on the initial draft. */
function clearStaleDefaultReceipts(next, {
  hasExternalDefaultReceipt, ownedExternalDefault, hasFallbackDefaultReceipt, ownedFallbackDefault, hasManagedFallback,
}) {
  if (hasExternalDefaultReceipt && !ownedExternalDefault) clearExternalDefaultOwnership(next);
  if (hasFallbackDefaultReceipt && (!ownedFallbackDefault || !hasManagedFallback)) clearFallbackDefaultOwnership(next);
}

/** Build the read-only context the AQE-router fold needs: repo-root resolution
 *  (same gate as settingsTarget — the scope gates must never disagree about
 *  what "in a project" means), the on-disk router file, and every derived
 *  fact/flag the surfaces consume. Returns null outside a project. Split out
 *  of applyAqeRouter so a read-only comparator (aqeRouterDrift) can ask "what
 *  would the writer converge this to" without ever touching disk (#129) —
 *  the ONE construction of this context, shared by the writer and the reader. */
function buildAqeRouterContext(cfg, cwd) {
  const chain = cfg.providers?.aqeFallback ?? [];
  const policy = cfg.routing?.routes ?? {};
  const selectedProvider = cfg.providers?.aqeProvider ?? null;
  const hasChain = chain.length > 0;
  const hasPolicy = Object.keys(policy).length > 0;
  const root = repoRoot(cwd);
  if (!root) return null;
  const file = aqeRouterFile(root);
  const existing = readJson(file, {}) ?? {};
  const ownedExternalDefault = exactlyOwnedExternalDefault(existing);
  const ownedFallbackDefault = exactlyOwnedFallbackDefault(existing);
  const desiredExternal = aqeExternalProviders({ projectRoot: root });
  const hasExternal = Object.keys(desiredExternal).length > 0;
  const hasOwnedExternal = Object.keys(existing[AQE_OWNERSHIP_KEY]?.externalProviders ?? {}).length > 0;
  const existingOwnership = plainRecord(existing[AQE_OWNERSHIP_KEY]) ?? {};
  const hasExternalDefaultReceipt = Object.hasOwn(existingOwnership, 'externalDefaultProvider');
  const hasFallbackDefaultReceipt = Object.hasOwn(existingOwnership, 'fallbackDefaultProvider');
  const hasManagedFallback = existing.fallbackChain?.id === AQE_MANAGED_TAG;
  const priorOverrides = existing.agentOverrides ?? {};
  const projected = configuredPolicyToAgentOverrides(policy);
  const managedOverrideKeys = new Set(Object.keys(AGENT_ACTIVITY_MAP));
  const staleOverrides = Object.keys(priorOverrides)
    .filter((agent) => managedOverrideKeys.has(agent) && !(agent in projected));

  const facts = {
    hasChain, hasPolicy, hasExternal, hasOwnedExternal, hasManagedFallback,
    hasExternalDefaultReceipt, hasFallbackDefaultReceipt, staleOverrides,
  };
  const ctx = {
    cfg,
    existing,
    chain,
    selectedProvider,
    hasChain,
    hasPolicy,
    desiredExternal,
    hasExternal,
    hasOwnedExternal,
    hasManagedFallback,
    ownedExternalDefault,
    ownedFallbackDefault,
    priorOverrides,
    managedOverrideKeys,
    projected,
    staleOverrides,
    externalActive: new Set(),
    externalSupported: aqeSupportsExternalProviders(),
    agentOverridesSupported: aqeSupportsAgentOverrides(),
  };
  return {
    root, file, existing, facts, ctx,
  };
}

/** Run the ordered AQE_ROUTER_SURFACES fold over a fresh draft cloned from
 *  `existing` — mutates neither `existing` nor disk. This is the pure "what
 *  would the writer converge this to" computation shared by applyAqeRouter
 *  (which persists the result when it differs) and aqeRouterDrift (which only
 *  needs to know what the writer WOULD produce). */
function runAqeRouterFold({ existing, facts, ctx }) {
  const next = { ...existing };
  clearStaleDefaultReceipts(next, {
    hasExternalDefaultReceipt: facts.hasExternalDefaultReceipt,
    ownedExternalDefault: ctx.ownedExternalDefault,
    hasFallbackDefaultReceipt: facts.hasFallbackDefaultReceipt,
    ownedFallbackDefault: ctx.ownedFallbackDefault,
    hasManagedFallback: facts.hasManagedFallback,
  });
  const { details, changed, error } = foldSurfaces(AQE_ROUTER_SURFACES, next, ctx);
  return {
    next, details, changed, error,
  };
}

/** Write ak's managed router config into `.agentic-qe/llm-config.json`, merged
 *  into any existing file (backup-first, never persisting apiKey):
 *    - the ordered fallback chain + enabled set + default provider (from
 *      `aqeFallback`), and
 *    - the per-activity `agentOverrides` map projected from `routing.routes`
 *      (issue #568; only when installed aqe ≥ 3.13.1).
 *  No-op unless at least one of those is configured and we are in a project.
 *  Folds AQE_ROUTER_SURFACES over one draft (see the module comment above);
 *  this function is the setup (context + initial draft), the fold, and the
 *  final change-detect-and-write.
 *  Returns {ok, changed, detail}. */
export function applyAqeRouter(cfg, cwd = process.cwd()) {
  const built = buildAqeRouterContext(cfg, cwd);
  if (!built) return { ok: true, changed: false, detail: 'not a project — aqe router unmanaged' };
  const { file, existing, facts } = built;
  if (aqeRouterHasNothingToApply(facts)) {
    return { ok: true, changed: false, detail: 'no aqe router config to apply' };
  }

  const { next, details, changed: surfacesChanged, error } = runAqeRouterFold(built);

  // One exact compare, reused for both phases below (the prior version
  // stringified `existing` twice for the same never-mutated object).
  const existingSnapshot = JSON.stringify(stableValue(existing));
  const changed = surfacesChanged || JSON.stringify(stableValue(next)) !== existingSnapshot;
  if (!changed) return { ok: !error, changed: false, detail: details.join('; ') || 'nothing to apply' };
  next._managedBy = AQE_MANAGED_TAG;
  // A surface reporting `changed: true` means this invocation owns at least
  // one projection surface; it does not by itself mean the artifact changed.
  // Compare the complete managed value (including the ownership tag) before
  // touching disk so a converged external default/fallback/override remains
  // byte- and mtime-stable across repeated syncs.
  if (JSON.stringify(stableValue(next)) === existingSnapshot) {
    return { ok: !error, changed: false, detail: details.join('; ') || 'nothing to apply' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonWithBackup(file, next);
  return { ok: !error, changed: true, detail: details.join('; ') };
}

/** Read-only: does the persisted fallback-chain order in
 *  `.agentic-qe/llm-config.json` differ from what applyAqeRouter would
 *  converge it to right now? Runs the SAME dry-run fold the writer runs
 *  (buildAqeRouterContext + runAqeRouterFold) and reads only the
 *  fallback-chain slice of the result — the writer's own chain-validity
 *  filter (reconcileDefaultProviderSurface's `valid`), not a re-derived
 *  approximation, so the two can never disagree (#129). Scoped to chain order
 *  only, same as before: agentOverrides/external-provider drift are each a
 *  sibling status section's own concern.
 *  `applicable: false` means there is no chain to compare (nothing configured,
 *  or outside the project scope applyAqeRouter itself declines to manage). */
export function aqeRouterDrift(cfg, cwd = process.cwd()) {
  const chain = cfg.providers?.aqeFallback ?? [];
  if (chain.length === 0) return { applicable: false, drift: false, order: '' };
  const built = buildAqeRouterContext(cfg, cwd);
  if (!built) return { applicable: false, drift: false, order: '' };
  const { existing } = built;
  const { next } = runAqeRouterFold(built);
  const order = (next.fallbackChain?.entries ?? []).map((e) => e.provider).join('→');
  const diskOrder = (existing.fallbackChain?.entries ?? []).map((e) => e.provider).join('→');
  const drift = order ? (existing._managedBy !== AQE_MANAGED_TAG || diskOrder !== order) : diskOrder !== '';
  return { applicable: true, drift, order };
}

/** Reversible teardown of ak's router management. Restores the pre-ak file from
 *  its one-time .bak, or removes an ak-created file. Never touches a file ak
 *  didn't write (no `_managedBy` tag). */
export function undoAqeRouter(cwd = process.cwd()) {
  const file = aqeRouterFile(cwd);
  if (!fs.existsSync(file)) return { ok: true, changed: false, detail: 'no aqe router config' };
  const cur = readJson(file);
  if (cur?._managedBy !== AQE_MANAGED_TAG) return { ok: true, changed: false, detail: 'llm-config.json not ak-managed — left as-is' };
  const bak = `${file}.bak`;
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, file);
    fs.rmSync(bak, { force: true });
    return { ok: true, changed: true, detail: 'restored pre-ak llm-config.json' };
  }
  fs.rmSync(file, { force: true });
  return { ok: true, changed: true, detail: 'removed ak-created llm-config.json' };
}
