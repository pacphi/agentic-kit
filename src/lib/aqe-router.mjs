// aqe-router.mjs — the ONE definition of the AQE-router convergence pipeline:
// `.agentic-qe/llm-config.json`'s fallback chain, default provider and
// `agentOverrides` projection.
// Extracted from providers.mjs (ADR-0037) so that 1,000+ line file stays under
// its max-lines budget; providers.mjs re-imports `applyAqeRouter`,
// `aqeRouterDrift`, and `undoAqeRouter` so every existing external import path
// (`./providers.mjs`) keeps working unchanged.
//
// Three surfaces, each a `(next, ctx) => {detail, error, changed}` step, folded
// left-to-right over one shared `next` draft. No surface hands a value to a
// later one: each reads the read-only `ctx` that buildAqeRouterContext builds once.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './paths.mjs';
import { readJson } from './settings.mjs';
import { writeOwnedRouter, undoOwnedRouter } from './provider-ownership.mjs';
import { configuredPolicyToAgentOverrides, AGENT_ACTIVITY_MAP } from './routing.mjs';
import {
  AQE_OWNERSHIP_KEY, AQE_CHAIN_PROVIDER_TYPES, stableValue, declarationHash, plainRecord,
  aqeRouterFile, aqeSupportsAgentOverrides, credentialGaps,
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

const exactlyOwnedFallbackDefault = (config) => exactlyOwnedDefault(config, 'fallbackDefaultProvider');
const setFallbackDefaultOwnership = (config, provider) =>
  setDefaultOwnership(config, 'fallbackDefaultProvider', provider);
const clearFallbackDefaultOwnership = (config) =>
  clearDefaultOwnership(config, 'fallbackDefaultProvider');

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

/** Surface 1/3: retire a previously-written managed fallback chain (and its
 *  derived default) once the canonical `aqeFallback` intent goes empty. */
function reconcileFallbackRetirementSurface(next, ctx) {
  const { hasChain, hasManagedFallback, ownedFallbackDefault } = ctx;
  if (hasChain || !hasManagedFallback) return null;
  // An empty canonical fallback intent retires the tagged chain ak previously
  // wrote. Its derived default belongs to the same projection and must not
  // survive independently; provider activations remain available for explicit
  // selection, routes, or a future chain.
  delete next.fallbackChain;
  if (ownedFallbackDefault) delete next.defaultProvider;
  clearFallbackDefaultOwnership(next);
  return { detail: 'chain: managed fallback retired', changed: true };
}

/** Surface 2/3: decide `defaultProvider` from the configured fallback chain,
 *  which also builds and validates the active chain itself, and keep the
 *  chain-derived ownership receipt in step with it. */
function reconcileDefaultProviderSurface(next, ctx) {
  const {
    cfg, existing, chain, hasChain,
  } = ctx;
  const detail = [];
  let error = null;
  let changed = false;

  if (hasChain) {
    const selectable = new Set(AQE_CHAIN_PROVIDER_TYPES);
    const valid = chain.filter((e) => e?.provider && selectable.has(e.provider));
    if (valid.length === 0) {
      // A bad chain must NOT block the independent agentOverrides projection — the
      // Activity routing is validated separately. Record it and carry on.
      error = 'no valid providers in fallback chain';
      detail.push(`chain: ⚠ ${error}`);
    } else {
      next.defaultProvider = cfg.providers.aqeProvider ?? valid[0].provider;
      setFallbackDefaultOwnership(next, next.defaultProvider);
      next.providers = { ...(next.providers ?? existing.providers ?? {}) };
      for (const e of valid) {
        next.providers[e.provider] = { ...(existing.providers?.[e.provider] ?? {}), enabled: true };
      }
      next.fallbackChain = buildChain(valid);
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

  return { detail, error, changed };
}

/** Surface 3/3: project `routing.routes` into aqe's `agentOverrides`, merged
 *  with (not replacing) foreign entries, pruning only the ak-owned entries
 *  the current projection no longer names (`ctx.staleOverrides`). */
function reconcileAgentOverridesSurface(next, ctx) {
  const {
    existing, priorOverrides, projected, staleOverrides, hasPolicy, agentOverridesSupported,
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
        next.providers[provider] = { ...(next.providers[provider] ?? {}), enabled: true };
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
  reconcileFallbackRetirementSurface,
  reconcileDefaultProviderSurface,
  reconcileAgentOverridesSurface,
];

/** Fold an ordered list of `(draft, ctx) => {detail, error, changed}` surface
 *  reconcilers over one draft, left to right. `draft` is mutated in place;
 *  returns the accumulated {details, changed, error}. */
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
  }
  return { details, changed, error };
}

/** True when nothing in `cfg`/the on-disk file requires any router surface to
 *  run — the router file is left untouched (and unread beyond this check). */
function aqeRouterHasNothingToApply({
  hasChain, hasPolicy, hasManagedFallback, hasFallbackDefaultReceipt, staleOverrides,
}) {
  return !hasChain && !hasPolicy && !hasManagedFallback
    && !hasFallbackDefaultReceipt && staleOverrides.length === 0;
}

/** Exact receipts never regain authority. If the managed fallback chain that
 *  derived a default is gone or no longer owned, relinquish that receipt
 *  immediately — changing the default back later is still a user write and
 *  cannot resurrect it. Runs before any surface, on the initial draft. */
function clearStaleDefaultReceipts(next, { hasFallbackDefaultReceipt, ownedFallbackDefault, hasManagedFallback }) {
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
  const hasChain = chain.length > 0;
  const hasPolicy = Object.keys(policy).length > 0;
  const root = repoRoot(cwd);
  if (!root) return null;
  const file = aqeRouterFile(root);
  const existing = readJson(file, {}) ?? {};
  const ownedFallbackDefault = exactlyOwnedFallbackDefault(existing);
  const existingOwnership = plainRecord(existing[AQE_OWNERSHIP_KEY]) ?? {};
  const hasFallbackDefaultReceipt = Object.hasOwn(existingOwnership, 'fallbackDefaultProvider');
  const hasManagedFallback = existing.fallbackChain?.id === AQE_MANAGED_TAG;
  const priorOverrides = existing.agentOverrides ?? {};
  const projected = configuredPolicyToAgentOverrides(policy);
  const managedOverrideKeys = new Set(Object.keys(AGENT_ACTIVITY_MAP));
  const staleOverrides = Object.keys(priorOverrides)
    .filter((agent) => managedOverrideKeys.has(agent) && !(agent in projected));

  const facts = {
    hasChain, hasPolicy, hasManagedFallback, hasFallbackDefaultReceipt, staleOverrides,
  };
  const ctx = {
    cfg,
    existing,
    chain,
    hasChain,
    hasPolicy,
    hasManagedFallback,
    ownedFallbackDefault,
    priorOverrides,
    managedOverrideKeys,
    projected,
    staleOverrides,
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
  // touching disk so a converged default/fallback/override remains
  // byte- and mtime-stable across repeated syncs.
  if (JSON.stringify(stableValue(next)) === existingSnapshot) {
    return { ok: !error, changed: false, detail: details.join('; ') || 'nothing to apply' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeOwnedRouter(file, next);
  return { ok: !error, changed: true, detail: details.join('; ') };
}

/** Read-only: does the persisted fallback-chain order in
 *  `.agentic-qe/llm-config.json` differ from what applyAqeRouter would
 *  converge it to right now? Runs the SAME dry-run fold the writer runs
 *  (buildAqeRouterContext + runAqeRouterFold) and reads only the
 *  fallback-chain slice of the result — the writer's own chain-validity
 *  filter (reconcileDefaultProviderSurface's `valid`), not a re-derived
 *  approximation, so the two can never disagree (#129). Scoped to chain order
 *  only, same as before: agentOverrides drift is a sibling status section's
 *  own concern.
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

/** Restore/remove only a verified unchanged projection. Legacy ownership or
 *  post-setup drift is preserved with a manual recovery path. */
export function undoAqeRouter(cwd = process.cwd()) {
  const file = aqeRouterFile(cwd);
  if (!fs.existsSync(file)) return { ok: true, changed: false, detail: 'no aqe router config' };
  const cur = readJson(file);
  if (cur?._managedBy !== AQE_MANAGED_TAG) return { ok: true, changed: false, detail: 'llm-config.json not ak-managed — left as-is' };
  return undoOwnedRouter(file);
}
