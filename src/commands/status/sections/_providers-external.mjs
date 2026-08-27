// Shared, cheap-to-recompute derivation for the "external AQE provider"
// facts several providers-* sections below consume. Deliberately NOT
// computed once in collect() and threaded through ctx: each caller wraps its
// own call in its own try/catch, so one section's probe failing doesn't
// silence the others (ADR-complexity-program #4 — the original single
// try/catch around all ~8 provider sub-concerns meant one thrown probe
// collapsed all of them into a single warn row). Re-reading a couple of
// small on-disk files a handful of times per `ak status` run is a
// negligible cost next to that isolation.
//
// TODO(complexity-program): re-home onto providers.mjs drift comparators
// post-integration — this duplicates write-side logic in src/lib/providers.mjs
// (applyAqeRouter's fallback-chain projection), a known issue tracked for a
// later cross-track step.
import * as paths from '../../../lib/paths.mjs';
import { readJson } from '../../../lib/settings.mjs';
import { HOSTS, aqeRouterFile, aqeExternalProviderState } from '../../../lib/providers.mjs';

function computeConfiguredAdapterIds(cfg) {
  const configuredAdapterIds = new Set((cfg.hostAdapters ?? [])
    .map((entry) => entry?.name).filter((name) => typeof name === 'string' && name));
  const builtinHostIds = new Set(HOSTS.map((host) => host.id));
  for (const id of Object.keys(cfg.integrations?.hosts ?? {})) {
    if (!builtinHostIds.has(id)) configuredAdapterIds.add(id);
  }
  return configuredAdapterIds;
}

function computeExternalIntent(cfg, configuredAdapterIds) {
  const externalIntent = new Set();
  if (configuredAdapterIds.has(cfg.providers?.aqeProvider)) externalIntent.add(cfg.providers.aqeProvider);
  for (const entry of cfg.providers?.aqeFallback ?? []) {
    if (configuredAdapterIds.has(entry?.provider)) externalIntent.add(entry.provider);
  }
  for (const route of Object.values(cfg.routing?.routes ?? {})) {
    if (configuredAdapterIds.has(route?.host)) externalIntent.add(route.host);
    for (const rung of route?.escalation ?? []) {
      if (configuredAdapterIds.has(rung?.host)) externalIntent.add(rung.host);
    }
  }
  return externalIntent;
}

export function computeProviderExternalState(cfg, cwd) {
  const externalRoot = paths.repoRoot(cwd);
  const externalDisk = externalRoot ? (readJson(aqeRouterFile(externalRoot), {}) ?? {}) : {};
  const external = externalRoot
    ? aqeExternalProviderState(externalDisk, { projectRoot: externalRoot })
    : null;
  const configuredAdapterIds = computeConfiguredAdapterIds(cfg);
  const externalIntent = computeExternalIntent(cfg, configuredAdapterIds);
  const liveExternal = new Set(external?.desired ?? []);
  const unavailableExternalIntent = [...externalIntent].filter((id) => !liveExternal.has(id));
  const unavailableExternalSet = new Set(unavailableExternalIntent);
  return { externalRoot, externalDisk, external, unavailableExternalIntent, unavailableExternalSet };
}
