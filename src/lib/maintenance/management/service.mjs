// ADR-0048 Maintenance management facade (agent I). Composes P's projection,
// Q's query/guidance/activity/discovery-adjacent stores, D's discovery
// slice, and T's transaction engine into the ONE object the dashboard API
// and CLI code against (docs/MAINTENANCE.md "Compatibility surface": the facade is the seam that keeps those callers stable while
// the slices underneath evolve).
//
// Every method group lives in its own `service-*.mjs` helper module so each
// function here stays small; this file is purely composition.
import fs from 'node:fs';

import { collectIntegrationFacts } from '../../providers.mjs';
import { readOrCreateModelScopeKey } from '../../model-inventory/store.mjs';
import {
  claudeDir, claudeUserMcpPath, codexConfigPath, codexDir, hermesDir, maintenanceControlDir, opencodeConfigPath, opencodeDir,
} from '../../paths.mjs';
import { loadKitConfig, saveKitConfig } from '../../config.mjs';
import { walkTree } from '../../footprint/walk.mjs';
import { createSystemCollector } from '../../footprint/index.mjs';
import { createMaintenanceService } from '../service.mjs';
import { deepFreeze } from './model.mjs';
import { buildManagementContext } from './service-context.mjs';
import {
  guidance, inventoryQuery, placement, refreshInventory, report, revealLocator,
} from './service-inventory.mjs';
import {
  addExclusion, awaitScans, discovery, pauseScan, previewSourceMethod, rebuildAfterMeasurement, removeExclusion,
  removeSource, resumeScan, saveSource, scanProgress, setAutomaticSource, startScan, stopScan,
} from './service-discovery.mjs';
import {
  activity, auditInterruption, dispositions, exportReceiptMethod, receipt, recordDisposition, reconcile,
} from './service-activity.mjs';
import {
  acceptRecipe, apply, checklist, planAction, prepareUndo, preferences, procedure, recipes, refreshRecipes,
  savePreferences, setPreferredShell, undo, withdrawRecipe,
} from './service-actions.mjs';

const DEFAULT_PATHS = Object.freeze({
  claudeDir, codexDir, opencodeDir, hermesDir, claudeUserMcpPath, codexConfigPath, opencodeConfigPath,
});

/** Owner-only methods that legitimately carry a real filesystem path or
 * configured root — the ONE documented exception to "every public return
 * value is deep-frozen and path-free" (ADR-0048 §6). */
const PATH_CARRYING_METHODS = new Set(['revealLocator', 'discovery']);

function freezeUnlessPathCarrying(name, fn) {
  if (PATH_CARRYING_METHODS.has(name)) return fn;
  return (...args) => {
    const result = fn(...args);
    if (result && typeof result.then === 'function') return result.then((value) => deepFreeze(value));
    return deepFreeze(result);
  };
}

/**
 * @param {{ maintenance?: any, collector?: any, modelStore?: any, hookReadModel?: any,
 *   loadConfig?: () => any, saveConfig?: (cfg: any) => void, controlRoot?: string,
 *   fsImpl?: typeof fs, now?: () => number, installationKey?: string,
 *   platform?: string, env?: NodeJS.ProcessEnv, walk?: Function, fetchImpl?: typeof fetch,
 *   paths?: object, wslDistributions?: any[],
 *   recipeRegistry?: { url: string, allowlist: string[], publisherId: string },
 *   providerOptions?: object, collectIntegrationFacts?: Function }} [options]
 */
export function createManagementService({
  maintenance = null, collector = null, modelStore = null, hookReadModel = null,
  loadConfig = loadKitConfig, saveConfig = saveKitConfig, controlRoot = maintenanceControlDir(),
  fsImpl = fs, now = Date.now, installationKey = undefined, platform = process.platform,
  env = process.env, walk = walkTree, fetchImpl = undefined, paths = DEFAULT_PATHS,
  wslDistributions = [], recipeRegistry = null, providerOptions = {},
  collectIntegrationFacts: collectIntegrationFactsOption = collectIntegrationFacts,
} = {}) {
  const resolvedCollector = collector ?? createSystemCollector();
  const resolvedMaintenance = maintenance ?? createMaintenanceService({
    collector: resolvedCollector, controlRoot, fsImpl, now, providerOptions,
  });
  const resolvedInstallationKey = installationKey ?? readOrCreateModelScopeKey({ fsImpl });

  const ctx = buildManagementContext({
    maintenance: resolvedMaintenance,
    collector: resolvedCollector,
    modelStore,
    hookReadModel,
    loadConfig,
    saveConfig,
    controlRoot,
    fsImpl,
    now,
    installationKey: resolvedInstallationKey,
    platform,
    env,
    walk,
    fetchImpl,
    paths,
    wslDistributions,
    recipeRegistry,
    providerOptions,
    collectIntegrationFacts: collectIntegrationFactsOption,
  });

  const refresh = refreshInventory(ctx);
  const methods = {
    refreshInventory: refresh,
    rebuildAfterMeasurement: rebuildAfterMeasurement(ctx, { refreshInventory: refresh }),
    report: report(ctx),
    inventory: inventoryQuery(ctx),
    placement: placement(ctx),
    revealLocator: revealLocator(ctx),
    guidance: guidance(ctx),
    discovery: discovery(ctx),
    previewSource: previewSourceMethod(ctx),
    saveSource: saveSource(ctx),
    removeSource: removeSource(ctx),
    setAutomaticSource: setAutomaticSource(ctx),
    addExclusion: addExclusion(ctx),
    removeExclusion: removeExclusion(ctx),
    startScan: startScan(ctx),
    pauseScan: pauseScan(ctx),
    resumeScan: resumeScan(ctx),
    stopScan: stopScan(ctx),
    scanProgress: scanProgress(ctx),
    awaitScans: awaitScans(ctx),
    activity: activity(ctx),
    receipt: receipt(ctx),
    exportReceipt: exportReceiptMethod(ctx),
    auditInterruption: auditInterruption(ctx),
    reconcile: reconcile(ctx),
    recordDisposition: recordDisposition(ctx),
    dispositions: dispositions(ctx),
    planAction: planAction(ctx),
    apply: apply(ctx),
    prepareUndo: prepareUndo(ctx),
    undo: undo(ctx),
    recipes: recipes(ctx),
    refreshRecipes: refreshRecipes(ctx),
    acceptRecipe: acceptRecipe(ctx),
    withdrawRecipe: withdrawRecipe(ctx),
    procedure: procedure(ctx),
    setPreferredShell: setPreferredShell(ctx),
    checklist: checklist(ctx),
    preferences: preferences(ctx),
    savePreferences: savePreferences(ctx),
  };

  return Object.freeze(Object.fromEntries(
    Object.entries(methods).map(([name, fn]) => [name, freezeUnlessPathCarrying(name, fn)]),
  ));
}
