// ADR-0048 facade composition root helper: builds every store, deriving
// path, and piece of shared mutable state `service.mjs`'s method groups
// close over. Kept separate so `createManagementService` itself stays a
// thin, low-complexity composition function.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readModelStore } from '../../model-inventory/store.mjs';
import { readDiscoveryConfiguration, resolveAutomaticSourceRoots } from '../discovery/configuration.mjs';
import { createCheckpointStore } from '../discovery/checkpoint.mjs';
import {
  createLastGoodSnapshotStore, createProjectEvidenceStore,
} from '../discovery/coverage.mjs';
import { createScanHistoryStore } from '../discovery/history.mjs';
import { createScanOrchestrator } from '../discovery/orchestrator.mjs';
import { createPreviewCache } from '../discovery/preview.mjs';
import { createDispositionStore } from './dispositions.mjs';
import { currentEnvironmentId, detectEnvironments } from './environments.mjs';
import { createChecklistStore } from './procedures.mjs';
import { createPreferencesStore } from './preferences.mjs';
import { BUILTIN_RECIPES, createRecipeStore } from './recipes.mjs';
import { createInventorySnapshotStore, createLastRefreshStore, createLocatorStore } from './service-store.mjs';

/** The current machine's environment rows, detected once per service
 *  instance from injected platform facts. `wslDistributions` is accepted for
 *  forward compatibility (this facade does not itself shell out to
 *  enumerate WSL distributions from Windows — see the swarm report). */
function detectCurrentEnvironments({
  platform, installationKey, osImpl = os, wslDistributions = [],
}) {
  return detectEnvironments({
    platform, release: osImpl.release?.() ?? null, arch: osImpl.arch?.() ?? null, wslDistributions,
  }, installationKey);
}

/**
 * @param {{ maintenance: any, collector: any, modelStore?: any, hookReadModel?: any,
 *   loadConfig: () => any, saveConfig: (cfg: any) => void, controlRoot: string,
 *   fsImpl?: typeof fs, now?: () => number, installationKey: string,
 *   platform?: string, env?: NodeJS.ProcessEnv, walk?: Function,
 *   fetchImpl?: typeof fetch, paths?: object, wslDistributions?: any[],
 *   osImpl?: typeof os, collectIntegrationFacts: Function,
 *   recipeRegistry?: { url: string, allowlist: string[], publisherId: string },
 *   providerOptions?: object }} options
 */
export function buildManagementContext({
  maintenance, collector, modelStore = null, hookReadModel = null, loadConfig, saveConfig, controlRoot,
  fsImpl = fs, now = Date.now, installationKey, platform = process.platform, env = process.env,
  walk = undefined, fetchImpl = undefined, paths = {}, wslDistributions = [], osImpl = os,
  collectIntegrationFacts, recipeRegistry = null, providerOptions = {},
}) {
  const managementRoot = path.join(controlRoot, 'management');
  const checkpointRoot = path.join(managementRoot, 'checkpoints');
  const transactionsRoot = path.join(controlRoot, 'transactions');
  const environments = detectCurrentEnvironments({
    platform, installationKey, osImpl, wslDistributions,
  });
  const environmentId = currentEnvironmentId(environments);

  const nowDate = () => new Date(now());
  const resolvedFetch = fetchImpl ?? globalThis.fetch;
  const ctx = {
    maintenance, collector, modelStore, hookReadModel, loadConfig, saveConfig, controlRoot, managementRoot,
    transactionsRoot, fsImpl, now, installationKey, platform, env, walk, fetchImpl: resolvedFetch, paths,
    environments, environmentId, collectIntegrationFacts, recipeRegistry, providerOptions,
    dispositionStore: createDispositionStore({ root: managementRoot, fsImpl, now: nowDate }),
    recipeStore: createRecipeStore({ root: managementRoot, fsImpl, now: nowDate }),
    preferencesStore: createPreferencesStore({ root: managementRoot, fsImpl }),
    checklistStore: createChecklistStore({ root: managementRoot, fsImpl, now: nowDate }),
    checkpointStore: createCheckpointStore(checkpointRoot, { fsImpl, now }),
    lastGoodDiscoveryStore: createLastGoodSnapshotStore(managementRoot, { fsImpl, now }),
    projectEvidenceStore: createProjectEvidenceStore(managementRoot, { fsImpl, now }),
    scanHistoryStore: createScanHistoryStore(managementRoot, { fsImpl, now }),
    previewCache: createPreviewCache({ now }),
    inventorySnapshotStore: createInventorySnapshotStore(managementRoot, { fsImpl }),
    lastRefreshStore: createLastRefreshStore(managementRoot, { fsImpl }),
    locatorStore: createLocatorStore(managementRoot, { fsImpl }),
    state: {
      refreshFlight: null,
      privateLocators: new Map(),
      orchestrator: null,
    },
  };
  ctx.listSources = () => {
    const configuration = readDiscoveryConfiguration({ loadConfig: ctx.loadConfig });
    return resolveAutomaticSourceRoots({
      configuration, paths: ctx.paths, platform: ctx.platform, fsImpl: ctx.fsImpl,
      installationKey: ctx.installationKey,
    }).map((source) => ({ ...source, environmentId: ctx.environmentId }));
  };
  ctx.discoveryDeps = (extra = {}) => ({
    loadConfig: ctx.loadConfig, saveConfig: ctx.saveConfig, installationKey: ctx.installationKey,
    fsImpl: ctx.fsImpl, platform: ctx.platform, ...extra,
  });
  ctx.buildOrchestrator = () => createScanOrchestrator({
    configuration: { listSources: ctx.listSources },
    checkpointStore: ctx.checkpointStore,
    historyStore: ctx.scanHistoryStore,
    lastGoodStore: ctx.lastGoodDiscoveryStore,
    projectStore: ctx.projectEvidenceStore,
    walk: ctx.walk,
    fsImpl: ctx.fsImpl,
    now: ctx.now,
    installationKey: ctx.installationKey,
    exclusions: readDiscoveryConfiguration({ loadConfig: ctx.loadConfig }).exclusions,
  });
  ctx.orchestrator = () => {
    if (!ctx.state.orchestrator) ctx.state.orchestrator = ctx.buildOrchestrator();
    return ctx.state.orchestrator;
  };
  ctx.rebuildOrchestrator = () => {
    ctx.state.orchestrator = ctx.buildOrchestrator();
    return ctx.state.orchestrator;
  };
  ctx.allRecipes = () => [...BUILTIN_RECIPES, ...ctx.recipeStore.listRecipes()];
  return ctx;
}

/** Resolve the model snapshot fed to `buildManagementInventory`: the
 *  caller-supplied store when given (tests, and the dashboard's already-open
 *  store), else a fresh read of the real model-inventory store. */
export function resolveModelSnapshot(ctx, latestSnapshotFn) {
  const store = ctx.modelStore ?? readModelStore({ fsImpl: ctx.fsImpl });
  return latestSnapshotFn(store);
}
