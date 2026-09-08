// ADR-0048 facade action/procedure/preference methods: resolving a placement
// to its exact finding before delegating to the transaction engine (T),
// rendering a grounded procedure/recipe, and the small owner-private
// preference and checklist stores.
import { resolvePlacementFinding } from './correlation.mjs';
import { loadLastGoodInventory } from './service-inventory.mjs';
import { findCompatibleRecipes } from './recipes.mjs';
import { renderProcedure } from './procedures.mjs';
import { resolveViewState } from './preferences.mjs';
import { decodeQueryState } from './query.mjs';

function findGuidanceEntry(inventory, guidanceId) {
  const entry = (inventory?.guidanceEntries ?? []).find((candidate) => candidate.guidanceId === guidanceId);
  if (!entry) throw new TypeError(`unknown guidanceId: ${guidanceId}`);
  return entry;
}

/** `planAction({ placementId, guidanceId? })` — resolves the placement to
 * the ONE maintenance finding it corresponds to (`correlation.mjs`) and
 * delegates to `maintenance.planAction`, which itself refuses anything but
 * exactly one finding (`ONE_ACTION_PER_PLAN`). When `guidanceId` names an
 * admitted apply-lane entry, its own `findingResourceKey` (Q's guidance
 * matcher hint) narrows and disambiguates the correlation.
 *
 * Deliberately runs a LIVE `maintenance.scan()` rather than reading
 * `maintenance.report()`'s last SAVED scan: `report()` reflects only what a
 * previous `scan()` persisted (MNT-PERF-001's read-only surface never runs
 * one), so on a fresh installation it would carry no findings at all and
 * every plan would refuse. Planning an action, unlike reading, already needs
 * current evidence — this matches how `maintenance.plan()`/`.apply()`
 * themselves always collect live rather than trusting a stale saved scan. */
export function planAction(ctx) {
  return async function planActionCall({ placementId, guidanceId = null }) {
    const inventory = loadLastGoodInventory(ctx);
    if (!inventory) throw new Error('no management inventory has been built yet; call refreshInventory first');
    const guidanceEntry = guidanceId
      ? (inventory.guidanceEntries ?? []).find((entry) => entry.guidanceId === guidanceId) : null;
    const scanResult = await ctx.maintenance.scan({ deep: false });
    const { findingId } = resolvePlacementFinding({
      inventory, findings: scanResult.findings ?? [], placementId,
      findingResourceKey: guidanceEntry?.findingResourceKey ?? null,
    });
    return ctx.maintenance.planAction({ placementId, findingId, guidanceId });
  };
}

export function apply(ctx) {
  return function applyCall(input) { return ctx.maintenance.apply(input); };
}

export function prepareUndo(ctx) {
  return function prepareUndoCall(input) { return ctx.maintenance.prepareUndo(input); };
}

export function undo(ctx) {
  return function undoCall(input) { return ctx.maintenance.undo(input); };
}

/** `refreshRecipes({ confirmed })` — fetches candidate recipe updates from
 * the configured, allowlisted registry and stages them as
 * `pending-acceptance` (never activates anything). Requires a
 * `recipeRegistry` to have been configured at service construction; the
 * built-in catalogue needs no refresh. */
export function refreshRecipes(ctx) {
  return async function refreshRecipesCall({ confirmed = false } = {}) {
    if (confirmed !== true) throw new Error('Explicit confirmation is required to refresh the recipe catalogue.');
    if (!ctx.recipeRegistry) throw new Error('no recipe registry is configured for this installation.');
    return ctx.recipeStore.refreshRecipes({
      fetchImpl: ctx.fetchImpl, registry: ctx.recipeRegistry, current: ctx.recipeStore.listRecipes(),
    });
  };
}

export function acceptRecipe(ctx) {
  return function acceptRecipeCall({ recipeId, recipeVersion, confirmed = false }) {
    if (confirmed !== true) throw new Error('Explicit confirmation is required to accept a recipe.');
    return ctx.recipeStore.acceptRecipe({ recipeId, recipeVersion });
  };
}

/** The recipe version to withdraw when the caller (a browser body carries
 * only `{recipeId, confirm:true}`, per ADR-0048 §11) does not name one:
 * the active version if one is active, else the most recently staged
 * pending-acceptance version. Refuses, rather than guesses, when neither
 * exists — `withdrawRecipe` on the store then reports its own clear error. */
function defaultRecipeVersion(ctx, recipeId) {
  const candidates = ctx.recipeStore.listRecipes().filter((recipe) => recipe.recipeId === recipeId);
  const active = candidates.find((recipe) => recipe.state === 'active');
  if (active) return active.recipeVersion;
  const pending = candidates.filter((recipe) => recipe.state === 'pending-acceptance');
  return pending.at(-1)?.recipeVersion ?? null;
}

export function withdrawRecipe(ctx) {
  return function withdrawRecipeCall({ recipeId, recipeVersion = null, confirmed = false }) {
    if (confirmed !== true) throw new Error('Explicit confirmation is required to withdraw a recipe.');
    const version = recipeVersion ?? defaultRecipeVersion(ctx, recipeId);
    return ctx.recipeStore.withdrawRecipe({ recipeId, recipeVersion: version });
  };
}

/** `recipes()` — the read-only recipe catalogue (built-ins plus anything
 * accepted/staged/withdrawn from a registry refresh), for a `recipes list`
 * view. `pending` is the subset awaiting acceptance. */
export function recipes(ctx) {
  return function recipesCall() {
    const all = ctx.allRecipes();
    return {
      recipes: all,
      pending: all.filter((recipe) => recipe.state === 'pending-acceptance'),
    };
  };
}

/** `procedure({ guidanceId, shell? })` — renders the nine-part procedure
 * panel for a `steps`-lane guidance entry's grounded recipe. */
export function procedure(ctx) {
  return function procedureCall({ guidanceId, shell = undefined }) {
    const inventory = loadLastGoodInventory(ctx);
    if (!inventory) throw new Error('no management inventory has been built yet; call refreshInventory first');
    const entry = findGuidanceEntry(inventory, guidanceId);
    if (!entry.procedureId) throw new TypeError(`guidance entry is not grounded in a procedure: ${guidanceId}`);
    const recipe = ctx.allRecipes().find((candidate) => candidate.recipeId === entry.procedureId);
    if (!recipe) throw new TypeError(`no active recipe found for procedure: ${entry.procedureId}`);
    const environment = inventory.environments.find((candidate) => candidate.environmentId === ctx.environmentId);
    const placement = inventory.placements.find((candidate) => candidate.placementId === entry.placementId);
    const dependency = inventory.dependencyEdges?.find((edge) => edge.fromPlacementId === entry.placementId && edge.satisfied === false);
    const compatible = placement?.conditions.some((condition) => findCompatibleRecipes([recipe], {
      placement, environment, condition, dependencyRequirement: dependency?.requirement ?? null,
    }).length > 0);
    if (!compatible) throw new TypeError('procedure is no longer compatible; refresh inventory');
    const preferredShell = ctx.preferencesStore.getPreferences()
      .preferredShellByEnvironment?.[ctx.environmentId];
    return renderProcedure(recipe, { shell, environment, preferredShell });
  };
}

export function setPreferredShell(ctx) {
  return function setPreferredShellCall({ environmentId = ctx.environmentId, shell }) {
    return ctx.preferencesStore.setPreferredShell(environmentId, shell);
  };
}

export function checklist(ctx) {
  return function checklistCall({ guidanceId, stepId, done }) {
    return ctx.checklistStore.setStepDone(guidanceId, stepId, done);
  };
}

/** `preferences()` — resolves the remembered last-view state (Q's
 * `resolveViewState`, with no URL override at this layer — the dashboard API
 * decodes the URL's own query state and passes it through separately). */
export function preferences(ctx) {
  return function preferencesCall({ url = null } = {}) {
    const stored = ctx.preferencesStore.getPreferences();
    const decodedUrl = typeof url === 'string' ? decodeQueryState(url) : url;
    return { ...stored, lastView: resolveViewState({ url: decodedUrl, remembered: stored.lastView }) };
  };
}

export function savePreferences(ctx) {
  return function savePreferencesCall(partial) {
    return ctx.preferencesStore.savePreferences(partial);
  };
}
